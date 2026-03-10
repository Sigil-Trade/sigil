/**
 * Agent-First Error System
 *
 * Structured errors optimized for AI agent consumption.
 * Every error includes a category, retryability flag, and
 * recovery actions that tell the agent exactly what to do next.
 *
 * Maps all 71 on-chain error codes (6000-6070) plus common
 * SDK/network errors to AgentError with machine-readable metadata.
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
// On-chain error code mapping (6000-6070)
// ---------------------------------------------------------------------------

interface ErrorMapping {
  name: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  retry_after_ms?: number;
  recovery_actions: RecoveryAction[];
}

const ON_CHAIN_ERROR_MAP: Record<number, ErrorMapping> = {
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
    name: "TokenNotRegistered",
    message:
      "Token is not a recognized stablecoin (only USDC and USDT supported)",
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
    name: "DailyCapExceeded",
    message: "Daily spending cap would be exceeded",
    category: "SPENDING_CAP",
    retryable: true,
    retry_after_ms: 3_600_000, // 1 hour — rolling window releases over time
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
    category: "POLICY_VIOLATION",
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
    category: "INPUT_VALIDATION",
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
    category: "POLICY_VIOLATION",
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
    category: "FATAL",
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
    category: "FATAL",
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
    category: "POLICY_VIOLATION",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "increase_slippage",
        description:
          "Increase slippage tolerance — the swap may have failed silently",
      },
      {
        action: "retry",
        description: "Retry the swap — market conditions may have changed",
      },
    ],
  },
  6037: {
    name: "SlippageTooHigh",
    message:
      "Jupiter slippage exceeds policy max_slippage_bps or quoted output is zero",
    category: "POLICY_VIOLATION",
    retryable: true,
    retry_after_ms: 5_000,
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
      {
        action: "retry",
        description: "Retry — market may have moved, producing a better quote",
      },
    ],
  },
  6038: {
    name: "InvalidJupiterInstruction",
    message: "Cannot parse Jupiter swap instruction data",
    category: "FATAL",
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
    name: "InvalidFlashTradeInstruction",
    message: "Cannot parse Flash Trade instruction data",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description: "Use the SDK's Flash Trade compose functions",
      },
    ],
  },
  6040: {
    name: "FlashTradePriceZero",
    message: "Flash Trade priceWithSlippage is zero",
    category: "INPUT_VALIDATION",
    retryable: true,
    retry_after_ms: 5_000,
    recovery_actions: [
      {
        action: "retry",
        description:
          "Retry — the oracle price feed may have been temporarily unavailable",
      },
    ],
  },
  6041: {
    name: "DustDepositDetected",
    message:
      "Top-level SPL Token transfer detected between validate and finalize (potential exploit)",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's compose functions — do not insert raw SPL transfers in the sandwich",
      },
    ],
  },
  6042: {
    name: "InvalidJupiterLendInstruction",
    message: "Cannot parse Jupiter Lend instruction data",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description: "Use the SDK's Jupiter Lend compose functions",
      },
    ],
  },
  6043: {
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
  6044: {
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
  6045: {
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
  6046: {
    name: "MaxAgentsReached",
    message: "Maximum agents per vault reached (limit: 10)",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an existing agent before registering a new one",
        tool: "phalnx_revoke_agent",
      },
    ],
  },
  6047: {
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
  6048: {
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
  6049: {
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
  6050: {
    name: "EscrowExpired",
    message: "Escrow has expired — can only be refunded now",
    category: "POLICY_VIOLATION",
    retryable: false,
    recovery_actions: [
      {
        action: "refund_escrow",
        description: "Refund the expired escrow back to the source vault",
        tool: "phalnx_refund_escrow",
      },
    ],
  },
  6051: {
    name: "EscrowNotExpired",
    message: "Escrow has not expired yet — cannot refund before expiry",
    category: "POLICY_VIOLATION",
    retryable: true,
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
  6052: {
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
  6053: {
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
  6054: {
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
  6055: {
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
  6056: {
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
  6057: {
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
  6058: {
    name: "NoPendingConstraintsUpdate",
    message: "No pending constraints update to apply or cancel",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "queue_update",
        description: "Queue a constraints update first before applying",
      },
    ],
  },
  6059: {
    name: "PendingConstraintsUpdateExists",
    message: "A pending constraints update already exists",
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: [
      {
        action: "cancel_existing",
        description:
          "Cancel the existing pending update before queuing a new one",
      },
      {
        action: "apply_existing",
        description:
          "Apply the existing pending update if the timelock has expired",
      },
    ],
  },
  6060: {
    name: "ConstraintsUpdateNotExpired",
    message: "Constraints update timelock has not expired yet",
    category: "POLICY_VIOLATION",
    retryable: true,
    recovery_actions: [
      {
        action: "wait",
        description: "Wait for the timelock period to expire",
      },
    ],
  },
  6061: {
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
  6062: {
    name: "ConstraintsUpdateExpired",
    message: "Pending constraints update has expired and is stale",
    category: "RESOURCE_NOT_FOUND",
    retryable: false,
    recovery_actions: [
      {
        action: "cancel_and_requeue",
        description: "Cancel the expired update and queue a fresh one",
      },
    ],
  },

  // --- Per-agent spend limit errors ---
  6063: {
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
  6064: {
    name: "OverlaySlotExhausted",
    message:
      "Per-agent overlay is full — cannot register agent with spending limit",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "revoke_agent",
        description: "Revoke an unused agent to free an overlay slot",
        tool: "phalnx_revoke_agent",
      },
    ],
  },
  6065: {
    name: "AgentSlotNotFound",
    message: "Agent has per-agent spending limit but no overlay tracking slot",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "contact_support",
        description:
          "This is an internal consistency error — the overlay may need reinitialization",
      },
    ],
  },
  6066: {
    name: "UnauthorizedTokenApproval",
    message:
      "Unauthorized SPL Token Approve detected between validate and finalize",
    category: "FATAL",
    retryable: false,
    recovery_actions: [
      {
        action: "use_sdk",
        description:
          "Use the SDK's compose functions — do not insert raw SPL Approve in the sandwich",
      },
    ],
  },
  6067: {
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
  6068: {
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
  6069: {
    name: "ProtocolCapExceeded",
    message: "Per-protocol daily spending cap would be exceeded",
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
  6070: {
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
};

// ---------------------------------------------------------------------------
// SDK / network error codes (string-based)
// ---------------------------------------------------------------------------

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
  RATE_LIMITED: {
    name: "RateLimited",
    message: "Rate limited by RPC or API endpoint",
    category: "RATE_LIMIT",
    retryable: true,
    retry_after_ms: 10_000,
    recovery_actions: [
      {
        action: "wait",
        description: "Wait before retrying — reduce request frequency",
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
  BLOCKHASH_EXPIRED: {
    name: "BlockhashExpired",
    message: "Transaction blockhash has expired",
    category: "TRANSIENT",
    retryable: true,
    retry_after_ms: 1_000,
    recovery_actions: [
      {
        action: "retry",
        description: "Retry immediately — the SDK will fetch a fresh blockhash",
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
};

// ---------------------------------------------------------------------------
// Conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert any error into a structured AgentError.
 *
 * Handles:
 * - On-chain Anchor errors (code 6000-6070)
 * - PhalnxSDKError instances
 * - Network/RPC errors (from message patterns)
 * - Unknown errors (wrapped as FATAL)
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

  // 3. Network / RPC error patterns
  const message = extractMessage(error);

  if (message.includes("429") || message.includes("rate limit")) {
    return fromSdkMapping("RATE_LIMITED", context, message);
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
    return fromSdkMapping("BLOCKHASH_EXPIRED", context, message);
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

  // 4. Fallback: unknown error
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
 * Create an AgentError directly from an SDK error code.
 */
