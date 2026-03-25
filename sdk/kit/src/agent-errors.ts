/**
 * Kit-native Agent Error System
 *
 * Structured errors optimized for AI agent consumption.
 * Every error includes a category, retryability flag, and
 * recovery actions that tell the agent exactly what to do next.
 *
 * Maps all 70 on-chain error codes (6000-6069) plus 34 SDK
 * error codes (7000-7033) to AgentError with machine-readable metadata.
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
// On-chain error code mapping (6000-6069)
// ---------------------------------------------------------------------------

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
        tool: "phalnx_reactivate_vault",
      },
      {
        action: "create_vault",
        description: "Create a new vault if this one is closed",
        tool: "phalnx_create_vault",
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
        tool: "phalnx_check_vault",
      },
      {
        action: "register_agent",
        description: "Ask the vault owner to register this agent",
        tool: "phalnx_register_agent",
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
    message:
      "Token is not a supported stablecoin (only USDC and USDT)",
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
        tool: "phalnx_check_vault",
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
        tool: "phalnx_check_vault",
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
        tool: "phalnx_check_spending",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity",
      },
    ],
  },
  6007: {
    name: "LeverageTooHigh",
    message: "Leverage exceeds maximum allowed by policy",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_leverage",
        description: "Reduce leverage to within maxLeverageBps",
      },
      {
        action: "check_limits",
        description: "Check the vault's maxLeverageBps policy",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6008: {
    name: "TooManyPositions",
    message: "Maximum concurrent open positions reached",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "close_position",
        description: "Close an existing position before opening a new one",
        tool: "phalnx_close_position",
      },
    ],
  },
  6009: {
    name: "PositionOpeningDisallowed",
    message: "Vault policy does not allow opening new positions",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_policy",
        description: "Verify canOpenPositions is enabled in vault policy",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6010: {
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
  6011: {
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
  6012: {
    name: "OpenPositionsExist",
    message: "Vault has open positions and cannot be closed",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "close_positions",
        description: "Close all open positions before closing the vault",
        tool: "phalnx_close_position",
      },
    ],
  },
  6013: {
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
  6014: {
    name: "AgentAlreadyRegistered",
    message: "Agent is already registered on this vault",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_agents",
        description: "Check existing agents on the vault",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6015: {
    name: "NoAgentRegistered",
    message: "No agent registered on this vault",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "register_agent",
        description: "Register an agent on the vault first",
        tool: "phalnx_register_agent",
      },
    ],
  },
  6016: {
    name: "VaultNotFrozen",
    message: "Vault is not frozen (expected frozen for reactivation)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_status",
        description: "Check the vault's current status",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6017: {
    name: "VaultAlreadyClosed",
    message: "Vault is permanently closed",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "create_vault",
        description: "Create a new vault — closed vaults cannot be reopened",
        tool: "phalnx_create_vault",
      },
    ],
  },
  6018: {
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
        tool: "phalnx_check_vault",
      },
    ],
  },
  6019: {
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
  6020: {
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
  6021: {
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
  6022: {
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
  6023: {
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
  6024: {
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
  6025: {
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
  6026: {
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
  6027: {
    name: "TimelockActive",
    message:
      "Vault has timelock active — use queue_policy_update instead of direct update",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "queue_update",
        description: "Queue the policy update through the timelock mechanism",
        tool: "phalnx_update_policy",
        parameters: { use_timelock: true },
      },
    ],
  },
  6028: {
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
  6029: {
    name: "DestinationNotAllowed",
    message: "Destination address not in vault's allowed destinations list",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_destinations",
        description: "Check the vault's allowedDestinations list",
        tool: "phalnx_check_vault",
      },
      {
        action: "use_allowed_destination",
        description: "Use a destination that is in the vault's allowlist",
      },
    ],
  },
  6030: {
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
  6031: {
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
  6032: {
    name: "InvalidNonSpendingAmount",
    message: "Non-spending action must have amount = 0",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "set_zero_amount",
        description:
          "Set amount to 0 for non-spending actions (close, cancel, etc.)",
      },
    ],
  },
  6033: {
    name: "NoPositionsToClose",
    message: "No open positions to close or cancel",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "check_positions",
        description: "Verify you have open positions before closing",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6034: {
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
  6035: {
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
  6036: {
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
  6037: {
    name: "SwapSlippageExceeded",
    message:
      "Swap slippage exceeds policy max_slippage_bps or quoted output is zero",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_slippage",
        description:
          "Use a lower slippageBps value within the vault's maxSlippageBps",
      },
      {
        action: "check_policy",
        description: "Check the vault's maxSlippageBps setting",
        tool: "phalnx_check_vault",
      },
    ],
  },
  6038: {
    name: "InvalidJupiterInstruction",
    message: "Cannot parse Jupiter swap instruction data",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's composeJupiterSwap — manual instruction building is error-prone",
      },
    ],
  },
  6039: {
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
  6040: {
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
  6041: {
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
  6042: {
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
  6043: {
    name: "MaxAgentsReached",
    message: "Maximum agents per vault reached (limit: 10)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an existing agent before registering a new one",
        tool: "phalnx_revoke_agent",
      },
    ],
  },
  6044: {
    name: "InsufficientPermissions",
    message: "Agent lacks permission for this action type",
    category: "PERMISSION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_permissions",
        description: "Check the agent's permission bitmask",
        tool: "phalnx_check_vault",
      },
      {
        action: "request_permissions",
        description: "Ask the vault owner to update the agent's permissions",
      },
    ],
  },
  6045: {
    name: "InvalidPermissions",
    message: "Permission bitmask contains invalid bits (only 21 bits valid)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_permissions",
        description:
          "Use valid permission constants (FULL_PERMISSIONS, SWAP_ONLY, etc.)",
      },
    ],
  },

  // --- Escrow errors ---
  6046: {
    name: "EscrowNotActive",
    message: "Escrow is not in Active status",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "check_escrow",
        description: "Verify the escrow exists and is in Active status",
      },
    ],
  },
  6047: {
    name: "EscrowExpired",
    message: "Escrow has expired — can only be refunded now",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "refund_escrow",
        description: "Refund the expired escrow back to the source vault",
        tool: "phalnx_refund_escrow",
      },
    ],
  },
  6048: {
    name: "EscrowNotExpired",
    message: "Escrow has not expired yet — cannot refund before expiry",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "wait",
        description: "Wait for the escrow to expire before requesting a refund",
      },
      {
        action: "settle",
        description: "Settle the escrow if you are the destination agent",
        tool: "phalnx_settle_escrow",
      },
    ],
  },
  6049: {
    name: "InvalidEscrowVault",
    message: "Invalid escrow vault — source or destination vault mismatch",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_vaults",
        description:
          "Ensure source and destination vault addresses match the escrow",
      },
    ],
  },
  6050: {
    name: "EscrowConditionsNotMet",
    message: "Escrow settlement conditions not met (SHA-256 proof invalid)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "provide_proof",
        description:
          "Provide the correct pre-image for the escrow's condition_hash",
      },
    ],
  },
  6051: {
    name: "EscrowDurationExceeded",
    message: "Escrow duration exceeds maximum (30 days)",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "reduce_duration",
        description:
          "Set escrow duration to 2,592,000 seconds (30 days) or less",
      },
    ],
  },

  // --- Instruction constraints errors ---
  6052: {
    name: "InvalidConstraintConfig",
    message: "Invalid constraint configuration: bounds exceeded",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "fix_constraints",
        description:
          "Ensure constraint entries are within bounds (max 16 entries, 8 data constraints each)",
      },
    ],
  },
  6053: {
    name: "ConstraintViolated",
    message: "Instruction violated a configured constraint",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "check_constraints",
        description:
          "Review the vault's instruction constraints to understand what is allowed",
        tool: "phalnx_check_vault",
      },
      {
        action: "modify_instruction",
        description:
          "Modify the instruction parameters to satisfy the constraints",
      },
    ],
  },
  6054: {
    name: "InvalidConstraintsPda",
    message: "Invalid constraints PDA: wrong owner or vault",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_pda",
        description: "Use the correct constraints PDA derived from the vault",
      },
    ],
  },
  6055: {
    name: "InvalidPendingConstraintsPda",
    message: "Invalid pending constraints PDA: wrong owner or vault",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "verify_pda",
        description:
          "Use the correct pending constraints PDA derived from the vault",
      },
    ],
  },

  // --- Per-agent spend limit errors ---
  6056: {
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
        tool: "phalnx_check_spending",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity",
      },
    ],
  },
  6057: {
    name: "OverlaySlotExhausted",
    message:
      "Per-agent overlay is full — cannot register agent with spending limit",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an unused agent to free an overlay slot",
        tool: "phalnx_revoke_agent",
      },
    ],
  },
  6058: {
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
  6059: {
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
  6060: {
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
  6061: {
    name: "UnconstrainedProgramBlocked",
    message: "Program has no constraint entry and strict mode is enabled",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "add_constraint",
        description:
          "Add a constraint entry for this program, or disable strict mode",
      },
      {
        action: "check_constraints",
        description: "Review the vault's instruction constraints",
        tool: "phalnx_check_vault",
      },
    ],
  },

  // --- Per-protocol spend cap errors ---
  6062: {
    name: "ProtocolCapExceeded",
    message: "Per-protocol rolling 24h spending cap would be exceeded",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000,
    recovery_actions: [
      {
        action: "reduce_amount",
        description:
          "Reduce the amount to fit within the protocol's remaining cap",
      },
      {
        action: "use_different_protocol",
        description: "Use a different protocol that has remaining capacity",
      },
      {
        action: "wait",
        description:
          "Wait for the 24h rolling window to release spent capacity",
      },
    ],
  },
  6063: {
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
  6064: {
    name: "ActiveEscrowsExist",
    message: "Active escrow deposits exist — close them before closing vault",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "close_escrows",
        description:
          "Settle or refund all active escrows before closing the vault",
      },
    ],
  },
  6065: {
    name: "ConstraintsNotClosed",
    message:
      "Instruction constraints PDA still exists — close it before closing vault",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "close_constraints",
        description:
          "Close the instruction constraints account before closing the vault",
      },
    ],
  },
  6066: {
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
  6067: {
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
  6068: {
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
  6069: {
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
};

// ---------------------------------------------------------------------------
// SDK error codes (7000-7033) — numeric to match agent error code pattern
// ---------------------------------------------------------------------------

const SDK_ERROR_CODES: Record<number, string> = {
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
 * - On-chain Anchor errors (code 6000-6069)
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
 * Use `PhalnxErrorCategory` when you need typed access to error-specific fields
 * like `remaining` for spending errors or `protocol` for protocol errors.
 */
export type PhalnxErrorCategory =
  | { type: "spending"; code: number; remaining: bigint; cap: bigint }
  | { type: "permission"; code: number; required: string }
  | { type: "protocol"; code: number; protocol: string }
  | { type: "vault"; code: number; status: string }
  | { type: "network"; code: number; retryable: boolean };

/** Map from ErrorCategory string → PhalnxErrorCategory.type */
const CATEGORY_TYPE_MAP: Record<ErrorCategory, PhalnxErrorCategory["type"]> = {
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
 * Convert an AgentError into a typed PhalnxErrorCategory for switch exhaustiveness.
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

export function categorizeError(err: AgentError): PhalnxErrorCategory {
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

  // Direct code property
  if (typeof e.code === "number" && e.code >= 6000 && e.code <= 6069)
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
      if (code >= 6000 && code <= 6069) return code;
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
