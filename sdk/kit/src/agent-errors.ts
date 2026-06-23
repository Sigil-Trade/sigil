/**
 * Kit-native Agent Error System
 *
 * Structured errors optimized for AI agent consumption.
 * Every error includes a category, retryability flag, and
 * recovery actions that tell the agent exactly what to do next.
 *
 * Maps all 105 on-chain error codes (6000-6104) — post M1-04 constraints-engine
 * teardown, which removed 10 dead constraint-only variants and renumbered the
 * enum (positional). The IDL (`target/idl/sigil.json`) is the authoritative
 * code↔name source; `error-map-drift.test.ts` enforces this map agrees with it.
 * Plus 34 SDK error codes (7000-7033), all to AgentError with machine-readable
 * metadata.
 *
 * Zero dependency on @solana/web3.js or @coral-xyz/anchor.
 * Uses bigint instead of BN for context values.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "INPUT_VALIDATION"
  | "TRANSIENT"
  | "RATE_LIMIT"
  | "PERMISSION"
  | "RESOURCE_NOT_FOUND"
  | "SPENDING_CAP"
  | "POLICY_VIOLATION"
  | "PROTOCOL_NOT_SUPPORTED"
  | "ESCALATION_REQUIRED"
  | "FATAL";

export interface RecoveryAction {
  /** Machine-readable action identifier */
  action: string;
  /** Human-readable description of what to do */
  description: string;
  /** Which tool to call for recovery (if applicable) */
  tool?: string;
  /** Suggested parameter values for the recovery tool */
  parameters?: Record<string, unknown>;
}

