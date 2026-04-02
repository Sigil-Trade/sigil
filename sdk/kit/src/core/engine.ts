import { PolicyViolation, ShieldDeniedError } from "./errors.js";
import { ResolvedPolicies, TransactionAnalysis } from "./policies.js";
import { isSystemProgram, isKnownProtocol, getTokenInfo } from "./registry.js";
import { ShieldState } from "./state.js";

/** Base58 encoding of a 32-byte zero key (PublicKey.default) */
const DEFAULT_ADDRESS = "11111111111111111111111111111111";

/**
 * Evaluate a transaction against resolved policies and current state.
 * Returns an array of violations (empty = transaction allowed).
 */
export function evaluatePolicy(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  state: ShieldState,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  // 1. Check protocol allowlist / unknown program blocking
  checkPrograms(analysis, policies, violations);

  // 2. Check token allowlist
  checkTokens(analysis, policies, violations);

  // 3. Check spending caps
  checkSpendingCaps(analysis, policies, state, violations);

  // 4. Check per-transaction size limit
  checkTransactionSize(analysis, policies, violations);

  // 5. Check rate limit
  checkRateLimit(policies, state, violations);

  return violations;
}

/**
 * Evaluate policies and throw ShieldDeniedError if any violations found.
 */
export function enforcePolicy(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  state: ShieldState,
): void {
  const violations = evaluatePolicy(analysis, policies, state);
  if (violations.length > 0) {
    throw new ShieldDeniedError(violations);
  }
}

/**
 * After a transaction is signed, record the spend and transaction in state.
 */
export function recordTransaction(
  analysis: TransactionAnalysis,
  state: ShieldState,
): void {
  // Record each outgoing transfer
  for (const transfer of analysis.transfers) {
    if (transfer.direction === "outgoing") {
      const mintKey =
        transfer.mint === DEFAULT_ADDRESS || transfer.mint === ""
          ? "unknown"
          : transfer.mint;
      state.recordSpend(mintKey, transfer.amount);
    }
  }

  // Record the transaction for rate limiting
  state.recordTransaction();
}

// --- Internal check functions ---

function checkPrograms(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  violations: PolicyViolation[],
): void {
  for (const programId of analysis.programIds) {
    // System programs are always allowed
    if (isSystemProgram(programId)) continue;

    // If explicit allowlist is set, only those protocols are allowed
    if (policies.allowedProtocols) {
      if (!policies.allowedProtocols.has(programId)) {
        violations.push({
          rule: "protocol_not_allowed",
          message: `Protocol ${programId} is not in the allowlist`,
          suggestion:
            "Add this protocol to allowedProtocols in your shield config.",
          details: { programId },
        });
      }
      continue;
    }

    // If blockUnknownPrograms is set, block unregistered protocols
    if (policies.blockUnknownPrograms && !isKnownProtocol(programId)) {
      violations.push({
        rule: "unknown_program",
        message: `Unknown program ${programId} — not in the known protocol registry`,
        suggestion:
          "Add this program ID to allowedProtocols or set blockUnknownPrograms: false.",
        details: { programId },
      });
    }
  }
}

function checkTokens(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  violations: PolicyViolation[],
): void {
  if (!policies.allowedTokens) return;

  for (const transfer of analysis.transfers) {
    if (transfer.direction !== "outgoing") continue;
    if (transfer.mint === DEFAULT_ADDRESS || transfer.mint === "") continue;

    if (!policies.allowedTokens.has(transfer.mint)) {
      const tokenInfo = getTokenInfo(transfer.mint);
      violations.push({
        rule: "token_not_allowed",
        message: `Token ${tokenInfo?.symbol ?? transfer.mint} is not in the allowed token list`,
        suggestion:
          "Add this token mint to allowedTokens in your shield config.",
        details: { tokenMint: transfer.mint },
      });
    }
  }
}

function checkSpendingCaps(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  state: ShieldState,
  violations: PolicyViolation[],
): void {
  for (const limit of policies.spendLimits) {
    const mintKey = limit.mint;
    const windowMs = limit.windowMs ?? 86_400_000;

    // Sum outgoing transfers for this token in this transaction
    let txSpend = BigInt(0);
    for (const transfer of analysis.transfers) {
      if (transfer.direction !== "outgoing") continue;
      const transferMint =
        transfer.mint === DEFAULT_ADDRESS || transfer.mint === ""
          ? "unknown"
          : transfer.mint;
      if (transferMint === mintKey) {
        txSpend += transfer.amount;
      }
    }

    if (txSpend === BigInt(0)) continue;

    // Check against rolling window
    const currentSpend = state.getSpendInWindow(mintKey, windowMs);
    const totalAfterTx = currentSpend + txSpend;

    if (totalAfterTx > limit.amount) {
      const tokenInfo = getTokenInfo(mintKey);
      const symbol = tokenInfo?.symbol ?? "tokens";
      const decimals = tokenInfo?.decimals ?? 0;
      const remaining =
        limit.amount > currentSpend ? limit.amount - currentSpend : BigInt(0);

      violations.push({
        rule: "spending_cap",
        message: `Spending cap exceeded for ${symbol}: attempting ${formatAmount(txSpend, decimals)}, limit ${formatAmount(limit.amount, decimals)}, already spent ${formatAmount(currentSpend, decimals)}`,
        suggestion: `Reduce the transaction amount to ${formatAmount(remaining, decimals)} ${symbol} or wait for the spending window to roll over.`,
        details: {
          limit: limit.amount,
          attempted: txSpend,
          remaining,
          tokenMint: mintKey,
        },
      });
    }
  }
}

function checkTransactionSize(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  violations: PolicyViolation[],
): void {
  if (!policies.maxTransactionSize) return;

  if (analysis.estimatedValueLamports > policies.maxTransactionSize) {
    violations.push({
      rule: "transaction_size",
      message: `Transaction value ${analysis.estimatedValueLamports} exceeds max transaction size ${policies.maxTransactionSize}`,
      suggestion:
        "Split this into smaller transactions or increase maxTransactionSize.",
      details: {
        limit: policies.maxTransactionSize,
        attempted: analysis.estimatedValueLamports,
      },
    });
  }
}

function checkRateLimit(
  policies: ResolvedPolicies,
  state: ShieldState,
  violations: PolicyViolation[],
): void {
  const { maxTransactions, windowMs } = policies.rateLimit;
  const count = state.getTransactionCountInWindow(windowMs);

  if (count >= maxTransactions) {
    const windowDesc =
      windowMs >= 3_600_000
        ? `${windowMs / 3_600_000}h`
        : `${windowMs / 60_000}min`;
    violations.push({
      rule: "rate_limit",
      message: `Rate limit exceeded: ${count}/${maxTransactions} transactions in the last ${windowDesc}`,
      suggestion: `Wait for the rate limit window to reset or increase rateLimit.maxTransactions.`,
    });
  }
}

/** Format a token amount with decimals for display */
function formatAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();

  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;

  if (frac === BigInt(0)) return whole.toString();

  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
