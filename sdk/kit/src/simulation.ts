/**
 * Kit-native pre-sign simulation with drain detection.
 *
 * Fail-closed: simulation failure blocks signing.
 */

import type {
  Rpc,
  SolanaRpcApi,
  Base64EncodedWireTransaction,
} from "./kit-adapter.js";

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
  [RISK_FLAG_SIZE_OVERFLOW]: 7033,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DrainThresholds {
  /** Percentage of vault balance outflow that triggers LARGE_OUTFLOW. Default: 50 */
  warningPercent?: number;
  /** Percentage of vault balance outflow that triggers FULL_DRAIN. Default: 95 */
  blockPercent?: number;
}

export const DEFAULT_WARNING_PERCENT = 50;
export const DEFAULT_BLOCK_PERCENT = 95;

export interface SimulationOptions {
  /** Timeout in milliseconds. Default: 3000 */
  timeoutMs?: number;
  /** Whether to replace recent blockhash. Default: true */
  replaceRecentBlockhash?: boolean;
  /** Token accounts to monitor for balance changes (drain detection) */
  monitorAccounts?: string[];
  /** Pre-simulation balances for monitored accounts */
  preBalances?: Map<string, bigint>;
  /** Vault address for drain detection */
  vaultAddress?: string;
  /** Total vault stablecoin balance */
  totalVaultBalance?: bigint;
  /** Known recipients (treasury, fee destination) */
  knownRecipients?: Set<string>;
  /** Configurable drain thresholds */
  drainThresholds?: DrainThresholds;
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
  6000: {
    name: "VaultNotActive",
    suggestion: "Check vault status — must be Active.",
  },
  6001: {
    name: "UnauthorizedAgent",
    suggestion: "Signer is not a registered agent.",
  },
  6002: {
    name: "UnauthorizedOwner",
    suggestion: "Only the vault owner can call this.",
  },
  6003: {
    name: "UnsupportedToken",
    suggestion: "Use USDC or USDT.",
  },
  6004: {
    name: "ProtocolNotAllowed",
    suggestion: "Protocol not in vault's allowlist.",
  },
  6005: {
    name: "TransactionTooLarge",
    suggestion: "Break into smaller parts.",
  },
  6006: {
    name: "SpendingCapExceeded",
    suggestion: "Rolling 24h spending cap exceeded.",
  },
  6007: {
    name: "LeverageTooHigh",
    suggestion: "Reduce leverage.",
  },
  6008: {
    name: "SessionNotAuthorized",
    suggestion: "Call validate_and_authorize first.",
  },
  6009: {
    name: "InvalidSession",
    suggestion: "Session does not belong to this vault.",
  },
  6010: {
    name: "TooManyAllowedProtocols",
    suggestion: "Reduce allowed protocols (max 10).",
  },
  6011: {
    name: "AgentAlreadyRegistered",
    suggestion: "Agent is already registered for this vault.",
  },
  6012: {
    name: "NoAgentRegistered",
    suggestion: "Register an agent first.",
  },
  6013: {
    name: "VaultNotFrozen",
    suggestion: "Vault must be frozen to reactivate.",
  },
  6014: {
    name: "VaultAlreadyClosed",
    suggestion: "Vault is already closed.",
  },
  6015: {
    name: "InsufficientBalance",
    suggestion: "Insufficient vault balance for withdrawal.",
  },
  6016: {
    name: "DeveloperFeeTooHigh",
    suggestion: "Developer fee rate exceeds max (5 BPS).",
  },
  6017: {
    name: "InvalidFeeDestination",
    suggestion: "Fee destination account invalid.",
  },
  6018: {
    name: "InvalidProtocolTreasury",
    suggestion: "Protocol treasury does not match expected address.",
  },
  6019: {
    name: "InvalidAgentKey",
    suggestion: "Agent cannot be the zero address.",
  },
  6020: {
    name: "AgentIsOwner",
    suggestion: "Agent cannot be the vault owner.",
  },
  6021: {
    name: "Overflow",
    suggestion: "Arithmetic overflow — amount too large.",
  },
  6022: {
    name: "InvalidTokenAccount",
    suggestion: "Token account wrong owner or mint.",
  },
  6023: {
    name: "TimelockNotExpired",
    suggestion: "Wait for timelock period to expire.",
  },
  6024: {
    name: "NoTimelockConfigured",
    suggestion: "No timelock configured on this vault.",
  },
  6025: {
    name: "DestinationNotAllowed",
    suggestion: "Destination not in allowed list.",
  },
  6026: {
    name: "TooManyDestinations",
    suggestion: "Too many destinations (max 10).",
  },
  6027: {
    name: "InvalidProtocolMode",
    suggestion: "Protocol mode must be 0, 1, or 2.",
  },
  6028: {
    name: "InvalidNonSpendingAmount",
    suggestion: "Non-spending action must have amount = 0.",
  },
  6029: {
    name: "CpiCallNotAllowed",
    suggestion: "Must be top-level instruction (no CPI).",
  },
  6030: {
    name: "MissingFinalizeInstruction",
    suggestion: "Include finalize_session in transaction.",
  },
  6031: {
    name: "NonTrackedSwapMustReturnStablecoin",
    suggestion: "Non-stablecoin swap must return stablecoin.",
  },
  6032: {
    name: "SwapSlippageExceeded",
    suggestion: "Slippage exceeds policy max_slippage_bps.",
  },
  6033: {
    name: "InvalidJupiterInstruction",
    suggestion: "Cannot parse Jupiter swap instruction.",
  },
  6034: {
    name: "UnauthorizedTokenTransfer",
    suggestion:
      "Top-level SPL Token transfer not allowed between validate and finalize.",
  },
  6035: {
    name: "SlippageBpsTooHigh",
    suggestion: "Slippage BPS exceeds maximum (5000 = 50%).",
  },
  6036: {
    name: "ProtocolMismatch",
    suggestion:
      "DeFi instruction program doesn't match declared target_protocol.",
  },
  6037: {
    name: "TooManyDeFiInstructions",
    suggestion: "Non-stablecoin swap allows exactly one DeFi instruction.",
  },
  6038: {
    name: "MaxAgentsReached",
    suggestion: "Remove an agent first (max 10).",
  },
  6039: {
    name: "InsufficientPermissions",
    suggestion: "Agent lacks permission for this action type.",
  },
  6040: {
    name: "InvalidPermissions",
    suggestion: "Permission bitmask contains invalid bits.",
  },
  6041: {
    name: "EscrowNotActive",
    suggestion: "Escrow is not in Active status.",
  },
  6042: {
    name: "EscrowExpired",
    suggestion: "Escrow has expired.",
  },
  6043: {
    name: "EscrowNotExpired",
    suggestion: "Escrow has not expired yet — wait for expiry.",
  },
  6044: {
    name: "InvalidEscrowVault",
    suggestion: "Invalid escrow vault.",
  },
  6045: {
    name: "EscrowConditionsNotMet",
    suggestion: "Escrow conditions not met.",
  },
  6046: {
    name: "EscrowDurationExceeded",
    suggestion: "Escrow duration exceeds max (30 days).",
  },
  6047: {
    name: "InvalidConstraintConfig",
    suggestion: "Constraint configuration exceeds bounds.",
  },
  6048: {
    name: "ConstraintViolated",
    suggestion: "Instruction violates a constraint.",
  },
  6049: {
    name: "InvalidConstraintsPda",
    suggestion: "Wrong constraints PDA owner or vault.",
  },
  6050: {
    name: "InvalidPendingConstraintsPda",
    suggestion: "Wrong pending constraints PDA.",
  },
  6051: {
    name: "AgentSpendLimitExceeded",
    suggestion: "Agent rolling 24h spend exceeds per-agent limit.",
  },
  6052: {
    name: "OverlaySlotExhausted",
    suggestion:
      "Per-agent overlay full — cannot register agent with spending limit.",
  },
  6053: {
    name: "AgentSlotNotFound",
    suggestion: "Agent has spending limit but no overlay tracking slot.",
  },
  6054: {
    name: "UnauthorizedTokenApproval",
    suggestion: "Unauthorized SPL Token Approve between validate and finalize.",
  },
  6055: {
    name: "InvalidSessionExpiry",
    suggestion: "Session expiry slots out of range (10-450).",
  },
  6056: {
    name: "UnconstrainedProgramBlocked",
    suggestion: "Program has no constraint entry and strict mode is enabled.",
  },
  6057: {
    name: "ProtocolCapExceeded",
    suggestion: "Per-protocol rolling 24h spending cap exceeded.",
  },
  6058: {
    name: "ProtocolCapsMismatch",
    suggestion: "protocol_caps length must match protocols length.",
  },
  6059: {
    name: "ActiveEscrowsExist",
    suggestion: "Close active escrow deposits before closing vault.",
  },
  6060: {
    name: "ConstraintsNotClosed",
    suggestion: "Close instruction constraints before closing vault.",
  },
  6061: {
    name: "PendingPolicyExists",
    suggestion: "Apply or cancel pending policy update before closing vault.",
  },
  6062: {
    name: "AgentPaused",
    suggestion: "Agent is paused — unpause before executing actions.",
  },
  6063: {
    name: "AgentAlreadyPaused",
    suggestion: "Agent is already paused.",
  },
  6064: {
    name: "AgentNotPaused",
    suggestion: "Agent is not paused.",
  },
  6065: {
    name: "UnauthorizedPostFinalizeInstruction",
    suggestion:
      "UnauthorizedPostFinalizeInstruction — see Sigil error-code documentation.",
  },
  6066: {
    name: "UnexpectedBalanceDecrease",
    suggestion:
      "UnexpectedBalanceDecrease — see Sigil error-code documentation.",
  },
  6067: {
    name: "TimelockTooShort",
    suggestion: "TimelockTooShort — see Sigil error-code documentation.",
  },
  6068: {
    name: "PolicyVersionMismatch",
    suggestion: "PolicyVersionMismatch — see Sigil error-code documentation.",
  },
  6069: {
    name: "PendingAgentPermsExists",
    suggestion: "PendingAgentPermsExists — see Sigil error-code documentation.",
  },
  6070: {
    name: "PendingCloseConstraintsExists",
    suggestion:
      "PendingCloseConstraintsExists — see Sigil error-code documentation.",
  },
  6071: {
    name: "ActiveSessionsExist",
    suggestion: "ActiveSessionsExist — see Sigil error-code documentation.",
  },
  6072: {
    name: "PostAssertionFailed",
    suggestion: "PostAssertionFailed — see Sigil error-code documentation.",
  },
  6073: {
    name: "InvalidPostAssertionIndex",
    suggestion:
      "InvalidPostAssertionIndex — see Sigil error-code documentation.",
  },
  6074: {
    name: "UnauthorizedPreValidateInstruction",
    suggestion:
      "UnauthorizedPreValidateInstruction — see Sigil error-code documentation.",
  },
  6075: {
    name: "SnapshotNotCaptured",
    suggestion: "SnapshotNotCaptured — see Sigil error-code documentation.",
  },
  6076: {
    name: "ConstraintIndexOutOfBounds",
    suggestion:
      "ConstraintIndexOutOfBounds — see Sigil error-code documentation.",
  },
  6077: {
    name: "InvalidConstraintOperator",
    suggestion:
      "InvalidConstraintOperator — see Sigil error-code documentation.",
  },
  6078: {
    name: "ConstraintsVaultMismatch",
    suggestion:
      "ConstraintsVaultMismatch — see Sigil error-code documentation.",
  },
  6079: {
    name: "ConstraintEntryCountExceeded",
    suggestion:
      "ConstraintEntryCountExceeded — see Sigil error-code documentation.",
  },
  6080: {
    name: "BlockedSplOpcode",
    suggestion: "BlockedSplOpcode — see Sigil error-code documentation.",
  },
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
        sigVerify: false as const,
        commitment: "confirmed" as const,
      };

      // When monitorAccounts provided, request post-simulation account state
      if (options?.monitorAccounts?.length) {
        config.accounts = {
          addresses: options.monitorAccounts,
          encoding: "base64" as const,
        };
      }

      const result = await rpc
        .simulateTransaction(
          encodedTransaction,
          config as Parameters<typeof rpc.simulateTransaction>[1],
        )
        .send({ abortSignal: controller.signal });

      clearTimeout(timeout);

      const value = result.value as {
        err: unknown;
        logs: string[] | null;
        unitsConsumed: bigint | null;
        accounts?: ({ data: [string, string] } | null)[] | null;
      } | null;
      const err = value?.err;
      const logs: string[] = value?.logs ?? [];
      const unitsConsumed = value?.unitsConsumed
        ? Number(value.unitsConsumed)
        : undefined;

      if (!err) {
        // Build balance deltas + drain detection when monitorAccounts provided
        const riskFlags: RiskFlag[] = [];
        let balanceDeltas: BalanceDelta[] | undefined;

        if (
          options?.monitorAccounts?.length &&
          value?.accounts &&
          options.vaultAddress &&
          options.totalVaultBalance !== undefined
        ) {
          balanceDeltas = [];
          for (let i = 0; i < options.monitorAccounts.length; i++) {
            const acctData = value.accounts[i];
            if (!acctData?.data?.[0]) continue;
            const postBalance = parseTokenBalance(acctData.data[0]);
            const preBalance =
              options.preBalances?.get(options.monitorAccounts[i]) ?? 0n;
            balanceDeltas.push({
              account: options.monitorAccounts[i],
              preBalance,
              postBalance,
              delta: postBalance - preBalance,
            });
          }

          if (balanceDeltas.length > 0) {
            const drainFlags = detectDrainAttempt(
              {
                balanceDeltas,
                vaultAddress: options.vaultAddress,
                totalVaultBalance: options.totalVaultBalance,
                knownRecipients: options.knownRecipients,
              },
              options.drainThresholds,
            );
            riskFlags.push(...drainFlags);
          }
        }

        return {
          success: true,
          unitsConsumed,
          logs,
          balanceDeltas,
          riskFlags,
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

// ─── Token Balance Parsing ───────────────────────────────────────────────────

/**
 * Parse SPL Token account balance from base64-encoded account data.
 * Reads u64 LE at byte offset 64 (SPL Token layout: 32 mint + 32 owner + 8 amount).
 *
 * SECURITY: Fail-closed by council mandate (4-0 verdict, Decision 3a).
 * Returning 0n on error was dangerous because: if both pre-balance AND post-balance
 * parse to 0n (dual RPC failure), delta = 0n - 0n = 0n, making drain detection
 * see no outflow. This silently disables all percentage-based drain checks.
 * Now throws on malformed data so callers must handle the error explicitly.
 * Returns 0n ONLY for valid but short data (account exists but has no balance).
 */
export function parseTokenBalance(base64Data: string): bigint {
  const binary = atob(base64Data); // Throws on malformed base64 (fail-closed)
  if (binary.length < 72) return 0n; // Valid but short → genuinely empty/uninitialized
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(binary.charCodeAt(64 + i)) << BigInt(i * 8);
  }
  return result;
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
 *
 * @param input - Balance deltas and vault context
 * @param drainThresholds - Optional configurable thresholds (defaults: 50% warning, 95% block)
 */
export function detectDrainAttempt(
  input: DrainDetectionInput,
  drainThresholds?: DrainThresholds,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const rawWarning = drainThresholds?.warningPercent ?? DEFAULT_WARNING_PERCENT;
  const rawBlock = drainThresholds?.blockPercent ?? DEFAULT_BLOCK_PERCENT;
  // Clamp to [0, 100] — prevents NaN/Infinity crashes (BigInt throws on non-finite)
  // and negative values which would invert the threshold logic
  const warningPct = Math.floor(
    Math.max(
      0,
      Math.min(
        100,
        Number.isFinite(rawWarning) ? rawWarning : DEFAULT_WARNING_PERCENT,
      ),
    ),
  );
  const blockPct = Math.floor(
    Math.max(
      0,
      Math.min(
        100,
        Number.isFinite(rawBlock) ? rawBlock : DEFAULT_BLOCK_PERCENT,
      ),
    ),
  );

  const vaultDelta = input.balanceDeltas.find(
    (d) => d.account === input.vaultAddress,
  );

  if (vaultDelta && vaultDelta.delta < 0n) {
    const outflow = -vaultDelta.delta;

    // LARGE_OUTFLOW: outflow >= warningPercent of vault balance
    if (
      input.totalVaultBalance > 0n &&
      outflow * 100n >= input.totalVaultBalance * BigInt(warningPct)
    ) {
      flags.push(RISK_FLAG_LARGE_OUTFLOW);
    }

    // FULL_DRAIN: outflow >= blockPercent of vault balance
    if (
      input.totalVaultBalance > 0n &&
      outflow * 100n >= input.totalVaultBalance * BigInt(blockPct)
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

  // MULTI_OUTPUT: tokens going to 2+ UNKNOWN accounts (excludes known recipients)
  // Lowered from 3 to 2 to catch split-drain attacks where attacker uses 2 accounts.
  // Known recipients (treasury, fee dest) are excluded to prevent false positives.
  const unknownPositiveDeltas = input.balanceDeltas.filter(
    (d) =>
      d.delta > 0n &&
      d.account !== input.vaultAddress &&
      (!input.knownRecipients || !input.knownRecipients.has(d.account)),
  );
  if (unknownPositiveDeltas.length >= 2) {
    flags.push(RISK_FLAG_MULTI_OUTPUT);
  }

  return flags;
}

/**
 * Detect drain attempts using vault context from seal().
 * Automatically wires knownRecipients from the seal result's vaultContext.
 *
 * Usage:
 * ```ts
 * const sealResult = await seal(params);
 * const flags = detectDrainFromSealContext(balanceDeltas, sealResult.vaultContext);
 * ```
 */
export function detectDrainFromSealContext(
  balanceDeltas: BalanceDelta[],
  vaultContext: {
    vaultAddress: string;
    tokenBalance: bigint;
    knownRecipients: Set<string>;
  },
  drainThresholds?: DrainThresholds,
): RiskFlag[] {
  return detectDrainAttempt(
    {
      balanceDeltas,
      vaultAddress: vaultContext.vaultAddress,
      totalVaultBalance: vaultContext.tokenBalance,
      knownRecipients: vaultContext.knownRecipients,
    },
    drainThresholds,
  );
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