export interface AgentError {
  /** Error code — on-chain numeric (e.g. "6010") or SDK string (e.g. "NETWORK_ERROR") */
  code: string;
  /** One-sentence description */
  message: string;
  /** Error classification for agent decision-making */
  category: ErrorCategory;
  /** Whether the same request may succeed if retried */
  retryable: boolean;
  /** Suggested delay before retry (ms), only meaningful when retryable=true */
  retry_after_ms?: number;
  /** Ordered list of recovery actions the agent should attempt */
  recovery_actions: RecoveryAction[];
  /** Additional context about the error (amounts, addresses, etc.) */
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// On-chain error code range constants — single source of truth.
//
// `dashboard/errors.ts` re-imports these for the FE→BE category mapping.
// `tests/dashboard/errors-categorize.test.ts` iterates every generated
// `SIGIL_ERROR__*` constant and asserts it falls within this range, so
// drift between MAX and the highest variant breaks CI immediately.
//
// MAINTENANCE — when `programs/sigil/src/errors.rs` adds a new variant:
//   1. Bump SIGIL_ON_CHAIN_ERROR_MAX below to the new highest code.
//   2. Add an entry to ON_CHAIN_ERRORS for that code (or a TODO with
//      explicit deferral rationale).
//   3. Regenerate the IDL + SDK with `pnpm codama` so generated/errors
//      stays in lockstep.
// ---------------------------------------------------------------------------

/** Lowest Anchor-error code Sigil emits. */
export const SIGIL_ON_CHAIN_ERROR_MIN = 6000;
/**
 * Highest Anchor-error code currently in use. Bump when errors.rs grows.
 *
 * The enum tops out at 6117 (Item 3 verified-build gate: 6116/6117). The drift
 * gate at `tests/error-map-drift.test.ts` derives the expected count from
 * `target/idl/sigil.json` (the authoritative code↔name source) and asserts
 * this map agrees with it by code AND name — so adding or renumbering an
 * on-chain error without updating this map fails at test time.
 */
export const SIGIL_ON_CHAIN_ERROR_MAX = 6117;

interface ErrorMapping {
  name: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  retry_after_ms?: number;
  recovery_actions: RecoveryAction[];
}

export const ON_CHAIN_ERROR_MAP: Record<number, ErrorMapping> = {
  // --- Vault state errors ---
  6000: {
    name: "VaultNotActive",
    message: "Vault is not active",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "reactivate_vault",
        description: "Reactivate the vault if it is frozen",
        tool: "sigil_reactivate_vault",
      },
      {
        action: "create_vault",
        description: "Create a new vault if this one is closed",
        tool: "sigil_create_vault",
      },
    ],
  },
  6001: {
    name: "UnauthorizedAgent",
    message: "Signer is not a registered agent on this vault",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_agent_registration",
        description:
          "Verify the agent keypair is registered on the target vault",
        tool: "sigil_check_vault",
      },
      {
        action: "register_agent",
        description: "Ask the vault owner to register this agent",
        tool: "sigil_register_agent",
      },
    ],
  },
  6002: {
    name: "UnauthorizedOwner",
    message: "Signer is not the vault owner",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_owner",
        description: "This operation requires the vault owner's signature",
      },
    ],
  },
  6003: {
    name: "UnsupportedToken",
    message: "Token is not a supported stablecoin (only USDC and USDT)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_stablecoin",
        description: "Use USDC or USDT mint address instead",
      },
    ],
  },
  6004: {
    name: "ProtocolNotAllowed",
    message: "Protocol not allowed by vault policy",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_policy",
        description: "Check which protocols the vault allows",
        tool: "sigil_check_vault",
      },
      {
        action: "change_protocol",
        description: "Use a protocol that is on the vault's allowlist",
      },
    ],
  },
  6005: {
    name: "TransactionTooLarge",
    message: "Transaction exceeds maximum single transaction size (USD)",
    category: "SPENDING_CAP",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the transaction amount below maxTransactionSizeUsd",
      },
      {
        action: "check_limits",
        description: "Check the vault's maxTransactionSizeUsd policy",
        tool: "sigil_check_vault",
      },
    ],
  },
  6006: {
    name: "SpendingCapExceeded",
    message: "Rolling 24h spending cap would be exceeded",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "reduce_amount",
        description: "Reduce the amount to fit within remaining daily cap",
      },
      {
        action: "check_spending",
        description: "Check remaining spending capacity",
        tool: "sigil_check_spending",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity",
      },
    ],
  },
  6007: {
    name: "SessionNotAuthorized",
    message: "Session authority not authorized for this action",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "new_session",
        description: "Create a new validate_and_authorize session",
      },
    ],
  },
  6008: {
    name: "InvalidSession",
    message: "Session does not belong to this vault or is invalid",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_vault",
        description: "Ensure the session PDA matches the target vault",
      },
    ],
  },
  6009: {
    name: "TooManyAllowedProtocols",
    message: "Policy configuration has too many allowed protocols (max 10)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_protocols",
        description: "Reduce the protocol allowlist to 10 or fewer entries",
      },
    ],
  },
  6010: {
    name: "AgentAlreadyRegistered",
    message: "Agent is already registered on this vault",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_agents",
        description: "Check existing agents on the vault",
        tool: "sigil_check_vault",
      },
    ],
  },
  6011: {
    name: "NoAgentRegistered",
    message: "No agent registered on this vault",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "register_agent",
        description: "Register an agent on the vault first",
        tool: "sigil_register_agent",
      },
    ],
  },
  6012: {
    name: "VaultNotFrozen",
    message: "Vault is not frozen (expected frozen for reactivation)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_status",
        description: "Check the vault's current status",
        tool: "sigil_check_vault",
      },
    ],
  },
  6013: {
    name: "VaultAlreadyClosed",
    message: "Vault is permanently closed",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "create_vault",
        description: "Create a new vault — closed vaults cannot be reopened",
        tool: "sigil_create_vault",
      },
    ],
  },
  6014: {
    name: "InsufficientBalance",
    message: "Insufficient vault balance for this operation",
    category: "SPENDING_CAP",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_amount",
        description: "Reduce the amount to match available balance",
      },
      {
        action: "deposit",
        description: "Deposit more funds into the vault",
      },
      {
        action: "check_balance",
        description: "Check vault token balances",
        tool: "sigil_check_vault",
      },
    ],
  },
  6015: {
    name: "DeveloperFeeTooHigh",
    message: "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_fee",
        description: "Set developer_fee_rate to 500 or below",
      },
    ],
  },
  6016: {
    name: "InvalidFeeDestination",
    message: "Fee destination account is invalid",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_fee_destination",
        description: "Provide a valid fee destination token account",
      },
    ],
  },
  6017: {
    name: "InvalidProtocolTreasury",
    message: "Protocol treasury account does not match expected address",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_treasury",
        description: "Use the correct protocol treasury address",
      },
    ],
  },
  6018: {
    name: "InvalidAgentKey",
    message: "Agent cannot be the zero address",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "provide_valid_agent",
        description: "Use a valid non-zero Solana public key for the agent",
      },
    ],
  },
  6019: {
    name: "AgentIsOwner",
    message: "Agent cannot be the vault owner",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_different_key",
        description:
          "Use a different keypair for the agent (cannot be the same as owner)",
      },
    ],
  },
  6020: {
    name: "Overflow",
    message: "Arithmetic overflow in on-chain computation",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_amount",
        description: "The amount may be too large — try a smaller value",
      },
    ],
  },
  6021: {
    name: "InvalidTokenAccount",
    message: "Token account does not belong to vault or has wrong mint",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_token_account",
        description:
          "Ensure the token account is owned by the vault PDA and has the correct mint",
      },
    ],
  },

  // --- Timelock + Destination errors ---
  6022: {
    name: "TimelockNotExpired",
    message: "Timelock period has not expired yet",
    category: "POLICY_VIOLATION",
    retryable: true,
    retry_after_ms: 60_000,
    recovery_actions: [
      {
        action: "wait",
        description:
          "Wait for the timelock period to expire before applying the update",
      },
    ],
  },
  6023: {
    name: "NoTimelockConfigured",
    message: "No timelock configured on this vault",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_direct_update",
        description: "Use direct policy update (no timelock required)",
      },
    ],
  },
  6024: {
    name: "DestinationNotAllowed",
    message: "Destination address not in vault's allowed destinations list",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_destinations",
        description: "Check the vault's allowedDestinations list",
        tool: "sigil_check_vault",
      },
      {
        action: "use_allowed_destination",
        description: "Use a destination that is in the vault's allowlist",
      },
    ],
  },
  6025: {
    name: "TooManyDestinations",
    message: "Too many destinations in allowlist (max 10)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_destinations",
        description: "Reduce the destination allowlist to 10 or fewer entries",
      },
    ],
  },
  6026: {
    name: "InvalidProtocolMode",
    message:
      "Invalid protocol mode (must be 0=all, 1=allowlist, or 2=denylist)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_mode",
        description:
          "Set protocolMode to 0 (all), 1 (allowlist), or 2 (denylist)",
      },
    ],
  },

  // --- Flash Trade expansion errors ---
  6027: {
    name: "CpiCallNotAllowed",
    message:
      "Instruction must be top-level (CPI calls not allowed for validate/finalize)",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_transaction",
        description:
          "Ensure validate_and_authorize is called at the top level, not via CPI",
      },
    ],
  },
  6028: {
    name: "MissingFinalizeInstruction",
    message:
      "Transaction must include finalize_session after validate_and_authorize",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's compose functions which automatically include finalize_session",
      },
    ],
  },

  // --- Stablecoin-only enforcement errors ---
  6029: {
    name: "NonTrackedSwapMustReturnStablecoin",
    message:
      "Non-stablecoin swap must return stablecoin (vault stablecoin balance did not increase)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "ensure_stablecoin_output",
        description:
          "Ensure the swap produces stablecoin output (USDC or USDT)",
      },
    ],
  },
  6030: {
    name: "UnauthorizedTokenTransfer",
    message:
      "Top-level SPL Token transfer not allowed between validate and finalize",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's compose functions — do not insert raw SPL transfers in the sandwich",
      },
    ],
  },
  6031: {
    name: "SlippageBpsTooHigh",
    message: "Slippage BPS exceeds maximum allowed (5000 = 50%)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_slippage",
        description: "Set slippageBps to 5000 or below",
      },
    ],
  },
  6032: {
    name: "ProtocolMismatch",
    message:
      "DeFi instruction program does not match the declared target_protocol",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_protocol",
        description:
          "Ensure target_protocol matches the actual DeFi instruction's program ID",
      },
    ],
  },
  6033: {
    name: "TooManyDeFiInstructions",
    message: "Non-stablecoin swap allows exactly one DeFi instruction",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "simplify_transaction",
        description: "Use a single DeFi instruction for non-stablecoin swaps",
      },
    ],
  },

  // --- Multi-Agent errors ---
  6034: {
    name: "MaxAgentsReached",
    message: "Maximum agents per vault reached (limit: 10)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an existing agent before registering a new one",
        tool: "sigil_revoke_agent",
      },
    ],
  },
  6035: {
    name: "InsufficientPermissions",
    message: "Agent lacks permission for this action type",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_permissions",
        description: "Check the agent's permission bitmask",
        tool: "sigil_check_vault",
      },
      {
        action: "request_permissions",
        description: "Ask the vault owner to update the agent's permissions",
      },
    ],
  },
  6036: {
    name: "InvalidPermissions",
    message:
      "Capability exceeds the on-chain maximum (valid values: 0 = Disabled, 1 = Observer, 2 = Operator)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_permissions",
        description:
          "Pass FULL_CAPABILITY (2n) — the Operator enum value — when the agent needs spending authority.",
      },
    ],
  },

  // --- Post-execution assertion config error ---
  6037: {
    name: "InvalidConstraintConfig",
    message: "Invalid constraint configuration: bounds exceeded",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_constraints",
        description:
          "Ensure constraint entries are within bounds (max 64 entries, 8 data constraints each)",
      },
    ],
  },

  // --- Per-agent spend limit errors ---
  6038: {
    name: "AgentSpendLimitExceeded",
    message:
      "Agent's rolling 24h spend exceeds their individual spending limit",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the amount to fit within the agent's remaining limit",
      },
      {
        action: "check_spending",
        description: "Check the agent's current spend against their limit",
        tool: "sigil_check_spending",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity",
      },
    ],
  },
  6039: {
    name: "OverlaySlotExhausted",
    message:
      "Per-agent overlay is full — cannot register agent with spending limit",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an unused agent to free an overlay slot",
        tool: "sigil_revoke_agent",
      },
    ],
  },
  6040: {
    name: "AgentSlotNotFound",
    message: "Agent has per-agent spending limit but no overlay tracking slot",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "contact_support",
        description:
          "This is an internal consistency error — the overlay may need reinitialization",
      },
    ],
  },
  6041: {
    name: "UnauthorizedTokenApproval",
    message:
      "Unauthorized SPL Token Approve detected between validate and finalize",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's compose functions — do not insert raw SPL Approve in the sandwich",
      },
    ],
  },
  6042: {
    name: "InvalidSessionExpiry",
    message: "Session expiry slots out of range (10-450)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_expiry",
        description: "Set session expiry between 10 and 450 slots",
      },
    ],
  },

  // --- Per-protocol spend cap errors ---
  // Phase 5 §RP-1 V5: 6047 semantics flipped. The "rolling 24h per-protocol
  // cap exceeded" semantic moved to 6095 (ErrDailyCapExceeded). 6047 now
  // only emits from `state/tracker.rs:313` when the fixed-size per-protocol
  // counter slot allocation (max 10 protocols tracked) is exhausted —
  // i.e. an 11th distinct protocol attempted within the rolling window.
  6043: {
    name: "ProtocolCapExceeded",
    message:
      "Per-protocol counter slot allocation exhausted (max 10 protocols tracked)",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "wait",
        description:
          "Wait for an existing protocol slot's 24h rolling window to elapse before invoking a new protocol",
      },
      {
        action: "use_existing_protocol",
        description:
          "Reuse one of the protocols already tracked in the rolling window rather than invoking an 11th distinct protocol",
      },
    ],
  },
  6044: {
    name: "ProtocolCapsMismatch",
    message:
      "protocol_caps length must match protocols length when has_protocol_caps is true",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_config",
        description:
          "Ensure protocol_caps array length matches the protocols array length",
      },
    ],
  },

  // --- Vault closure guard errors ---
  6045: {
    name: "PendingPolicyExists",
    message:
      "A pending policy update exists — apply or cancel it before closing vault",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "resolve_pending_policy",
        description:
          "Apply or cancel the pending policy update before closing the vault",
      },
    ],
  },

  // --- Agent pause errors ---
  6046: {
    name: "AgentPaused",
    message: "Agent is paused — unpause before executing actions",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "unpause_agent",
        description: "Ask the vault owner to unpause this agent",
      },
    ],
  },
  6047: {
    name: "AgentAlreadyPaused",
    message: "Agent is already paused",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_agent_status",
        description: "Agent is already paused — no action needed",
      },
    ],
  },
  6048: {
    name: "AgentNotPaused",
    message: "Agent is not paused — cannot unpause",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_agent_status",
        description: "Agent is not paused — no action needed",
      },
    ],
  },
  6049: {
    name: "UnauthorizedPostFinalizeInstruction",
    message:
      "Instructions after finalize_session must be ComputeBudget or SystemProgram only",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "remove_post_finalize_instructions",
        description:
          "Remove any instructions placed after finalize_session in the transaction. Only ComputeBudget and SystemProgram instructions are allowed after finalize.",
      },
    ],
  },
  6050: {
    name: "UnexpectedBalanceDecrease",
    message:
      "Vault stablecoin balance decreased more than the session authorized amount. " +
      "This indicates a compromised DeFi program attempted to drain vault tokens via CPI.",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "investigate_defi_program",
        description:
          "The whitelisted DeFi program may be compromised. The actual vault balance decrease " +
          "exceeded the authorized delegation amount (fees + DeFi spend). Freeze the vault, " +
          "investigate the DeFi program, and consider removing it from the protocol allowlist.",
      },
      {
        action: "freeze_vault",
        description:
          "Immediately freeze the vault to prevent further transactions until the cause is identified.",
      },
    ],
  },

  // --- TOCTOU + timelock hardening errors ---
  6051: {
    name: "TimelockTooShort",
    message:
      "Timelock duration is below the minimum (1800 seconds / 30 minutes).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "increase_timelock",
        description:
          "Set timelock_duration to at least 1800 seconds (30 minutes).",
      },
    ],
  },
  6052: {
    name: "PolicyVersionMismatch",
    message:
      "Policy version changed since agent's last RPC read. Re-resolve vault state and retry.",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 1000,
    recovery_actions: [
      {
        action: "re_resolve_state",
        description:
          "Re-fetch vault state via resolveVaultState() to get current policy version, then retry.",
      },
    ],
  },
  6053: {
    name: "ActiveSessionsExist",
    message:
      "Cannot close vault with active sessions. Finalize all pending sessions first.",
    category: "POLICY_VIOLATION",
    retryable: true,
    retry_after_ms: 10000,
    recovery_actions: [
      {
        action: "finalize_sessions",
        description:
          "Wait for active sessions to finalize or expire, then retry close_vault.",
      },
    ],
  },

  // --- Post-execution assertions (Phase B scaffolding) ---
  6054: {
    name: "PostAssertionFailed",
    message:
      "Post-execution assertion failed: account state did not satisfy constraint.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "review_assertions",
        description:
          "Review the vault's post-execution assertions. The trade's resulting account state violated a configured assertion.",
      },
    ],
  },
  6055: {
    name: "InvalidPostAssertionIndex",
    message: "Post-assertion references an invalid instruction index.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_assertions",
        description:
          "Review and update the vault's post-assertion configuration.",
      },
    ],
  },
  6056: {
    name: "UnauthorizedPreValidateInstruction",
    message:
      "Non-infrastructure instruction detected before validate_and_authorize.",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_instruction_order",
        description:
          "Place validate_and_authorize before any DeFi or program instruction.",
      },
    ],
  },
  6057: {
    name: "SnapshotNotCaptured",
    message:
      "Delta assertion snapshot was not captured in validate_and_authorize.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_assertions",
        description:
          "Ensure validate_and_authorize captures a snapshot before finalize delta check.",
      },
    ],
  },
  6058: {
    name: "InvalidConstraintOperator",
    message:
      "Constraint operator value is not a valid ConstraintOperator discriminant.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_constraints",
        description: "Ensure constraint operators are valid (0-6).",
      },
    ],
  },
  6059: {
    name: "ZeroCopyVaultMismatch",
    message: "Zero-copy constraints account has wrong vault.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_pda",
        description: "The constraints PDA does not belong to this vault.",
      },
    ],
  },

  // F-10 audit fix: durable-nonce pre-signing defense (extended Bucket-3
  // 2026-05-23 to cover the 2 timelocked-admin PDAs via the wider
  // MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN ceiling)
  6060: {
    name: "QueuedUpdateExpired",
    message:
      "Queued update is too old (>MAX_APPLY_AGE_SLOTS / >MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN) — re-queue to apply. Defends against durable-nonce pre-signing.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "requeue",
        description:
          "Re-queue the update via the matching ix for your flow: queue_policy_update / queue_constraints_update / queue_close_constraints / queue_agent_permissions_update / queue_agent_grant / initiate_ownership_transfer — the original queued update is past the freshness window.",
      },
    ],
  },
  6061: {
    name: "AccountWritabilityMismatch",
    message:
      "Account writability flag does not match the constraint requirement (read-only vs writable).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_constraints",
        description:
          "Match the writability flag (read-only or writable) of the account passed to the instruction with the constraint's is_writable_required value.",
      },
    ],
  },

  // M11 SIMD-0296 pad-attack DoS guard
  6062: {
    name: "SysvarScanBoundExceeded",
    message:
      "Sysvar instruction scan exceeded the per-tx safety bound (MAX_SYSVAR_SCAN_ITERATIONS=64).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_transaction_shape",
        description:
          "Reduce the number of instructions in the transaction. The on-chain sysvar walk is bounded at 64 ix to defend against pad-attack DoS (M11 / SIMD-0296). Legitimate flows fit well under this cap.",
      },
    ],
  },

  // C4 audit fix: async-fulfillment program deny
  6063: {
    name: "AsyncFulfillmentNotPermitted",
    message:
      "Async-fulfillment programs (Jupiter Perps, Drift v2, Drift JIT) are not permitted in V1 — keeper-driven settlement happens after finalize_session returns and cannot be measured against the spending cap.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "Use a synchronous protocol (Jupiter swap, Jupiter Lend, etc.). V1.1 will add a sanctioned async-friendly path with settlement-tracked counters or post-execution attestation.",
      },
    ],
  },

  // PR 7: Token-2022 opcode blocks (M3 + Pentester HIGH/MED + third-pass audit)
  6064: {
    name: "ConfidentialTransferBlocked",
    message:
      "Token-2022 ConfidentialTransfer is not permitted between validate_and_authorize and finalize_session.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "Token-2022 ConfidentialTransfer (opcode 27/42) hides spending amounts from sysvar accounting and cannot be tracked. Use the standard SPL Token transfer or Jupiter swap path instead.",
      },
    ],
  },
  6065: {
    name: "PermanentDelegateBlocked",
    message:
      "Token-2022 PermanentDelegate is not permitted between validate_and_authorize and finalize_session.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "Token-2022 PermanentDelegate (opcode 35) installs a session-bound delegate that survives finalize. Reject up-front; use a per-tx Approve instead.",
      },
    ],
  },
  6066: {
    name: "TransferHookBlocked",
    message:
      "Token-2022 TransferHook is not permitted between validate_and_authorize and finalize_session.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "Token-2022 TransferHook (opcode 36) routes mid-tx control to attacker-chosen code. Use a non-hook mint or whitelist the hook program in V1.1.",
      },
    ],
  },
  6067: {
    name: "LamportDrainBlocked",
    message:
      "Token-2022 destructive-balance instruction (opcode 38/45/46) is not permitted between validate_and_authorize and finalize_session.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "WithdrawExcessLamports/UnwrapLamports/PermissionedBurnExtension drain SOL or balances outside the spending-cap path. Block at the gate; V1.1 may add an owner-allowlist for legitimate uses.",
      },
    ],
  },
  6068: {
    name: "BatchInstructionBlocked",
    message:
      "Token-2022 Batch instruction (opcode 255) is blocked outright — wraps inner instructions and bypasses the byte-0 blocklist.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_protocol",
        description:
          "Token-2022 Batch (opcode 255) wraps inner TokenInstructions; the byte-0 blocklist cannot see them. Submit each inner ix as its own top-level instruction so guards can inspect each.",
      },
    ],
  },
  // F-4 audit fix: explicit destination_mode. Phase 2 Option A tightens to
  // 0 = RESTRICTED only — OPEN_WITH_CAP path deleted.
  6069: {
    name: "InvalidDestinationMode",
    message: "Invalid destination mode (must be 0 = RESTRICTED).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_policy",
        description:
          "Pass destination_mode = 0 (RESTRICTED). Phase 2 deleted the permissive OPEN_WITH_CAP path.",
      },
    ],
  },
  // Phase 2 TA-04: reserved AgentEntry.capability values 3..=255 reject.
  6070: {
    name: "InvalidCapability",
    message:
      "Invalid agent capability value (must be 0 = Disabled, 1 = Observer, or 2 = Operator).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_policy",
        description:
          "Pass capability = 0, 1, or 2. Reserved values 3..=255 are explicitly rejected by register_agent / queue_agent_permissions_update / apply_agent_permissions_update.",
      },
    ],
  },
  // Phase 2 TA-19: policy_preview_digest mismatch — owner blind-sign defense.
  6071: {
    name: "PolicyPreviewMismatch",
    message:
      "Policy preview digest mismatch — caller's signed digest differs from recomputed canonical digest.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "recompute_digest",
        description:
          "Recompute the policy preview digest via computePolicyPreviewDigest() against the actual policy fields and resubmit. Likely cause: owner signed a digest produced from stale fields, or a pending PDA was tampered with between queue and apply.",
      },
    ],
  },
  // Phase 2 TA-19: observe_only mode rejects all validate_and_authorize calls.
  6072: {
    name: "ObserveOnlyModeBlocksExecute",
    message:
      "Vault is in observe_only mode — validate_and_authorize is blocked.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "switch_vault_mode",
        description:
          "Owner must queue + apply a policy update to flip observe_only off (or create a separate vault without observe_only set).",
      },
    ],
  },
  // Phase 2 F-11: active vault (observe_only=false) requires at least one
  // entry on the protocol allowlist OR destination allowlist. An empty
  // allowlist would leave the vault silently inert.
  6073: {
    name: "ActiveVaultRequiresAllowlist",
    message:
      "Active vault (observe_only=false) requires at least one protocol or destination on its allowlist.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "add_allowlist_entry",
        description:
          "Either add at least one program to `protocols`, at least one wallet to `allowed_destinations`, or pass `observe_only=true` (intentional inert vault).",
      },
    ],
  },
  // ─── Phase 3 pre-execution guards (TA-03/05/06/07/08/09/17) ───────────────
  // 6083-6090 codes added by Phase 3 — each is an on-chain policy-violation
  // surface that the SDK surfaces to dashboard / agent consumers.
  6074: {
    name: "ErrMintNotPinned",
    message:
      "Deposit mint is not on the build-time stablecoin allowlist (USDC + USDT). Reject prevents exotic / typosquatted mints from being parked in the vault.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_pinned_stablecoin",
        description:
          "Re-issue the deposit using the USDC or USDT mint. Other tokens are not accepted by the vault.",
      },
    ],
  },
  6075: {
    name: "ErrOutsideOperatingHours",
    message:
      "Current UTC hour is outside the policy's operating_hours bitmask. The vault is configured to spend only during specific UTC hours.",
    category: "POLICY_VIOLATION",
    retryable: true,
    recovery_actions: [
      {
        action: "retry_in_window",
        description:
          "Wait until a UTC hour permitted by the policy's operating_hours bitmask, or have the owner widen the mask via queue_policy_update.",
      },
    ],
  },
  6076: {
    name: "ErrCooldownActive",
    message:
      "Agent cooldown has not elapsed since the last successful action. Per-agent cooldown is configured by the owner.",
    category: "POLICY_VIOLATION",
    retryable: true,
    recovery_actions: [
      {
        action: "wait_cooldown",
        description:
          "Wait until the per-agent cooldown (in seconds) has elapsed since the agent's last successful action.",
      },
    ],
  },
  6077: {
    name: "ErrGraylistFriction",
    message:
      "Destination is on the graylist — a 24h friction window applied to newly-added allowlist destinations. Promote via promote_graylist_destination or wait for unlock.",
    category: "POLICY_VIOLATION",
    retryable: true,
    recovery_actions: [
      {
        action: "wait_or_promote",
        description:
          "Owner can promote the destination to active via promote_graylist_destination, or wait the remaining time until automatic unlock.",
      },
    ],
  },
  6078: {
    name: "ErrGraylistFull",
    message:
      "Graylist bound exceeded (max 10 entries). Wait for an existing entry to unlock or promote.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "promote_or_wait",
        description:
          "Promote at least one graylist entry to active or wait for unlock. Then re-issue the destination-allowlist add.",
      },
    ],
  },
  6079: {
    name: "ErrToken2022ExtensionForbidden",
    message:
      "Token-2022 mint has a forbidden extension. Only MemoTransfer and MetadataPointer extensions are permitted at deposit.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_supported_mint",
        description:
          "Use a Token-2022 mint with no extensions, or one limited to MemoTransfer/MetadataPointer.",
      },
    ],
  },
  6080: {
    name: "ErrCosignRequired",
    // §RP-2 M-NEW-3 (audit 2026-05-19): after P0.1 + H-NEW-1, 6080
    // fires from four sites — queue_policy_update (original elevated
    // mutation path), register_agent, set_observe_only(false→true),
    // and unpause_agent. The message + recovery now reflect that the
    // common axis is "cosign-opted-in vault + owner action lacking a
    // non-owner co-signer", not just queue_policy_update specifically.
    message:
      "Cosign-opted-in vault requires a non-owner signer for this owner-action. Original sites: queue_policy_update (elevated), register_agent, set_observe_only(false→true), unpause_agent.",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "supply_cosigner",
        description:
          "Supply the cosign session pubkey as a signer in remaining_accounts. For queue_policy_update, also pass cosign_session as an arg. The cosign session must not be the owner's own key.",
      },
    ],
  },
  6081: {
    name: "ErrAutoRevoked",
    message:
      "Agent capability was auto-revoked after consecutive policy-violation failures. Owner must re-enable via queue_agent_permissions_update.",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "owner_reenable",
        description:
          "Owner queues a fresh queue_agent_permissions_update setting the agent's capability back to Observer or Operator.",
      },
    ],
  },
  // Phase 4 — Bundle integrity (TA-10 + TA-11 + AC-10)
  6082: {
    name: "ErrSandwichIntegrity",
    message:
      "Bundle integrity violation: multiple validate_and_authorize instructions for the same (vault, agent, mint) tuple in one transaction. At most one is permitted (TA-10 hardening).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "rebuild_bundle",
        description:
          "Rebuild the transaction with exactly one validate_and_authorize per (vault, agent, mint) tuple. ComputeBudget and SystemProgram instructions may be interleaved.",
      },
    ],
  },
  6083: {
    name: "ErrProtectedWritable",
    message:
      "A Sigil-owned PDA was passed as writable to a foreign instruction between validate and finalize (TA-11). Protected PDAs include vault, policy, tracker, session, post_assertions, audit, constraints, and overlay accounts.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "remove_protected_pda_writable",
        description:
          "Remove the writable flag on any Sigil PDA passed to the DeFi instruction, or remove the PDA from that instruction's account metas entirely. Sigil PDAs may still be read by foreign instructions (writable=false is allowed).",
      },
    ],
  },
  6084: {
    name: "ErrSessionNonceMismatch",
    message:
      "Session nonce mismatch (AC-10 durable-nonce replay defense). The caller's expected_nonce does not match the session's stored nonce. For a fresh session, pass expected_nonce = 0.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fresh_session_nonce",
        description:
          "Pass expected_nonce = 0 for a fresh validate_and_authorize. A non-zero value is only valid in Phase 8 ownership-transfer flow (M-5).",
      },
    ],
  },

  // ─── Phase 5: post-execution invariants (TA-12 + TA-13 + TA-14) ───
  // §RP-1 V5: added Phase 5 mappings missing from the SDK error table.
  // Source of truth: programs/sigil/src/errors.rs:407-451 + IDL.

  /** 6085 — TA-12: combined USDC+USDT vault balance dropped below the
   * owner-configured `policy.stable_balance_floor`. The HARD reserve —
   * no combination of attacks (CPI drain, per-protocol cap bypass, fee
   * inflation) may drain the vault below this line. Asserted in both
   * `finalize_session` and `agent_transfer` after the CPI completes.
   */
  6085: {
    name: "ErrStableFloorViolation",
    message:
      "Stable balance floor violated — combined USDC+USDT balance dropped below policy.stable_balance_floor",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the transfer amount so the post-execution combined USDC+USDT vault balance stays at or above policy.stable_balance_floor",
      },
      {
        action: "deposit_more",
        description:
          "Owner can deposit additional USDC or USDT to raise the combined balance above the floor before the agent retries",
      },
      {
        action: "lower_floor",
        description:
          "Owner can queue a policy update to lower stable_balance_floor (timelock-gated, owner-only)",
      },
    ],
  },

  /** 6095 — TA-13: per-protocol daily cap exceeded. The owner-configured
   * `policy.protocol_caps[i]` rolling-24h cap for the protocol the agent
   * is invoking would be exceeded by this transaction. Distinct from
   * 6047 (ProtocolCapExceeded), which now signals slot-allocation
   * exhaustion only — see §RP-1 V5 disposition.
   */
  6086: {
    name: "ErrDailyCapExceeded",
    message: "Per-protocol daily spending cap would be exceeded (rolling 24h)",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the amount to fit within this protocol's remaining 24h rolling-window cap",
      },
      {
        action: "use_different_protocol",
        description:
          "Route through a different allowlisted protocol that has remaining 24h capacity",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity for this protocol",
      },
    ],
  },

  /** 6096 — TA-14: per-recipient daily cap exceeded. The recipient's
   * rolling-24h outflow would breach `policy.per_recipient_daily_cap_usd`.
   * Resolved via SPL TokenAccount.owner (the WALLET that holds the
   * destination ATA), NOT the meta pubkey. Eviction is age-based, never
   * LRU — array-full with no expired slot returns this code too,
   * preventing churn-eviction bypass.
   *
   * **H-10 (pre-redeploy audit 2026-05-21) — TRIPLE-CAUSE DISAMBIGUATION:**
   * The same code (6096) fires from THREE distinct branches inside
   * `programs/sigil/src/instructions/finalize_session.rs`:
   *
   *   1. **Cap exceeded** (`finalize_session.rs:654`): cumulative 24h
   *      recipient outflow + this transfer > policy cap. Recovery: shrink
   *      the amount, route via a different allowed recipient with cap
   *      headroom, or wait for the rolling window to release capacity.
   *   2. **Multiple distinct recipients in one tx** (`finalize_session.rs:638`):
   *      V1 enforces single-recipient-per-tx for per-recipient cap
   *      attribution sanity. Recovery: SPLIT the bundle so each finalize
   *      touches at most one allowlisted recipient
   *      (`split_into_separate_transactions`).
   *   3. **`per_recipient` array full with no expired slot**
   *      (`finalize_session.rs:658` via `tracker.record_recipient_spend`):
   *      the fixed-size 10-slot tracker has no entry eligible for
   *      age-based eviction. Recovery: wait for an entry to age out
   *      (same `wait` action as cause 1).
   *
   * UX-side: callers cannot distinguish the three branches from the
   * error code alone — the recovery list below covers all three.
   */
  6087: {
    name: "ErrRecipientCapExceeded",
    message:
      "Per-recipient cap blocked — three possible causes: (a) recipient outflow would breach policy.per_recipient_daily_cap_usd within rolling 24h window; (b) bundle touches multiple distinct allowlisted recipients in one finalize (V1 single-recipient-per-tx rule); (c) per_recipient tracker array full with no expired slot to evict",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the transfer amount so the recipient's 24h rolling outflow stays under policy.per_recipient_daily_cap_usd",
      },
      {
        action: "split_into_separate_transactions",
        description:
          "If the bundle touches multiple distinct allowlisted recipients in one finalize, split it so each transaction touches at most one recipient. V1 enforces single-recipient-per-tx for per-recipient cap attribution.",
      },
      {
        action: "use_different_recipient",
        description:
          "Route the transfer to a different allowed destination that has remaining 24h cap headroom",
      },
      {
        action: "wait",
        description:
          "Wait for the recipient's rolling 24h window to release spent capacity (also remediates the array-full / no-evictable-slot case)",
      },
    ],
  },

  // ─── Phase 6: Maestro borrows R-1/R-2/R-3/R-4 (TA-13 absorption) ───
  // §RP-2 H-NEW-2: added Phase 6 mappings (R-1..R-4) — the predicate already
  // routes them as "Sigil error" via the >= 6000 && <= SIGIL_ON_CHAIN_ERROR_MAX
  // bound, but ON_CHAIN_ERROR_MAP had no entries, so users got "Unknown
  // on-chain error code N" with category FATAL + empty recovery.
  // Source of truth: programs/sigil/src/errors.rs + IDL.

  /** 6097 — R-1 MintDeltaCap (attack signal): combined balance of
   * vault-owned ATAs for the configured mint dropped by more than
   * `max_net_decrease` between `validate_and_authorize` (pre-snap sum)
   * and `finalize_session` (post sum). Two enforcement shapes:
   * scope=0 (vault-wide multi-ATA sum) and scope=1 (single target_account).
   * Pairs with R-2 (6099) per F-18 to close close-and-recreate evasion.
   */
  6088: {
    name: "ErrMintDeltaCapExceeded",
    message:
      "Mint delta cap exceeded — net outflow of [mint] from vault exceeded policy.mint_delta_cap[mint] within the post-execution check window.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_post_assertions",
        description:
          "Verify the policy.post_assertions configuration for the affected mint. Reduce transaction outflow or raise the per-mint cap via queue_policy_update (timelock-gated).",
      },
    ],
  },

  /** 6098 — R-1 MintDeltaCap (caller-bug signal): entry's accounts
   * couldn't be resolved at validate time. Common shapes:
   *   - scope=1 and target_account not present in remaining_accounts
   *   - target_account's mint field doesn't match the configured mint
   *   - target_account isn't owned by the vault
   *   - scope=0 with no derived ATAs supplied in remaining_accounts
   * Distinct from ErrMintDeltaCapExceeded because this is a
   * configuration or caller-side bug (recoverable by fixing the caller),
   * not an attack signal (which fires 6097 at finalize).
   */
  6089: {
    name: "MintDeltaCapMisconfigured",
    message:
      "Mint delta cap entry misconfigured — invalid scope value, zero max_net_decrease, or required derived ATA missing from remaining_accounts.",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "inspect_entry_config",
        description:
          "Inspect the failed entry's scope value (0 or 1 only), max_net_decrease (must be non-zero for scope=0), and remaining_accounts (must include every derived ATA for scope=0).",
      },
    ],
  },

  /** 6099 — R-2 AtaAuthorityPin (attack signal): a vault-owned token
   * account had its authority changed during the sandwich, or was
   * closed and not reinstated as a vault-owned account before finalize.
   * Detected by reading bytes 32..64 of the post-CPI token account data
   * and comparing to `vault.key().to_bytes()`. Also fires when the
   * account is closed (data length < 64) or its owner program is no
   * longer SPL Token or Token-2022. Pairs with 6097 to close F-18
   * close+drain+recreate.
   */
  6090: {
    name: "ErrAtaAuthorityChanged",
    message:
      "Vault ATA authority changed mid-transaction — a CPI altered the SPL TokenAccount owner field, defeating the vault's custody.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "audit_ix_for_set_authority",
        description:
          "Verify the DeFi instruction in the bundle does not call setAuthority on any vault-owned ATA. Refuse the bundle and audit the agent's request.",
      },
    ],
  },

  /** 6100 — R-3 OutputBalanceFloor (attack signal): a token account
   * that was supposed to receive at least `min_increase` units of its
   * mint during the sandwich did not. Snapshot at
   * `validate_and_authorize` against `target_account.amount` (u64 LE at
   * bytes 64..72), finalize requires (post - pre) >= aux_value.
   * Counter to "dust-fill" attacks where the agent obtains delegation
   * authority then runs a swap that returns 1 lamport.
   */
  6091: {
    name: "ErrOutputBelowFloor",
    message:
      "Output balance floor violated — the vault's target ATA gained less than policy.min_increase_usd after the post-execution check.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "audit_output_value",
        description:
          "Verify the DeFi instruction's output. Common causes: dust-fill swap, partial fill, wrong destination meta. Audit the agent's slippage settings.",
      },
    ],
  },

  /** 6101 — R-4 DeclarationConsistency (attack signal): the
   * (recipient, mint) pair declared on a post-assertion entry doesn't
   * match the SPL token account at the configured CPI account-meta
   * index. Closes the "declaration dishonesty" attack: agent declares
   * "recipient: alice" to satisfy a destination-allowlist check, then
   * inserts attacker_ata into the CPI metas. The recipient who would
   * receive funds (attacker_ata.owner) ≠ alice, so R-4 rejects.
   */
  6092: {
    name: "ErrDeclarationInconsistent",
    message:
      "Declaration consistency check failed — the CPI account meta at the declared index is not a token account matching the agent's declared recipient + mint.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_declaration_matches_ix",
        description:
          "Verify the agent's authorized_token + output_mint declaration matches the actual SPL TokenAccount at the declared meta index in the DeFi instruction. Reject the bundle if the agent supplied inconsistent declaration.",
      },
    ],
  },

  // ─── Audit 2026-05-19 (P1 HIGH fixes) ───
  // §RP-2 H-NEW-2: H-1 hard-reject mapping for the destination-check
  // meta budget. Previously the helper silently take()-truncated at 16;
  // 1f569eb made it a hard-reject (POLICY_VIOLATION).

  /** 6102 — H-1 hard-reject (audit 2026-05-19): the foreign DeFi
   * instruction passed more account metas than
   * `MAX_DESTINATION_CHECK_METAS_PER_IX` (16). Previously the helper
   * silently `take()`-truncated at the bound, leaving slots 17+
   * uninspected; an attacker hiding a hostile destination at slot 17+
   * would bypass the allowlist check. Hard-reject closes the
   * silent-drop. Expansion to 32 metas is v1.1 backlog (~+4K CU).
   */
  6093: {
    name: "IxMetaCountExceeded",
    message:
      "Foreign instruction exceeded the account-meta processing budget (destination check: max 24 writable metas / 64 total; agent_transfer floor-walk: 16). The bundle is rejected rather than partially inspected.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_a_shorter_route",
        description:
          "The route references more writable accounts than the guard can inspect in one pass. Use a shorter Jupiter route; Sigil never reshapes the route itself — an unguardable route atomically reverts.",
      },
    ],
  },
  // --- Phase 8 (ownership transfer + freeze hardening) ---
  // Phase 8 ownership-transfer + freeze-hardening codes (now 6094-6099 post M1-04).
  6094: {
    name: "ErrPendingOwnershipExists",
    message:
      "An ownership transfer is already pending for this vault. Cancel the existing transfer before queueing a new target.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "cancel_ownership_transfer",
        description:
          "Call cancel_ownership_transfer to release the pending PDA before queueing a new transfer.",
      },
    ],
  },
  6095: {
    name: "ErrPendingOwnershipNotReady",
    message:
      "Ownership transfer timelock has not elapsed yet (default 48h). The new owner cannot accept until the window passes.",
    category: "TRANSIENT",
    retryable: true,
    recovery_actions: [
      {
        action: "wait_timelock",
        description:
          "Wait for the timelock window to elapse. The owner can cancel during this window to abort the transfer.",
      },
    ],
  },
  6096: {
    name: "ErrInvalidFreezeReason",
    message:
      "Invalid freeze_reason byte (must be 0=Manual, 1=AutoRevoke, or 2=EmergencyBoard).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_freeze_reason",
        description:
          "Re-call freeze_vault with a valid FreezeReason discriminant.",
      },
    ],
  },
  6097: {
    name: "ErrReactivateCooldownActive",
    message:
      "Reactivate requires a 5-minute observation cooldown after the vault was frozen. Try again after the cooldown elapses.",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 300_000,
    recovery_actions: [
      {
        action: "wait_cooldown",
        description:
          "Wait for the 5-minute observation window to elapse before reactivating.",
      },
    ],
  },
  6098: {
    name: "ErrInvalidOwnershipTarget",
    message:
      "new_owner cannot be a system/program/sysvar address (would permanently brick the vault).",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_signer_pubkey",
        description:
          "Pass an EOA pubkey or Squads V4 vault PDA as new_owner — not SystemProgram, the program ID, or a sysvar.",
      },
    ],
  },
  6099: {
    name: "ErrTooManyRevokePairs",
    message:
      "freeze_internal received more than MAX_REVOKE_PAIRS (10) session/token pairs in remaining_accounts.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "split_revoke_batch",
        description:
          "Split the (session_pda, token_account) pairs across multiple freeze_internal calls.",
      },
    ],
  },
  // H-3 close (pre-redeploy audit 2026-05-21): close_vault rejects if
  // policy.has_post_assertions != 0 because the 672-byte PostExecutionAssertions
  // zero-copy PDA must be drained via close_post_assertions first; otherwise it
  // would be orphaned on close.
  6100: {
    name: "ErrPostAssertionsNotClosed",
    message:
      "PostExecutionAssertions PDA still active — call close_post_assertions before close_vault.",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "close_post_assertions",
        description:
          "Invoke the close_post_assertions instruction to drain the 672-byte PostExecutionAssertions PDA, then retry close_vault.",
      },
    ],
  },
  // H-4 close (pre-redeploy audit 2026-05-21, Bucket 1): queue_policy_update
  // rejects if any allowed_destinations entry is the address of a Sigil-owned
  // protected PDA for this vault. Closes the owner-self-foot-gun where a
  // phished owner allowlists a Sigil PDA, enabling an agent to lock funds
  // at the PDA via a token transfer.
  6101: {
    name: "ErrDestinationIsProtectedPda",
    message:
      "allowed_destinations entry is a Sigil-protected PDA — owner attempted to allowlist a vault/policy/pending_* PDA.",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "remove_protected_pda_from_destinations",
        description:
          "Remove any pubkey from allowed_destinations that matches a Sigil-protected PDA for this vault. Use a plain EOA or external program owner instead.",
      },
    ],
  },
  // D-1 + D-6 close (Bucket 2 audit 2026-05-21): AL3 on-chain scalar intent-
  // digest mismatch. The wallet's preview-time digest doesn't match the
  // digest the on-chain verifier recomputed from validate_and_authorize's
  // args. Most likely: man-in-the-middle (compromised agent / browser ext)
  // swapped one of the scalar fields (mint, amount, target_protocol)
  // between preview and submit. Less likely: cross-network replay
  // (mainnet digest sent through a devnet program).
  6102: {
    name: "ErrIntentDigestMismatch",
    message:
      "AL3 intent-digest mismatch — wallet preview digest does not match the executed bundle's scalars.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "rebuild_seal_from_fresh_preview",
        description:
          "Re-run the wallet preview to refresh the intent digest, then resubmit. If the mismatch persists after a fresh preview, suspect a compromised middleware/agent — pause the agent and investigate.",
      },
    ],
  },
  // M-5 close (Bucket 2 audit 2026-05-21, PEN-CROSS-3): apply_agent_grant
  // rejected because the recomputed digest of PendingAgentGrant content
  // doesn't match the queue-time digest. Same digest-binding defense class
  // as the policy/ownership pending-update digest checks.
  6103: {
    name: "ErrPendingAgentGrantDigestMismatch",
    message:
      "PendingAgentGrant content tampered between queue and apply — digest mismatch.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "cancel_and_requeue_agent_grant",
        description:
          "Cancel the pending grant via cancel_agent_grant, then queue a fresh grant with the intended agent + capability.",
      },
    ],
  },
  // D-5 close (Bucket 2 audit 2026-05-21, F-RP3-1): reactivate_vault
  // rejected a FULL_CAPABILITY agent graft because no non-owner signer was
  // present. Defaults-on safety (NH-1): any FULL_CAPABILITY grant on
  // reactivate requires a second signer, regardless of whether
  // policy.cosign_session_pubkey was pre-configured. Closes the phished-
  // owner freeze→reactivate(attacker, FULL) single-signature foot-gun.
  6104: {
    name: "ErrReactivateCosignRequiredForFullCapability",
    message:
      "Reactivate with a FULL_CAPABILITY new agent requires a non-owner cosigner.",
    category: "ESCALATION_REQUIRED",
    retryable: false,
    recovery_actions: [
      {
        action: "include_second_signer_in_remaining_accounts",
        description:
          "Re-sign the reactivate transaction with a second non-owner signer in remaining_accounts. If policy.cosign_session_pubkey is set, the signer must match it.",
      },
    ],
  },
  6105: {
    name: "DestinationAccountUnresolvable",
    message:
      "A writable account of the DeFi instruction could not be resolved in validate's remaining_accounts, so the guard cannot classify it (F-Q1a destination completeness — rejected fail-closed rather than silently skipped).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_seal_to_populate_remaining_accounts",
        description:
          "Build the bundle with seal(), which auto-populates validate's (and finalize's) remaining_accounts with every writable account of the DeFi instruction (the fee-payer agent included). Hand-built bundles must mirror this.",
      },
    ],
  },
  6106: {
    name: "ErrToken2022OutputMintUnresolvable",
    message:
      "A vault-owned Token-2022 token account's mint could not be resolved in validate's remaining_accounts (or the supplied account is not Token-2022-owned), so the guard cannot vet its extensions (F-Q4 — rejected fail-closed). A PermanentDelegate / TransferHook / ConfidentialTransfer mint must be vetted before the vault may acquire the token.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_seal_to_populate_remaining_accounts",
        description:
          "Build the bundle with seal(), which auto-resolves vault-owned Token-2022 output mints (reading each writable account's mint on-chain) and feeds them into validate's remaining_accounts. Hand-built bundles must include the mint account of every vault-owned Token-2022 token account the swap writes.",
      },
    ],
  },
  6107: {
    name: "ErrOperatorGrantRequiresTimelock",
    message:
      "An OPERATOR-class agent grant cannot be seated instantly on this vault (single-key, cosign-required-but-unbound, or any vault with a configured operator_grant_delay_seconds > 0). It must route through the timelocked queue_agent_grant → apply_agent_grant path — the time-delay substitutes for the missing 2nd authorization factor (F-Q6).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_queue_agent_grant",
        description:
          "Seat the OPERATOR via queue_agent_grant, wait the effective delay (>=10 min for a single-key vault, else the configured operator_grant_delay_seconds), then apply_agent_grant. A cosign-bound vault at zero delay can seat instantly by including the bound cosigner's signature in register_agent.",
      },
    ],
  },
  6108: {
    name: "ErrOperatorGrantDelayTooLong",
    message:
      "operator_grant_delay_seconds exceeds the maximum (48h / 172800s). A larger delay could exceed the apply-time freshness ceiling and leave a queued OPERATOR grant permanently unapplyable, so it is rejected at configuration time (F-Q6).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "lower_operator_grant_delay",
        description:
          "Set operator_grant_delay_seconds to at most 172800 (48h) in the queue_policy_update call.",
      },
    ],
  },
  6109: {
    name: "InvalidOwnerType",
    message:
      "vault.owner_type held a value outside the recognized discriminants (0 = EOA, 1 = multisig) at an OPERATOR-grant read site. Only reachable via on-chain state corruption (the field is program-set to {0,1}); the operation is rejected rather than acting on corrupted authority state (F-Q6).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "report_state_corruption",
        description:
          "vault.owner_type is program-set to 0 (EOA) or 1 (multisig); an out-of-range value indicates on-chain state corruption and should be unreachable in normal operation. OPERATOR-grant paths are blocked until the vault state is valid — report this.",
      },
    ],
  },
  6110: {
    name: "SpendAccountingUnderflow",
    message:
      "finalize_session detected collected fees exceeding the realized stablecoin outflow (fees_collected > total_decrease) — an accounting impossibility, since fees are CPI'd out before the DeFi leg. The transaction is rejected fail-closed rather than under-counting the spend against the caps (F-Q9).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "review_swap_construction",
        description:
          "This fires when a stablecoin-input action net-returned stablecoin so the measured outflow was smaller than the protocol+developer fees. Verify the DeFi instruction actually spends the declared stablecoin input; a net-return on the stablecoin-input path is anomalous and is rejected.",
      },
    ],
  },
  6111: {
    name: "ErrMultisigCustodyUnsupported",
    message:
      "Squads multisig ownership custody is disabled in V1. Sigil's top-level-only (reject_cpi!) model is architecturally incompatible with a Squads multisig owner — a multisig acts on external programs only by CPI from vault_transaction_execute, but every Sigil owner instruction rejects CPI, so a multisig owner could neither accept ownership nor operate the vault afterward (and the prior path could brick the vault by setting an unsignable owner). initiate_ownership_transfer rejects is_multisig_target = true; accept_ownership_transfer_multisig rejects unconditionally (H-1, audit 2026-06-11).",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_eoa_owner",
        description:
          "Use a standard EOA (single-key) owner for the vault. Multisig custody is deferred to a future release (CPI-aware or Sigil-native M-of-N) pending re-audit.",
      },
    ],
  },
  6112: {
    name: "ErrOutputNotVaultOwned",
    message:
      "M1: stablecoin-input swap output must land in a vault-owned account and increase (value redirection / unacquired spend rejected). The acquiring swap either redirected its output to a non-vault account or spent without acquiring anything back.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "declare_output_swap_mint",
        description:
          "Declare the acquired mint via seal()'s `outputSwapMint` so the SDK pins the vault-owned output ATA, and ensure the swap delivers the acquired token into that vault account (not the agent's). The on-chain gate requires the pinned output to be vault-owned and to strictly increase.",
      },
    ],
  },
  6113: {
    name: "ErrFinalizeMetaUnresolvable",
    message:
      "Finalize completeness (F-Q1b): a writable DeFi account meta present at validate was omitted from finalize, which would dodge the per-recipient cap and output attribution. The composed transaction is malformed.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "pass_all_writable_defi_accounts_to_finalize",
        description:
          "seal() already feeds finalize the same writable DeFi accounts it feeds validate, so this only fires for a hand-built (non-seal) transaction. Pass every writable, non-vault account of the DeFi instruction into finalize_session's accounts.",
      },
    ],
  },
  6114: {
    name: "ErrDeFiInstructionNotAdjacentToFinalize",
    message:
      "The DeFi instruction must sit immediately before finalize_session in the transaction — no ComputeBudget/System or other instruction between them. The seal() SDK always composes the sandwich this way; this only fires for a hand-built transaction that interleaves an instruction before finalize.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "place_finalize_immediately_after_the_defi_instruction",
        description:
          "Reorder the transaction so finalize_session immediately follows the single DeFi instruction. Put any ComputeBudget/System instructions before validate_and_authorize, not between the DeFi instruction and finalize.",
      },
    ],
  },
  6115: {
    name: "ErrUnmeasurableSpend",
    message:
      "The spending session produced no measurable in-transaction vault outcome — no stablecoin moved out of the vault and no vault-owned acquisition increased. This is an async/keeper-settled venue (its real transfer lands in a later block), a CPI-deferred or request-mode action, or a no-op. Recording it would let the spend escape the caps, so it is rejected.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_a_synchronously_settling_action",
        description:
          "Use an action whose value movement settles in this same transaction — either a stablecoin spend Sigil can measure, or an acquiring swap that lands the acquired token in a vault-owned account (declare it via seal()'s outputSwapMint). Request/keeper-fulfillment actions that settle in a later block are not supported on the spending path.",
      },
    ],
  },
  // Item 3 (verified-build gate, 2026-06-22): the target protocol has an
  // owner-pinned ELF hash (PolicyConfig.protocol_hashes), but the gate could not
  // resolve the program's BPFLoaderUpgradeable ProgramData account to recompute
  // the hash — it was absent from remaining_accounts, not owned by the
  // upgradeable loader, or too small to hold an ELF. Fail-closed.
  6116: {
    name: "ErrProgramDataUnresolvable",
    message:
      "The target protocol has an owner-pinned verified-build hash, but its BPFLoaderUpgradeable ProgramData account could not be resolved to recompute the build hash. The gate fails closed rather than skipping the check.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "supply_the_target_program_data_account",
        description:
          "Include the target protocol's ProgramData account (find_program_address([programId], BPFLoaderUpgradeable)) in the transaction's remaining accounts. The SDK seal() satisfier appends it automatically when a build hash is armed — ensure the target is an upgradeable program and is being passed through.",
      },
    ],
  },
  // Item 3 (verified-build gate, 2026-06-22): the target protocol's currently
  // deployed ELF does NOT hash to the owner-pinned value — the program was
  // upgraded since the owner attested it (the upgrade-TOCTOU the gate closes).
  6117: {
    name: "ErrProgramBuildMismatch",
    message:
      "The target protocol's deployed program build no longer matches the owner-attested verified-build hash (PolicyConfig.protocol_hashes). The program was upgraded since it was pinned; authorization is rejected to close the upgrade-TOCTOU.",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "re_pin_or_disarm_the_build_hash",
        description:
          "If the upgrade is legitimate and audited, re-pin the new build hash via queue_policy_update (getProgramDataHash recomputes it). To stop enforcing the gate for this protocol, disarm it (set its entry to all-zero) — note that disarming is an elevated mutation on a cosign-required vault.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// SDK error codes (7000-7033) — numeric to match agent error code pattern
// ---------------------------------------------------------------------------

// Exported so dashboard/errors.ts can build a reverse (name → code) lookup
// and preserve DxError.code fidelity when toAgentError returns a string
// code like "RPC_ERROR" instead of a numeric on-chain code.
export const SDK_ERROR_CODES: Record<number, string> = {
  7000: "NETWORK_ERROR",
  7001: "RPC_ERROR",
  7002: "SIMULATION_FAILED",
  7003: "DRAIN_DETECTED",
  7004: "INTENT_VALIDATION_FAILED",
  7005: "INTENT_EXPIRED",
  7006: "PROTOCOL_NOT_SUPPORTED",
  7007: "ADAPTER_VERIFICATION_FAILED",
  7008: "PRECHECK_FAILED",
  7009: "EXECUTION_FAILED",
  7010: "TRANSACTION_TIMEOUT",
  7011: "CONFIRMATION_TIMEOUT",
  7012: "INSUFFICIENT_FUNDS",
  7013: "SLIPPAGE_EXCEEDED",
  7014: "TEE_VERIFICATION_FAILED",
  7015: "SHIELD_DENIED",
  7016: "SIMULATION_TIMEOUT",
  7017: "BLOCKHASH_EXPIRED",
  7018: "CODAMA_DECODE_FAILED",
  7019: "CODAMA_VERSION_MISMATCH",
  7020: "COMPAT_BRIDGE_FAILED",
  7021: "INTENT_DRIFT_DETECTED",
  7022: "VELOCITY_EXCEEDED",
  7023: "AGENT_DEFENSE_TRIGGERED",
  7024: "X402_PARSE_ERROR",
  7025: "X402_PAYMENT_DENIED",
  7026: "X402_UNSUPPORTED",
  7027: "X402_DESTINATION_BLOCKED",
  7028: "X402_REPLAY_DETECTED",
  7029: "X402_AMOUNT_SUSPICIOUS",
  7030: "X402_FACILITATOR_UNTRUSTED",
  7031: "X402_CONNECTION_REQUIRED",
  7032: "X402_SETTLEMENT_FAILED",
  7033: "TX_SIZE_OVERFLOW",
};

const SDK_ERRORS: Record<string, ErrorMapping> = {
  NETWORK_ERROR: {
    name: "NetworkError",
    message: "Network request failed",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 2_000,
    recovery_actions: [
      {
        action: "retry",
        description:
          "Retry the request — the RPC node may be temporarily unavailable",
      },
    ],
  },
  RPC_ERROR: {
    name: "RpcError",
    message: "Solana RPC error",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 3_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry with a different RPC endpoint if available",
      },
    ],
  },
  SIMULATION_FAILED: {
    name: "SimulationFailed",
    message: "Transaction simulation failed",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 2_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry — blockhash may have expired or state changed",
      },
      {
        action: "check_balance",
        description: "Verify the agent has enough SOL for transaction fees",
      },
    ],
  },
  DRAIN_DETECTED: {
    name: "DrainDetected",
    message: "Potential drain attack detected in transaction simulation",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "reject_transaction",
        description:
          "Transaction appears to drain vault funds — do not sign or submit",
      },
    ],
  },
  INTENT_VALIDATION_FAILED: {
    name: "IntentValidationFailed",
    message: "Intent input validation failed",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_inputs",
        description:
          "Fix the invalid parameters identified in the error context",
      },
    ],
  },
  INTENT_EXPIRED: {
    name: "IntentExpired",
    message: "Intent has expired and is no longer valid",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 1_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Create a fresh intent with updated parameters",
      },
    ],
  },
  PROTOCOL_NOT_SUPPORTED: {
    name: "ProtocolNotSupported",
    message: "Protocol is not supported by the SDK",
    category: "PROTOCOL_NOT_SUPPORTED",
    retryable: false,
    recovery_actions: [
      {
        action: "check_supported_protocols",
        description: "Check which protocols are supported by the SDK",
      },
    ],
  },
  ADAPTER_VERIFICATION_FAILED: {
    name: "AdapterVerificationFailed",
    message: "Protocol adapter output failed safety verification",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "report_adapter",
        description: "The protocol adapter may be compromised — do not retry",
      },
    ],
  },
  PRECHECK_FAILED: {
    name: "PrecheckFailed",
    message: "SDK precheck failed before submitting transaction",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_inputs",
        description: "Review the intent parameters — a precondition is not met",
      },
    ],
  },
  EXECUTION_FAILED: {
    name: "ExecutionFailed",
    message: "Transaction execution failed on-chain",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 2_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry — on-chain state may have changed during execution",
      },
    ],
  },
  TRANSACTION_TIMEOUT: {
    name: "TransactionTimeout",
    message: "Transaction submission timed out",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry with a fresh blockhash and higher priority fee",
      },
    ],
  },
  CONFIRMATION_TIMEOUT: {
    name: "ConfirmationTimeout",
    message: "Transaction confirmation timed out",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "check_status",
        description:
          "Check if the transaction landed — it may have confirmed after timeout",
      },
      {
        action: "retry",
        description: "Retry if transaction did not land",
      },
    ],
  },
  INSUFFICIENT_FUNDS: {
    name: "InsufficientFunds",
    message: "Insufficient SOL or token balance for transaction",
    category: "SPENDING_CAP",
    retryable: false,
    recovery_actions: [
      {
        action: "check_balance",
        description: "Check SOL and token balances",
      },
      {
        action: "deposit",
        description: "Deposit more funds before retrying",
      },
    ],
  },
  SLIPPAGE_EXCEEDED: {
    name: "SlippageExceeded",
    message: "Swap slippage exceeded the maximum tolerance",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 3_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry — market may have moved, producing a better quote",
      },
      {
        action: "increase_slippage",
        description: "Increase slippage tolerance if market is volatile",
      },
    ],
  },
  TEE_VERIFICATION_FAILED: {
    name: "TeeVerificationFailed",
    message: "TEE attestation verification failed",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_tee",
        description:
          "Verify the TEE wallet's attestation — the enclave may be compromised",
      },
    ],
  },
  SHIELD_DENIED: {
    name: "ShieldDenied",
    message: "Shield denied the transaction based on policy evaluation",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_policy",
        description:
          "Review shield policies to understand why the transaction was denied",
      },
    ],
  },
  SIMULATION_TIMEOUT: {
    name: "SimulationTimeout",
    message: "Transaction simulation RPC call timed out",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry with a different RPC endpoint or increased timeout",
      },
    ],
  },
  BLOCKHASH_EXPIRED: {
    name: "BlockhashExpired",
    message: "Blockhash expired before transaction could be sent",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 1_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Fetch a fresh blockhash and rebuild the transaction",
      },
    ],
  },
  CODAMA_DECODE_FAILED: {
    name: "CodamaDecodeFailed",
    message: "Codama-generated codec failed to decode instruction data",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "check_idl",
        description: "Verify the IDL matches the deployed program version",
      },
    ],
  },
  CODAMA_VERSION_MISMATCH: {
    name: "CodamaVersionMismatch",
    message: "IDL hash mismatch — generated code may be stale",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "regenerate",
        description: "Regenerate Codama clients from the latest IDL",
      },
    ],
  },
  COMPAT_BRIDGE_FAILED: {
    name: "CompatBridgeFailed",
    message: "web3.js compatibility bridge encountered an error",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "check_compat",
        description: "Check that the compat bridge input types are correct",
      },
    ],
  },
  INTENT_DRIFT_DETECTED: {
    name: "IntentDriftDetected",
    message: "Transaction diverges from the declared intent",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "review_transaction",
        description:
          "The composed transaction does not match the stated intent — review instructions",
      },
      {
        action: "rebuild",
        description: "Rebuild the transaction from a fresh intent",
      },
    ],
  },
  VELOCITY_EXCEEDED: {
    name: "VelocityExceeded",
    message: "Transaction velocity threshold breached",
    category: "RATE_LIMIT",
    retryable: true,
    retry_after_ms: 30_000,
    recovery_actions: [
      {
        action: "wait",
        description:
          "Wait for the cooldown period before submitting more transactions",
      },
    ],
  },
  AGENT_DEFENSE_TRIGGERED: {
    name: "AgentDefenseTriggered",
    message: "Pre-sign gate blocked a suspicious transaction",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "review_transaction",
        description:
          "The transaction triggered agent defense — review for manipulation",
      },
      {
        action: "escalate_to_human",
        description: "Escalate to vault owner for manual review",
      },
    ],
  },
  X402_PARSE_ERROR: {
    name: "X402ParseError",
    message: "Malformed x402 PAYMENT-REQUIRED header",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_server",
        description:
          "The API server returned an invalid x402 header — contact the provider",
      },
    ],
  },
  X402_PAYMENT_DENIED: {
    name: "X402PaymentDenied",
    message: "x402 payment blocked by shield policy",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_policy",
        description: "Review shield spending limits and x402 configuration",
      },
    ],
  },
  X402_UNSUPPORTED: {
    name: "X402Unsupported",
    message: "No compatible Solana payment option in x402 response",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_accepts",
        description:
          "The API does not accept any Solana-compatible payment — try a different endpoint",
      },
    ],
  },
  X402_DESTINATION_BLOCKED: {
    name: "X402DestinationBlocked",
    message: "x402 payTo address not in destination allowlist",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_allowlist",
        description:
          "Add the payTo address to X402Config.allowedDestinations if trusted",
      },
    ],
  },
  X402_REPLAY_DETECTED: {
    name: "X402ReplayDetected",
    message: "Duplicate x402 payment detected within replay window",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "wait",
        description:
          "A payment for this resource was already made — wait for the nonce window to expire",
      },
    ],
  },
  X402_AMOUNT_SUSPICIOUS: {
    name: "X402AmountSuspicious",
    message: "x402 payment amount exceeds sanity threshold",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "review_amount",
        description:
          "The requested amount is suspiciously high — verify with the API provider",
      },
    ],
  },
  X402_FACILITATOR_UNTRUSTED: {
    name: "X402FacilitatorUntrusted",
    message: "x402 settlement response validation failed",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_settlement",
        description: "Verify the settlement transaction on-chain",
      },
    ],
  },
  X402_CONNECTION_REQUIRED: {
    name: "X402ConnectionRequired",
    message: "RPC connection required for x402 payment but not provided",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "provide_rpc",
        description:
          "Pass an RPC connection in ShieldedFetchOptions or X402Config",
      },
    ],
  },
  X402_SETTLEMENT_FAILED: {
    name: "X402SettlementFailed",
    message: "x402 settlement retries exhausted",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "retry",
        description:
          "Retry the x402 payment — the facilitator may be temporarily unavailable",
      },
    ],
  },
  TX_SIZE_OVERFLOW: {
    name: "TxSizeOverflow",
    message: "Transaction exceeds Solana's 1,232-byte wire size limit",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_alt",
        description: "Enable address lookup tables to compress the transaction",
      },
      {
        action: "simplify_route",
        description: "Use a simpler swap route with fewer hops or accounts",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert any error into a structured AgentError.
 *
 * Handles:
 * - On-chain Anchor errors (code 6000-6102)
 * - SDK errors (code 7000-7033)
 * - Network/RPC errors (from message patterns)
 * - Unknown errors (wrapped as FATAL)
 *
 * Uses bigint for context values instead of BN.
 */
export function toAgentError(
  error: unknown,
  extraContext?: Record<string, unknown>,
): AgentError {
  const context: Record<string, unknown> = { ...extraContext };

  // 1. Already an AgentError
  if (isAgentError(error)) return error;

  // 2. On-chain Anchor error code
  const onChainCode = extractErrorCode(error);
  if (onChainCode !== null) {
    const mapping = ON_CHAIN_ERROR_MAP[onChainCode];
    if (mapping) {
      return {
        code: String(onChainCode),
        message: mapping.message,
        category: mapping.category,
        retryable: mapping.retryable,
        retry_after_ms: mapping.retry_after_ms,
        recovery_actions: mapping.recovery_actions,
        context: {
          ...context,
          error_name: mapping.name,
          on_chain_code: onChainCode,
        },
      };
    }
    // Unknown on-chain code
    return {
      code: String(onChainCode),
      message: `Unknown on-chain error code ${onChainCode}`,
      category: "FATAL",
      retryable: false,
      recovery_actions: [],
      context: { ...context, on_chain_code: onChainCode },
    };
  }

  // 3. SDK numeric error code (7000-7032) from Error with code property
  const sdkNumericCode = extractSdkCode(error);
  if (sdkNumericCode !== null) {
    const sdkName = SDK_ERROR_CODES[sdkNumericCode];
    if (sdkName) {
      const mapping = SDK_ERRORS[sdkName];
      return {
        code: sdkName,
        message: mapping.message,
        category: mapping.category,
        retryable: mapping.retryable,
        retry_after_ms: mapping.retry_after_ms,
        recovery_actions: mapping.recovery_actions,
        context: {
          ...context,
          error_name: mapping.name,
          sdk_code: sdkNumericCode,
        },
      };
    }
  }

  // 4. Network / RPC error patterns
  const message = extractMessage(error);

  if (message.includes("429") || message.includes("rate limit")) {
    return fromSdkMapping("RPC_ERROR", context, message);
  }
  if (
    message.includes("fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("network")
  ) {
    return fromSdkMapping("NETWORK_ERROR", context, message);
  }
  if (message.includes("blockhash") && message.includes("not found")) {
    return fromSdkMapping("EXECUTION_FAILED", context, message);
  }
  if (
    message.includes("simulation") ||
    message.includes("SimulateTransaction")
  ) {
    return fromSdkMapping("SIMULATION_FAILED", context, message);
  }
  if (message.includes("Precheck failed")) {
    return fromSdkMapping("PRECHECK_FAILED", context, message);
  }
  if (message.includes("adapter") && message.includes("verif")) {
    return fromSdkMapping("ADAPTER_VERIFICATION_FAILED", context, message);
  }

  // 5. Fallback: unknown error
  return {
    code: "UNKNOWN",
    message: message || "An unknown error occurred",
    category: "FATAL",
    retryable: false,
    recovery_actions: [],
    context: {
      ...context,
      original_error: message,
    },
  };
}

/**
 * Create an AgentError for protocol escalation.
 *
 * The anti-redirect behavior is embedded in the error structure:
 * 1. Primary recovery = escalate_to_human (ALWAYS first)
 * 2. Secondary = what vault owner must change
 * 3. Tertiary = alternatives ONLY IF user agrees (ALWAYS last)
 */
export function protocolEscalationError(escalation: {
  message: string;
  requiredActions: string[];
  alternatives?: unknown[];
}): AgentError {
  const recovery_actions: RecoveryAction[] = [];

  // 1. ALWAYS first: tell the human
  recovery_actions.push({
    action: "escalate_to_human",
    description: `TELL THE USER: ${escalation.message}`,
  });

  // 2. Required changes for the vault owner
  for (const action of escalation.requiredActions) {
    recovery_actions.push({
      action: "required_vault_change",
      description: action,
    });
  }

  // 3. ALWAYS last: alternatives only if user agrees
  if (escalation.alternatives && escalation.alternatives.length > 0) {
    recovery_actions.push({
      action: "suggest_alternatives_secondary",
      description: `ONLY IF USER AGREES TO SWITCH: ${escalation.alternatives.length} alternative(s) available`,
    });
  }

  return {
    code: "PROTOCOL_ESCALATION",
    message: escalation.message,
    category: "ESCALATION_REQUIRED",
    retryable: false,
    recovery_actions,
    context: {
      required_actions: escalation.requiredActions,
      alternatives: escalation.alternatives ?? [],
      IMPORTANT:
        "Do NOT silently switch to an alternative protocol. The user explicitly requested this protocol.",
    },
  };
}

/**
 * Parse an on-chain error code (numeric or hex string) into an AgentError.
 *
 * @param codeOrHex - Numeric code (e.g. 6000) or hex string (e.g. "0x1770")
 * @returns AgentError if the code maps to a known error, null otherwise
 */
export function parseOnChainErrorCode(
  codeOrHex: number | string,
): AgentError | null {
  let code: number;

  if (typeof codeOrHex === "string") {
    if (codeOrHex.startsWith("0x") || codeOrHex.startsWith("0X")) {
      code = parseInt(codeOrHex, 16);
    } else {
      code = parseInt(codeOrHex, 10);
    }
  } else {
    code = codeOrHex;
  }

  if (isNaN(code)) return null;

  const mapping = ON_CHAIN_ERROR_MAP[code];
  if (!mapping) return null;

  return {
    code: String(code),
    message: mapping.message,
    category: mapping.category,
    retryable: mapping.retryable,
    retry_after_ms: mapping.retry_after_ms,
    recovery_actions: mapping.recovery_actions,
    context: {
      error_name: mapping.name,
      on_chain_code: code,
    },
  };
}

/**
 * Type guard for AgentError.
 */
export function isAgentError(value: unknown): value is AgentError {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.code === "string" &&
    typeof obj.message === "string" &&
    typeof obj.category === "string" &&
    typeof obj.retryable === "boolean" &&
    Array.isArray(obj.recovery_actions) &&
    typeof obj.context === "object" &&
    obj.context !== null
  );
}

/**
 * Get all mapped on-chain error codes (for testing/documentation).
 */
export function getAllOnChainErrorCodes(): number[] {
  return Object.keys(ON_CHAIN_ERROR_MAP)
    .map(Number)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Typed error categories (Step 5.5 — discriminated union for TypeScript switch)
// ---------------------------------------------------------------------------

/**
 * Discriminated union for TypeScript switch exhaustiveness with typed context.
 *
 * Complements `ErrorCategory` (string literal union for agent decision-making).
 * Use `SigilErrorCategory` when you need typed access to error-specific fields
 * like `remaining` for spending errors or `protocol` for protocol errors.
 */
export type SigilErrorCategory =
  | { type: "spending"; code: number; remaining: bigint; cap: bigint }
  | { type: "permission"; code: number; required: string }
  | { type: "protocol"; code: number; protocol: string }
  | { type: "vault"; code: number; status: string }
  | { type: "network"; code: number; retryable: boolean };

/** Map from ErrorCategory string → SigilErrorCategory.type */
const CATEGORY_TYPE_MAP: Record<ErrorCategory, SigilErrorCategory["type"]> = {
  SPENDING_CAP: "spending",
  PERMISSION: "permission",
  PROTOCOL_NOT_SUPPORTED: "protocol",
  RESOURCE_NOT_FOUND: "vault",
  INPUT_VALIDATION: "vault",
  POLICY_VIOLATION: "permission",
  ESCALATION_REQUIRED: "permission",
  TRANSIENT: "network",
  RATE_LIMIT: "network",
  FATAL: "network",
};

/**
 * Convert an AgentError into a typed SigilErrorCategory for switch exhaustiveness.
 *
 * Extracts typed context from the AgentError.context bag into the appropriate
 * discriminated union variant. Returns the variant matching the error's category.
 *
 * @example
 * ```typescript
 * const err = toAgentError(error);
 * const cat = categorizeError(err);
 * switch (cat.type) {
 *   case "spending": console.log(`${cat.remaining} remaining of ${cat.cap}`); break;
 *   case "permission": console.log(`Need: ${cat.required}`); break;
 *   case "protocol": console.log(`Unknown: ${cat.protocol}`); break;
 *   case "vault": console.log(`Vault ${cat.status}`); break;
 *   case "network": console.log(`Retryable: ${cat.retryable}`); break;
 * }
 * ```
 */
/** Safely convert unknown context values to bigint without throwing. */
function safeBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value))
    return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function categorizeError(err: AgentError): SigilErrorCategory {
  const code = parseInt(err.code, 10) || 0;
  const categoryType = CATEGORY_TYPE_MAP[err.category] ?? "network";

  switch (categoryType) {
    case "spending":
      return {
        type: "spending",
        code,
        remaining: safeBigInt(err.context.remaining),
        cap: safeBigInt(err.context.cap),
      };
    case "permission":
      return {
        type: "permission",
        code,
        required: (err.context.required_permission as string) ?? err.message,
      };
    case "protocol":
      return {
        type: "protocol",
        code,
        protocol: (err.context.protocol as string) ?? "unknown",
      };
    case "vault":
      return {
        type: "vault",
        code,
        status: (err.context.vault_status as string) ?? err.message,
      };
    case "network":
      return {
        type: "network",
        code,
        retryable: err.retryable,
      };
  }
}

