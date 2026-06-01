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

/**
 * Anchor error code → diagnostic name + recovery suggestion. Exported so
 * pre-flight-simulation tests can assert the map covers all on-chain
 * error codes the SDK might surface during a `simulateBeforeSend` call.
 *
 * The full canonical error registry lives in
 * `sdk/kit/src/agent-errors.ts` (`ON_CHAIN_ERROR_MAP`) — that map is the
 * source-of-truth for runtime UX surfaces. This simulation-side map is a
 * narrower DIAGNOSTIC table: it includes only the codes that can plausibly
 * surface during a pre-flight transaction simulation (Anchor `require!`
 * trips from `validate_and_authorize`, `agent_transfer`, `finalize_session`,
 * etc.). Codes that only fire from owner-mutation paths (Phase 0/1)
 * intentionally don't need a simulation suggestion because the caller is
 * the owner and the error message ships directly from on-chain.
 */
export const ANCHOR_ERROR_MAP: Record<
  number,
  { name: string; suggestion: string }
> = {
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
    name: "SessionNotAuthorized",
    suggestion: "Call validate_and_authorize first.",
  },
  6008: {
    name: "InvalidSession",
    suggestion: "Session does not belong to this vault.",
  },
  6009: {
    name: "TooManyAllowedProtocols",
    suggestion: "Reduce allowed protocols (max 10).",
  },
  6010: {
    name: "AgentAlreadyRegistered",
    suggestion: "Agent is already registered for this vault.",
  },
  6011: {
    name: "NoAgentRegistered",
    suggestion: "Register an agent first.",
  },
  6012: {
    name: "VaultNotFrozen",
    suggestion: "Vault must be frozen to reactivate.",
  },
  6013: {
    name: "VaultAlreadyClosed",
    suggestion: "Vault is already closed.",
  },
  6014: {
    name: "InsufficientBalance",
    suggestion: "Insufficient vault balance for withdrawal.",
  },
  6015: {
    name: "DeveloperFeeTooHigh",
    suggestion: "Developer fee rate exceeds max (5 BPS).",
  },
  6016: {
    name: "InvalidFeeDestination",
    suggestion: "Fee destination account invalid.",
  },
  6017: {
    name: "InvalidProtocolTreasury",
    suggestion: "Protocol treasury does not match expected address.",
  },
  6018: {
    name: "InvalidAgentKey",
    suggestion: "Agent cannot be the zero address.",
  },
  6019: {
    name: "AgentIsOwner",
    suggestion: "Agent cannot be the vault owner.",
  },
  6020: {
    name: "Overflow",
    suggestion: "Arithmetic overflow — amount too large.",
  },
  6021: {
    name: "InvalidTokenAccount",
    suggestion: "Token account wrong owner or mint.",
  },
  6022: {
    name: "TimelockNotExpired",
    suggestion: "Wait for timelock period to expire.",
  },
  6023: {
    name: "NoTimelockConfigured",
    suggestion: "No timelock configured on this vault.",
  },
  6024: {
    name: "DestinationNotAllowed",
    suggestion: "Destination not in allowed list.",
  },
  6025: {
    name: "TooManyDestinations",
    suggestion: "Too many destinations (max 10).",
  },
  6026: {
    name: "InvalidProtocolMode",
    suggestion: "Protocol mode must be 0, 1, or 2.",
  },
  6027: {
    name: "CpiCallNotAllowed",
    suggestion: "Must be top-level instruction (no CPI).",
  },
  6028: {
    name: "MissingFinalizeInstruction",
    suggestion: "Include finalize_session in transaction.",
  },
  6029: {
    name: "NonTrackedSwapMustReturnStablecoin",
    suggestion: "Non-stablecoin swap must return stablecoin.",
  },
  6030: {
    name: "UnauthorizedTokenTransfer",
    suggestion:
      "Top-level SPL Token transfer not allowed between validate and finalize.",
  },
  6031: {
    name: "SlippageBpsTooHigh",
    suggestion: "Slippage BPS exceeds maximum (5000 = 50%).",
  },
  6032: {
    name: "ProtocolMismatch",
    suggestion:
      "DeFi instruction program doesn't match declared target_protocol.",
  },
  6033: {
    name: "TooManyDeFiInstructions",
    suggestion: "Non-stablecoin swap allows exactly one DeFi instruction.",
  },
  6034: {
    name: "MaxAgentsReached",
    suggestion: "Remove an agent first (max 10).",
  },
  6035: {
    name: "InsufficientPermissions",
    suggestion: "Agent lacks permission for this action type.",
  },
  6036: {
    name: "InvalidPermissions",
    suggestion: "Permission bitmask contains invalid bits.",
  },
  6037: {
    name: "InvalidConstraintConfig",
    suggestion: "Constraint configuration exceeds bounds.",
  },
  6038: {
    name: "AgentSpendLimitExceeded",
    suggestion: "Agent rolling 24h spend exceeds per-agent limit.",
  },
  6039: {
    name: "OverlaySlotExhausted",
    suggestion:
      "Per-agent overlay full — cannot register agent with spending limit.",
  },
  6040: {
    name: "AgentSlotNotFound",
    suggestion: "Agent has spending limit but no overlay tracking slot.",
  },
  6041: {
    name: "UnauthorizedTokenApproval",
    suggestion: "Unauthorized SPL Token Approve between validate and finalize.",
  },
  6042: {
    name: "InvalidSessionExpiry",
    suggestion: "Session expiry slots out of range (10-450).",
  },
  6043: {
    name: "ProtocolCapExceeded",
    // §RP-1 V5: 6047 semantics flipped. Rolling 24h per-protocol cap
    // moved to 6095 (ErrDailyCapExceeded). 6047 now signals only the
    // slot-allocation exhausted case from state/tracker.rs:313.
    suggestion:
      "Per-protocol counter slot allocation exhausted (max 10 protocols tracked). Wait for an existing slot's 24h window to elapse, or reuse one of the protocols already tracked.",
  },
  6044: {
    name: "ProtocolCapsMismatch",
    suggestion: "protocol_caps length must match protocols length.",
  },
  6045: {
    name: "PendingPolicyExists",
    suggestion: "Apply or cancel pending policy update before closing vault.",
  },
  6046: {
    name: "AgentPaused",
    suggestion: "Agent is paused — unpause before executing actions.",
  },
  6047: {
    name: "AgentAlreadyPaused",
    suggestion: "Agent is already paused.",
  },
  6048: {
    name: "AgentNotPaused",
    suggestion: "Agent is not paused.",
  },
  6049: {
    name: "UnauthorizedPostFinalizeInstruction",
    suggestion:
      "UnauthorizedPostFinalizeInstruction — see Sigil error-code documentation.",
  },
  6050: {
    name: "UnexpectedBalanceDecrease",
    suggestion:
      "UnexpectedBalanceDecrease — see Sigil error-code documentation.",
  },
  6051: {
    name: "TimelockTooShort",
    suggestion: "TimelockTooShort — see Sigil error-code documentation.",
  },
  6052: {
    name: "PolicyVersionMismatch",
    suggestion: "PolicyVersionMismatch — see Sigil error-code documentation.",
  },
  6053: {
    name: "ActiveSessionsExist",
    suggestion: "ActiveSessionsExist — see Sigil error-code documentation.",
  },
  6054: {
    name: "PostAssertionFailed",
    suggestion: "PostAssertionFailed — see Sigil error-code documentation.",
  },
  6055: {
    name: "InvalidPostAssertionIndex",
    suggestion:
      "InvalidPostAssertionIndex — see Sigil error-code documentation.",
  },
  6056: {
    name: "UnauthorizedPreValidateInstruction",
    suggestion:
      "UnauthorizedPreValidateInstruction — see Sigil error-code documentation.",
  },
  6057: {
    name: "SnapshotNotCaptured",
    suggestion: "SnapshotNotCaptured — see Sigil error-code documentation.",
  },
  6058: {
    name: "InvalidConstraintOperator",
    suggestion:
      "InvalidConstraintOperator — see Sigil error-code documentation.",
  },
  6059: {
    name: "ZeroCopyVaultMismatch",
    suggestion: "ZeroCopyVaultMismatch — see Sigil error-code documentation.",
  },
  // F-10 audit fix: durable-nonce pre-signing defense
  6060: {
    name: "QueuedUpdateExpired",
    suggestion:
      "Queued update is too old — re-queue via queue_policy_update / queue_constraints_update / queue_close_constraints / queue_agent_permissions_update / queue_agent_grant / initiate_ownership_transfer (CH-1 audit 2026-05-23 extended to timelocked-admin PDAs).",
  },
  6061: {
    name: "AccountWritabilityMismatch",
    suggestion:
      "Account writability flag does not match constraint requirement.",
  },
  6062: {
    name: "SysvarScanBoundExceeded",
    suggestion:
      "Sysvar instruction scan exceeded the per-tx safety bound — reduce transaction size.",
  },
  6063: {
    name: "AsyncFulfillmentNotPermitted",
    suggestion:
      "Async-fulfillment program is not permitted in V1 (Jupiter Perps, Drift, Drift JIT). Keeper-deferred fills cannot be measured by finalize_session.",
  },
  6064: {
    name: "ConfidentialTransferBlocked",
    suggestion:
      "Token-2022 ConfidentialTransfer not permitted between validate and finalize.",
  },
  6065: {
    name: "PermanentDelegateBlocked",
    suggestion:
      "Token-2022 PermanentDelegate not permitted between validate and finalize.",
  },
  6066: {
    name: "TransferHookBlocked",
    suggestion:
      "Token-2022 TransferHook not permitted between validate and finalize.",
  },
  6067: {
    name: "LamportDrainBlocked",
    suggestion:
      "Token-2022 destructive-balance ix (opcodes 38/45/46) not permitted between validate and finalize.",
  },
  6068: {
    name: "BatchInstructionBlocked",
    suggestion:
      "Token-2022 Batch instruction (opcode 255) is blocked — wraps inner instructions and bypasses byte-0 blocklist.",
  },
  6069: {
    name: "InvalidDestinationMode",
    suggestion:
      "Invalid destination mode — must be 0 (Restricted) or 1 (OpenWithCap).",
  },

  // ─── Phase 5 §RP-1 V5: post-execution invariants ───
  // Map mirrors the Rust SigilError codes 6094-6096 added in Phase 5.
  // Older 6079-6093 entries are intentionally not mapped here (this
  // suggestion table is partial — only the codes actually emitted in
  // pre-flight simulation are required). 6094-6096 emit from
  // `finalize_session` / `agent_transfer` so they CAN surface in a
  // simulation result and benefit from a friendly suggestion.

  6085: {
    name: "ErrStableFloorViolation",
    suggestion:
      "Stable balance floor violated — the combined USDC+USDT vault balance after this transaction would drop below policy.stable_balance_floor. Reduce the transfer amount or deposit more stablecoin before retrying.",
  },
  6086: {
    name: "ErrDailyCapExceeded",
    suggestion:
      "Per-protocol daily cap exceeded — this protocol's rolling 24h spending cap would be exceeded. Reduce the amount, route through a different allowlisted protocol, or wait for the rolling window to release capacity.",
  },
  6087: {
    name: "ErrRecipientCapExceeded",
    suggestion:
      "Per-recipient daily cap exceeded — the recipient's rolling 24h outflow would breach policy.per_recipient_daily_cap_usd. Reduce the amount, route to a different allowed destination, or wait for the rolling window to release capacity.",
  },

  // ─── Phase 5 R-1..R-4 post-execution assertions (codes 6097-6101) ───
  // Emitted from `finalize_session` after the DeFi instruction runs.
  // Visible in simulation because the full sandwich (validate ix + DeFi ix +
  // finalize ix) is simulated as one transaction.
  6088: {
    name: "ErrMintDeltaCapExceeded",
    suggestion:
      "R-1 MintDeltaCap: vault-mint balance decreased by more than the policy's `max_net_decrease` for this mint. Reduce the outflow, raise the cap on PolicyConfig, or split into smaller transactions.",
  },
  6089: {
    name: "MintDeltaCapMisconfigured",
    suggestion:
      "R-1 MintDeltaCap target account is missing, has a mint mismatch, or has owner != vault. Re-derive the target token account and re-check the PolicyConfig entry.",
  },
  6090: {
    name: "ErrAtaAuthorityChanged",
    suggestion:
      "R-2 AtaAuthorityPin: a vault-owned token account had its authority changed or was closed/reinitialized mid-sandwich. Re-check that no foreign instruction is touching the vault's ATAs in this transaction.",
  },
  6091: {
    name: "ErrOutputBelowFloor",
    suggestion:
      "R-3 OutputBalanceFloor: the post-execution balance increase fell below the configured `min_increase` floor. Adjust slippage settings or raise the floor, then retry.",
  },
  6092: {
    name: "ErrDeclarationInconsistent",
    suggestion:
      "R-4 DeclarationConsistency: the recipient/mint declared on validate_and_authorize does not match the actual CPI account-meta. Re-derive the declared accounts from the same accounts the DeFi instruction will consume.",
  },

  // ─── Phase 6 destination-check budget (code 6102) ───
  6093: {
    name: "IxMetaCountExceeded",
    suggestion:
      "Foreign DeFi instruction passed more account metas than the destination-check budget (16) allows. Truncate the instruction or split it into shorter ixs.",
  },

  // ─── Phase 8 ownership-transfer ───
  6094: {
    name: "ErrPendingOwnershipExists",
    suggestion:
      "An ownership transfer is already pending. Cancel the existing transfer with `cancelOwnershipTransfer` before initiating a new one.",
  },
  6095: {
    name: "ErrPendingOwnershipNotReady",
    suggestion:
      "Ownership transfer timelock has not elapsed. Wait for the 48h cool-down to expire before calling `acceptOwnershipTransfer`.",
  },
  6096: {
    name: "ErrInvalidFreezeReason",
    suggestion:
      "freeze_reason value must be one of {0, 1, 2}. Re-check the FreezeReason discriminant on freezeVault.",
  },
  6097: {
    name: "ErrReactivateCooldownActive",
    suggestion:
      "Reactivate requires a 5-minute observation cooldown to elapse since the freeze. Wait, then retry.",
  },
  6098: {
    name: "ErrInvalidOwnershipTarget",
    suggestion:
      "new_owner cannot be a system/program/sysvar address (Council ISC-128). Pass a real wallet pubkey.",
  },

  // ─── Phase 8 freeze + post-assertions ───
  6099: {
    name: "ErrTooManyRevokePairs",
    suggestion:
      "freeze_internal MAX_REVOKE_PAIRS = 10 exceeded (Council ISC-136). Split the freeze into multiple transactions revoking ≤10 token-account pairs each.",
  },
  6100: {
    name: "ErrPostAssertionsNotClosed",
    suggestion:
      "PostExecutionAssertions PDA still active. Call `closePostAssertions` before closing the vault or creating a new assertions set.",
  },
  6101: {
    name: "ErrDestinationIsProtectedPda",
    suggestion:
      "Destination is a Sigil-protected PDA — rejected at queue time. Pick a different recipient that is not a Sigil-owned account.",
  },

  // ─── Bucket-2 intent-digest binding ───
  // D-1 codes: emitted when the digest signed at queue/preview does not
  // match the digest recomputed at apply/execute. Surfaces during
  // pre-flight simulation because the digest computation lives on-chain.
  6102: {
    name: "ErrIntentDigestMismatch",
    suggestion:
      "AL3 intent-digest mismatch — the preview digest signed at seal time does not match the executed bundle. Re-build the seal with the live instructions and re-sign.",
  },
  6103: {
    name: "ErrPendingAgentGrantDigestMismatch",
    suggestion:
      "PendingAgentGrant digest mismatch between queue and apply. The agent grant state changed between queue and apply — re-queue with the current vault state.",
  },
  6104: {
    name: "ErrReactivateCosignRequiredForFullCapability",
    suggestion:
      "Reactivate with a FULL_CAPABILITY new agent requires cosign. Pass a cosigner signature to `reactivateVault`, or use a lower capability tier for the new agent.",
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
