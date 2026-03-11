/**
 * Kit-native pre-sign simulation with drain detection.
 *
 * Fail-closed: simulation failure blocks signing.
 */

import type {
  Rpc,
  SolanaRpcApi,
  Base64EncodedWireTransaction,
} from "@solana/kit";

// ─── Risk Flags ──────────────────────────────────────────────────────────────

export const RISK_FLAG_LARGE_OUTFLOW = "LARGE_OUTFLOW";
export const RISK_FLAG_UNKNOWN_RECIPIENT = "UNKNOWN_RECIPIENT";
export const RISK_FLAG_FULL_DRAIN = "FULL_DRAIN";
export const RISK_FLAG_MULTI_OUTPUT = "MULTI_OUTPUT";
export const RISK_FLAG_SIZE_OVERFLOW = "SIZE_OVERFLOW";

export type RiskFlag =
  | typeof RISK_FLAG_LARGE_OUTFLOW
  | typeof RISK_FLAG_UNKNOWN_RECIPIENT
  | typeof RISK_FLAG_FULL_DRAIN
  | typeof RISK_FLAG_MULTI_OUTPUT
  | typeof RISK_FLAG_SIZE_OVERFLOW;

/** Maps risk flags to agent error codes 7001-7005 */
export const RISK_FLAG_ERROR_MAP: Record<RiskFlag, number> = {
  [RISK_FLAG_LARGE_OUTFLOW]: 7001,
  [RISK_FLAG_UNKNOWN_RECIPIENT]: 7002,
  [RISK_FLAG_FULL_DRAIN]: 7003,
  [RISK_FLAG_MULTI_OUTPUT]: 7004,
  [RISK_FLAG_SIZE_OVERFLOW]: 7005,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SimulationOptions {
  /** Timeout in milliseconds. Default: 3000 */
  timeoutMs?: number;
  /** Whether to replace recent blockhash. Default: true */
  replaceRecentBlockhash?: boolean;
}

export interface BalanceDelta {
  account: string;
  preBalance: bigint;
  postBalance: bigint;
  delta: bigint;
}

export interface SimulationResult {
  success: boolean;
  unitsConsumed?: number;
  logs?: string[];
  error?: SimulationError;
  balanceDeltas?: BalanceDelta[];
  riskFlags: RiskFlag[];
}

export interface SimulationError {
  message: string;
  anchorCode?: number;
  anchorName?: string;
  suggestion?: string;
  logs?: string[];
}

// ─── Anchor Error Map ────────────────────────────────────────────────────────

const ANCHOR_ERROR_MAP: Record<number, { name: string; suggestion: string }> = {
  6000: { name: "VaultNotActive", suggestion: "Check vault status." },
  6001: { name: "UnauthorizedAgent", suggestion: "Signer is not a registered agent." },
  6002: { name: "UnauthorizedOwner", suggestion: "Only the vault owner can call this." },
  6003: { name: "TokenNotRegistered", suggestion: "Use USDC or USDT." },
  6004: { name: "ProtocolNotAllowed", suggestion: "Protocol not in vault's allowlist." },
  6005: { name: "TransactionTooLarge", suggestion: "Break into smaller parts." },
  6006: { name: "DailyCapExceeded", suggestion: "Rolling 24h cap exceeded." },
  6007: { name: "LeverageTooHigh", suggestion: "Reduce leverage." },
  6008: { name: "TooManyPositions", suggestion: "Close an existing position." },
  6010: { name: "SessionNotAuthorized", suggestion: "Call validate_and_authorize first." },
  6011: { name: "InvalidSession", suggestion: "Session does not belong to this vault." },
  6024: { name: "Overflow", suggestion: "Amount too large." },
  6034: { name: "CpiCallNotAllowed", suggestion: "Must be top-level instruction." },
  6035: { name: "MissingFinalizeInstruction", suggestion: "Include finalize_session." },
  6046: { name: "MaxAgentsReached", suggestion: "Remove an agent first." },
  6047: { name: "InsufficientPermissions", suggestion: "Update agent permissions." },
  6056: { name: "ConstraintViolated", suggestion: "Instruction violates a constraint." },
  6063: { name: "AgentSpendLimitExceeded", suggestion: "Agent spend limit exceeded." },
};

// ─── Core Simulation ─────────────────────────────────────────────────────────

/**
 * Simulate a transaction before sending. Fail-closed: returns error result
 * on any failure (network, timeout, simulation error).
 *
 * @param rpc - Kit RPC client
 * @param encodedTransaction - Base64-encoded wire transaction
 * @param options - Simulation options
 */
export async function simulateBeforeSend(
  rpc: Rpc<SolanaRpcApi>,
  encodedTransaction: Base64EncodedWireTransaction,
  options?: SimulationOptions,
): Promise<SimulationResult> {
  const timeoutMs = options?.timeoutMs ?? 3_000;
  const replaceRecentBlockhash = options?.replaceRecentBlockhash ?? true;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const config: Record<string, unknown> = {
        encoding: "base64" as const,
        replaceRecentBlockhash,
        sigVerify: false,
        commitment: "confirmed" as const,
      };

      const result = await rpc
        .simulateTransaction(encodedTransaction, config as any)
        .send({ abortSignal: controller.signal });

      clearTimeout(timeout);

      const value = result.value as any;
      const err = value?.err;
      const logs: string[] = value?.logs ?? [];
      const unitsConsumed = value?.unitsConsumed
        ? Number(value.unitsConsumed)
        : undefined;

      if (!err) {
        return {
          success: true,
          unitsConsumed,
          logs,
          riskFlags: [],
        };
      }

      // Parse Anchor error
      const anchorError = parseAnchorError(logs);
      const mapEntry = anchorError
        ? ANCHOR_ERROR_MAP[anchorError.code]
        : undefined;

      return {
        success: false,
        unitsConsumed,
        logs,
        error: {
          message: typeof err === "string" ? err : JSON.stringify(err),
          anchorCode: anchorError?.code,
          anchorName: anchorError?.name ?? mapEntry?.name,
          suggestion: mapEntry?.suggestion,
          logs,
        },
        riskFlags: [],
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    // Fail-closed: any error blocks signing
    return {
      success: false,
      error: {
        message:
          e instanceof Error ? e.message : "Simulation failed unexpectedly",
      },
      riskFlags: [],
    };
  }
}

// ─── Drain Detection ─────────────────────────────────────────────────────────

export interface DrainDetectionInput {
  balanceDeltas: BalanceDelta[];
  vaultAddress: string;
  totalVaultBalance: bigint;
  knownRecipients?: Set<string>;
}

/**
 * Detect potential drain attempts from balance deltas.
 * Returns an array of risk flags.
 */
export function detectDrainAttempt(input: DrainDetectionInput): RiskFlag[] {
  const flags: RiskFlag[] = [];

  const vaultDelta = input.balanceDeltas.find(
    (d) => d.account === input.vaultAddress,
  );

  if (vaultDelta && vaultDelta.delta < 0n) {
    const outflow = -vaultDelta.delta;

    // LARGE_OUTFLOW: >50% of vault balance leaving
    if (
      input.totalVaultBalance > 0n &&
      outflow * 2n > input.totalVaultBalance
    ) {
      flags.push(RISK_FLAG_LARGE_OUTFLOW);
    }

    // FULL_DRAIN: >95% of vault balance leaving
    if (
      input.totalVaultBalance > 0n &&
      outflow * 100n > input.totalVaultBalance * 95n
    ) {
      flags.push(RISK_FLAG_FULL_DRAIN);
    }
  }

  // UNKNOWN_RECIPIENT: tokens going to address not in known set
  if (input.knownRecipients) {
    const recipients = input.balanceDeltas.filter(
      (d) => d.delta > 0n && d.account !== input.vaultAddress,
    );
    for (const r of recipients) {
      if (!input.knownRecipients.has(r.account)) {
        flags.push(RISK_FLAG_UNKNOWN_RECIPIENT);
        break; // One flag is enough
      }
    }
  }

  // MULTI_OUTPUT: tokens going to 3+ different accounts
  const positiveDeltas = input.balanceDeltas.filter(
    (d) => d.delta > 0n && d.account !== input.vaultAddress,
  );
  if (positiveDeltas.length >= 3) {
    flags.push(RISK_FLAG_MULTI_OUTPUT);
  }

  return flags;
}

/**
 * Estimate adjusted CU with headroom.
 * If simulation consumed CU differs from estimate by >20%, return adjusted value.
 */
export function adjustCU(
  estimated: number,
  simulated: number | undefined,
): number {
  if (simulated === undefined) return estimated;

  const headroom = Math.ceil(simulated * 1.1); // 10% headroom
  const diff = Math.abs(headroom - estimated) / estimated;

  // Only adjust if >20% off
  if (diff > 0.2) {
    return headroom;
  }

  return estimated;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseAnchorError(
  logs: string[],
): { code: number; name: string } | null {
  for (const log of logs) {
    const named = log.match(/Error Code: (\w+)\.\s*Error Number: (\d+)/);
    if (named) {
      return { code: parseInt(named[2], 10), name: named[1] };
    }

    const hex = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hex) {
      const code = parseInt(hex[1], 16);
      const entry = ANCHOR_ERROR_MAP[code];
      return { code, name: entry?.name ?? `UnknownError(${code})` };
    }
  }
  return null;
}