/**
 * Get all SDK error codes (for testing/documentation).
 */
export function getAllSdkErrorCodes(): Array<{ code: number; name: string }> {
  return Object.entries(SDK_ERROR_CODES)
    .map(([code, name]) => ({ code: Number(code), name }))
    .sort((a, b) => a.code - b.code);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  // Direct code property — uses SIGIL_ON_CHAIN_ERROR_{MIN,MAX} constants
  // defined at top of file as single source of truth.
  if (
    typeof e.code === "number" &&
    e.code >= SIGIL_ON_CHAIN_ERROR_MIN &&
    e.code <= SIGIL_ON_CHAIN_ERROR_MAX
  )
    return e.code;

  // Anchor error structure
  if (e.error && typeof e.error === "object") {
    const inner = e.error as Record<string, unknown>;
    if (inner.errorCode && typeof inner.errorCode === "object") {
      const ec = inner.errorCode as Record<string, unknown>;
      if (typeof ec.number === "number") return ec.number;
    }
  }

  // Parse from SendTransactionError logs
  if (e.message && typeof e.message === "string") {
    const match = e.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      if (code >= SIGIL_ON_CHAIN_ERROR_MIN && code <= SIGIL_ON_CHAIN_ERROR_MAX)
        return code;
    }
  }

  return null;
}

function extractSdkCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  if (typeof e.code === "number" && e.code >= 7000 && e.code <= 7033)
    return e.code;

  return null;
}

function extractMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

function fromSdkMapping(
  code: string,
  context: Record<string, unknown>,
  originalMessage: string,
): AgentError {
  const mapping = SDK_ERRORS[code];
  return {
    code,
    message: mapping.message,
    category: mapping.category,
    retryable: mapping.retryable,
    retry_after_ms: mapping.retry_after_ms,
    recovery_actions: mapping.recovery_actions,
    context: {
      ...context,
      error_name: mapping.name,
      original_message: originalMessage,
    },
  };
}

// ─── SDK Error Patterns (wrap() and friends) ─────────────────────────────────

interface SdkErrorPattern {
  pattern: RegExp;
  category: ErrorCategory;
  retryable: boolean;
  recovery_actions: RecoveryAction[];
}

const SDK_ERROR_PATTERNS: SdkErrorPattern[] = [
  {
    pattern: /Vault is not active/,
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "check_vault_status",
        description: "Verify vault status. It may be frozen or closed.",
      },
      {
        action: "reactivate_vault",
        description: "If frozen, ask the vault owner to reactivate.",
        tool: "reactivateVault",
      },
    ],
  },
  {
    pattern: /Agent .+ is not registered/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "register_agent",
        description: "Register this agent in the vault.",
        tool: "registerAgent",
      },
    ],
  },
  {
    pattern: /Agent .+ is paused/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "unpause_agent",
        description: "Ask the vault owner to unpause this agent.",
        tool: "unpauseAgent",
      },
    ],
  },
  {
    pattern: /lacks permission for action/,
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "update_permissions",
        description:
          "Request permission for this action type from the vault owner.",
      },
    ],
  },
  {
    pattern: /Protocol .+ is not allowed/,
    category: "PROTOCOL_NOT_SUPPORTED",
    retryable: false,
    recovery_actions: [
      {
        action: "add_protocol",
        description: "Add this protocol to the vault's allowlist.",
      },
    ],
  },
  {
    pattern: /Transaction size .+ exceeds/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "add_alts",
        description: "Pass protocolAltAddresses from your DeFi API response.",
      },
      {
        action: "reduce_instructions",
        description:
          "Reduce instruction count or split across multiple transactions.",
      },
    ],
  },
  // "Position limit reached" pattern DELETED — position counter system removed
  // per council decision (9-1 vote, 2026-04-19).
  {
    pattern: /Spending action .+ requires amount > 0/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_amount",
        description: "Set amount to the transaction value in token base units.",
      },
    ],
  },
  {
    pattern: /Non-spending action .+ requires amount === 0/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "set_zero_amount",
        description:
          "Non-spending actions (close, withdraw, etc.) require amount = 0n.",
      },
    ],
  },
  {
    pattern: /No target protocol/,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "add_instructions",
        description:
          "Include DeFi instructions in the wrap call, or set targetProtocol explicitly.",
      },
    ],
  },
];

