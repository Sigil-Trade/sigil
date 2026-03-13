/**
 * Intent-Drift Detection — Kit-native
 *
 * Detects when a composed transaction diverges from its declared intent.
 * Five drift check types: program mismatch, amount mismatch, recipient
 * mismatch, instruction count, and phantom (undeclared) transfers.
 *
 * Severity levels:
 *   high → HARD throw (ShieldDeniedError with code 7021)
 *   medium/low → SOFT warning (console.warn)
 */

import type { Address } from "@solana/kit";
import type { InspectableInstruction } from "./inspector.js";
import type { IntentAction } from "./intents.js";
import { ACTION_TYPE_MAP } from "./intents.js";
import { ShieldDeniedError } from "./shield.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type DriftViolationType =
  | "program_mismatch"
  | "amount_mismatch"
  | "recipient_mismatch"
  | "instruction_count"
  | "phantom_transfer";

export interface DriftViolation {
  type: DriftViolationType;
  message: string;
  expected?: string;
  actual?: string;
}

export interface DriftCheckResult {
  drifted: boolean;
  violations: DriftViolation[];
  severity: "none" | "low" | "medium" | "high";
}

export interface DriftConfig {
  /** Tolerance for amount mismatch as percentage (default: 5) */
  amountTolerancePct?: number;
  /** Max extra instructions beyond expected (default: 3) */
  maxExtraInstructions?: number;
}

// ─── Known System Programs ──────────────────────────────────────────────────

const SYSTEM_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/** SPL Transfer discriminators */
const SPL_TRANSFER = 3;
const SPL_TRANSFER_CHECKED = 12;

// ─── Core Detection ─────────────────────────────────────────────────────────

/**
 * Detect intent drift by comparing declared intent to actual instructions.
 *
 * @param intent - The declared intent action
 * @param instructions - The actual instructions in the transaction
 * @param signerAddress - The agent/vault signer address
 * @param config - Optional drift detection configuration
 */
export function detectIntentDrift(
  intent: IntentAction,
  instructions: InspectableInstruction[],
  signerAddress: Address,
  config?: DriftConfig,
): DriftCheckResult {
  const violations: DriftViolation[] = [];
  const tolerancePct = config?.amountTolerancePct ?? 5;
  const maxExtraIx = config?.maxExtraInstructions ?? 3;

  // 1. Program mismatch — check for unexpected programs
  checkProgramMismatch(intent, instructions, violations);

  // 2. Instruction count — suspiciously many instructions
  checkInstructionCount(intent, instructions, maxExtraIx, violations);

  // 3. Phantom transfer — extra SPL transfers not in declared intent
  checkPhantomTransfers(instructions, signerAddress, violations);

  // 4. Amount mismatch — if intent has an amount, check it's close
  checkAmountMismatch(intent, instructions, tolerancePct, violations);

  // 5. Recipient mismatch — transfer goes to unexpected destination
  checkRecipientMismatch(intent, instructions, violations);

  // Determine severity
  const severity = computeSeverity(violations);

  return {
    drifted: violations.length > 0,
    violations,
    severity,
  };
}

/**
 * Enforce intent-drift detection. Throws on high severity.
 */
export function enforceIntentDrift(
  intent: IntentAction,
  instructions: InspectableInstruction[],
  signerAddress: Address,
  config?: DriftConfig,
): DriftCheckResult {
  const result = detectIntentDrift(intent, instructions, signerAddress, config);

  if (result.severity === "high") {
    throw new ShieldDeniedError(
      result.violations.map((v) => ({
        rule: `intent_drift:${v.type}`,
        message: v.message,
      })),
    );
  }

  if (result.severity === "medium" || result.severity === "low") {
    for (const v of result.violations) {
      console.warn(`[IntentDrift] ${v.type}: ${v.message}`);
    }
  }

  return result;
}

// ─── Individual Checks ──────────────────────────────────────────────────────

function checkProgramMismatch(
  intent: IntentAction,
  instructions: InspectableInstruction[],
  violations: DriftViolation[],
): void {
  const mapping = ACTION_TYPE_MAP[intent.type];
  if (!mapping) return;

  // Get expected program IDs based on intent type
  const expectedPrograms = getExpectedPrograms(intent);
  if (expectedPrograms.size === 0) return;

  for (const ix of instructions) {
    const prog = ix.programAddress;
    if (
      !SYSTEM_PROGRAMS.has(prog) &&
      !TOKEN_PROGRAMS.has(prog) &&
      !expectedPrograms.has(prog)
    ) {
      violations.push({
        type: "program_mismatch",
        message: `Unexpected program ${prog} in transaction — not in expected set for ${intent.type}`,
        actual: prog,
      });
    }
  }
}

function checkInstructionCount(
  _intent: IntentAction,
  instructions: InspectableInstruction[],
  maxExtraIx: number,
  violations: DriftViolation[],
): void {
  // A normal composed TX: compute budget + validate + N DeFi + finalize = ~4-8
  // Adding swap or complex operations might push to ~12
  // Beyond that + tolerance is suspicious
  const baseExpected = 6;
  const threshold = baseExpected + maxExtraIx;

  if (instructions.length > threshold) {
    violations.push({
      type: "instruction_count",
      message: `Transaction has ${instructions.length} instructions — expected at most ${threshold}`,
      expected: String(threshold),
      actual: String(instructions.length),
    });
  }
}