export function agentErrorFromCode(
  code: string,
  context?: Record<string, unknown>,
): AgentError {
  // Try numeric on-chain code
  const numCode = parseInt(code, 10);
  if (!isNaN(numCode) && ON_CHAIN_ERROR_MAP[numCode]) {
    const mapping = ON_CHAIN_ERROR_MAP[numCode];
    return {
      code,
      message: mapping.message,
      category: mapping.category,
      retryable: mapping.retryable,
      retry_after_ms: mapping.retry_after_ms,
      recovery_actions: mapping.recovery_actions,
      context: { ...context, error_name: mapping.name },
    };
  }

  // Try SDK string code
  const sdkMapping = SDK_ERRORS[code];
  if (sdkMapping) {
    return {
      code,
      message: sdkMapping.message,
      category: sdkMapping.category,
      retryable: sdkMapping.retryable,
      retry_after_ms: sdkMapping.retry_after_ms,
      recovery_actions: sdkMapping.recovery_actions,
      context: { ...context, error_name: sdkMapping.name },
    };
  }

  return {
    code,
    message: `Unknown error code: ${code}`,
    category: "FATAL",
    retryable: false,
    recovery_actions: [],
    context: context ?? {},
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

/**
 * Get all SDK error codes (for testing/documentation).
 */
export function getAllSdkErrorCodes(): string[] {
  return Object.keys(SDK_ERRORS).sort();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  // Direct code property
  if (typeof e.code === "number" && e.code >= 6000 && e.code <= 6070)
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
      if (code >= 6000 && code <= 6070) return code;
    }
  }

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