// ─── SigilSdkError ──────────────────────────────────────────────────────────

/**
 * Error class that is BOTH an Error instance AND an AgentError.
 * Critical: extends Error so `instanceof Error` checks work in consumer code.
 *
 * **PR 2.A — DEFERRED rebasing on `SigilError`.** Per UD3 (defer AgentError
 * class promotion) and architect's R4: AgentError's `.code: string` is wider
 * than SigilError's `SigilErrorCode` union. TypeScript's property variance
 * blocks shadowing the base `.code` with a wider type. The proper fix is to
 * promote `AgentError` from interface to `SigilAgentError` class — that
 * change is out of scope for PR 2.A and tracked for a follow-up PR.
 *
 * Until then, `SigilSdkError` extends `Error` directly. Consequences:
 *
 * - `instanceof SigilSdkError` and `instanceof Error` work as before.
 * - `instanceof SigilError` returns FALSE for `SigilSdkError` instances.
 * - Consumers writing `catch (e) { if (e instanceof SigilError) ... }` will
 *   NOT catch SigilSdkError — they should fall through to a separate
 *   `if (e instanceof Error)` branch or use the `AgentError` interface check
 *   (`isAgentError(e)`).
 *
 * Documented in the PR 2.A changeset under BREAKING / Limitations.
 */