function checkPhantomTransfers(
  instructions: InspectableInstruction[],
  signerAddress: Address,
  violations: DriftViolation[],
): void {
  let transferCount = 0;

  for (const ix of instructions) {
    if (!TOKEN_PROGRAMS.has(ix.programAddress)) continue;
    if (!ix.data || ix.data.length < 1) continue;

    const disc = ix.data[0];
    if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED) continue;

    // Check if signer is the authority (account index 2 for Transfer, 3 for TransferChecked)
    const authorityIdx = disc === SPL_TRANSFER ? 2 : 3;
    if (ix.accounts && ix.accounts.length > authorityIdx) {
      if (ix.accounts[authorityIdx].address === signerAddress) {
        transferCount++;
      }
    }
  }

  // More than 1 outgoing transfer from signer is suspicious
  // (normal: 0 for non-transfer, 1 for transfer/swap)
  if (transferCount > 1) {
    violations.push({
      type: "phantom_transfer",
      message: `${transferCount} outgoing SPL transfers detected — expected at most 1 for standard operations`,
      expected: "1",
      actual: String(transferCount),
    });
  }
}

function checkAmountMismatch(
  intent: IntentAction,
  instructions: InspectableInstruction[],
  tolerancePct: number,
  violations: DriftViolation[],
): void {
  const params = intent.params as Record<string, unknown>;
  const declaredAmount =
    (params.amount as string) ??
    (params.collateralAmount as string) ??
    (params.sizeDelta as string);

  if (!declaredAmount) return;

  let declared: bigint;
  try {
    declared = BigInt(declaredAmount);
  } catch {
    return;
  }

  if (declared === 0n) return;

  // Find SPL transfer amounts in instructions
  for (const ix of instructions) {
    if (!TOKEN_PROGRAMS.has(ix.programAddress)) continue;
    if (!ix.data || ix.data.length < 9) continue;

    const disc = ix.data[0];
    if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED) continue;

    // Read amount from data[1..9] as u64 LE
    let ixAmount = 0n;
    for (let i = 8; i >= 1; i--) {
      ixAmount = (ixAmount << 8n) | BigInt(ix.data[i]);
    }

    if (ixAmount === 0n) continue;

    // Check if amount deviates beyond tolerance
    const diff = ixAmount > declared
      ? ixAmount - declared
      : declared - ixAmount;
    const toleranceAmount = (declared * BigInt(tolerancePct)) / 100n;

    if (diff > toleranceAmount) {
      violations.push({
        type: "amount_mismatch",
        message: `Transfer amount ${ixAmount} differs from declared ${declared} by > ${tolerancePct}%`,
        expected: String(declared),
        actual: String(ixAmount),
      });
    }
  }
}

function checkRecipientMismatch(
  intent: IntentAction,
  instructions: InspectableInstruction[],
  violations: DriftViolation[],
): void {
  const params = intent.params as Record<string, unknown>;
  const declaredDest = params.destination as string | undefined;

  if (!declaredDest || intent.type !== "transfer") return;

  // Check that the transfer destination matches
  for (const ix of instructions) {
    if (!TOKEN_PROGRAMS.has(ix.programAddress)) continue;
    if (!ix.data || ix.data.length < 1) continue;

    const disc = ix.data[0];
    if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED) continue;

    // Destination account is index 1
    if (ix.accounts && ix.accounts.length > 1) {
      const destAccount = ix.accounts[1].address;
      if (destAccount !== declaredDest) {
        violations.push({
          type: "recipient_mismatch",
          message: `Transfer destination ${destAccount} does not match declared ${declaredDest}`,
          expected: declaredDest,
          actual: destAccount,
        });
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getExpectedPrograms(intent: IntentAction): Set<string> {
  const programs = new Set<string>();

  // Map intent types to their expected programs
  const PHALNX = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";
  programs.add(PHALNX);

  switch (intent.type) {
    case "swap":
      programs.add("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"); // Jupiter V6
      break;
    case "openPosition":
    case "closePosition":
    case "increasePosition":
    case "decreasePosition":
    case "addCollateral":
    case "removeCollateral":
    case "placeTriggerOrder":
    case "editTriggerOrder":
    case "cancelTriggerOrder":
    case "placeLimitOrder":
    case "editLimitOrder":
    case "cancelLimitOrder":
    case "swapAndOpenPosition":
    case "closeAndSwapPosition":
      programs.add("FLASH6Lo6h3iasJKWzFVnGEEAS4rS4cFywSWcpuARtwN"); // Flash Trade
      programs.add("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"); // Jupiter for cross-actions
      break;
    case "deposit":
    case "withdraw":
    case "kaminoDeposit":
    case "kaminoBorrow":
    case "kaminoRepay":
    case "kaminoWithdraw":
      programs.add("KLend2g3cP87ber8CanZHA48X3CpM8ZBz45yjrKkCMsn"); // Kamino Lending (potential)
      programs.add("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"); // Drift (potential)
      break;
    case "transfer":
      // Only token programs + system expected
      break;
  }

  return programs;
}

function computeSeverity(violations: DriftViolation[]): DriftCheckResult["severity"] {
  if (violations.length === 0) return "none";

  // High severity: phantom transfers or program mismatches
  const hasHigh = violations.some(
    (v) => v.type === "phantom_transfer" || v.type === "program_mismatch",
  );
  if (hasHigh) return "high";

  // Medium severity: amount or recipient mismatch
  const hasMedium = violations.some(
    (v) => v.type === "amount_mismatch" || v.type === "recipient_mismatch",
  );
  if (hasMedium) return "medium";

  // Low severity: instruction count anomaly
  return "low";
}