export class SigilSdkError extends Error implements AgentError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly recovery_actions: RecoveryAction[];
  readonly context: Record<string, unknown>;
  readonly retry_after_ms?: number;

  constructor(agentError: AgentError) {
    super(agentError.message);
    this.name = "SigilSdkError";
    this.code = agentError.code;
    this.category = agentError.category;
    this.retryable = agentError.retryable;
    this.recovery_actions = agentError.recovery_actions;
    this.context = agentError.context ?? {};
    if (agentError.retry_after_ms)
      this.retry_after_ms = agentError.retry_after_ms;
  }
}

// ─── toSigilAgentError ────────────────────────────────────────────────────────

/**
 * Convert any error thrown by seal() or SigilClient methods into a structured AgentError.
 * Returns a SigilSdkError (extends Error) so instanceof Error checks still work.
 *
 * Processing order:
 * 1. Try on-chain error extraction via toAgentError() (numeric codes 6000-6102)
 * 2. Pattern-match SDK error messages (11 patterns from seal.ts throw sites)
 * 3. Fallback to UNKNOWN/FATAL
 */
export function toSigilAgentError(err: unknown): SigilSdkError {
  // Phase 9 Batch M §RP CRIT-1 fix: preserve SigilSdkDomainError and
  // SigilRpcError instances unmodified. These are the canonical
  // SDK-domain-typed errors carrying their own `.code`, structured
  // `.context`, and rich `.message`. Funneling them through the
  // pattern-matcher + UNKNOWN/FATAL fallback below silently strips
  // the context the throw site built (vault address, docs URL,
  // opt-in/opt-out snippets, network identifier, etc.).
  //
  // Wrap the domain error in a SigilSdkError that mirrors its code
  // + context so downstream consumers narrowing on either
  // `err instanceof SigilSdkDomainError` (the original throw) OR
  // `err.code === SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED`
  // (the SigilSdkError surface) both work.
  if (
    err instanceof Error &&
    typeof (err as unknown as { code?: unknown }).code === "string" &&
    ((err as unknown as { code: string }).code as string).startsWith(
      "SIGIL_ERROR__",
    )
  ) {
    const sigilErr = err as unknown as Error & {
      code: string;
      context?: Record<string, unknown>;
    };
    return new SigilSdkError({
      code: sigilErr.code,
      message: sigilErr.message,
      category: "FATAL",
      retryable: false,
      recovery_actions: [],
      context: sigilErr.context ?? {},
    });
  }

  // Try on-chain error extraction first
  const onChain = toAgentError(err);
  if (onChain.code !== "UNKNOWN") return new SigilSdkError(onChain);

  // Pattern-match SDK errors
  const message = err instanceof Error ? err.message : String(err);
  for (const p of SDK_ERROR_PATTERNS) {
    if (p.pattern.test(message)) {
      return new SigilSdkError({
        code: `SDK_${p.category}`,
        message,
        category: p.category,
        retryable: p.retryable,
        recovery_actions: p.recovery_actions,
        context: {},
      });
    }
  }

  // Fallback
  return new SigilSdkError({
    code: "UNKNOWN",
    message,
    category: "FATAL",
    retryable: false,
    recovery_actions: [],
    context: {},
  });
}
