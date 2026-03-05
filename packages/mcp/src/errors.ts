export interface ErrorInfo {
  code: number;
  name: string;
  message: string;
  suggestion: string;
}

/**
 * Maps all 63 Phalnx Anchor error codes (6000–6062) to
 * human-readable messages with actionable suggestions for AI tools.
 */
const ERROR_MAP: Record<number, ErrorInfo> = {
  6000: {
    code: 6000,
    name: "VaultNotActive",
    message: "Vault is not active",
    suggestion:
      "Use shield_reactivate_vault to reactivate a frozen vault, or create a new vault.",
  },
  6001: {
    code: 6001,
    name: "UnauthorizedAgent",
    message: "Unauthorized: signer is not the registered agent",
    suggestion:
      "Verify the agent keypair matches the one registered with shield_register_agent.",
  },
  6002: {
    code: 6002,
    name: "UnauthorizedOwner",
    message: "Unauthorized: signer is not the vault owner",
    suggestion:
      "This operation requires the vault owner's wallet. Check PHALNX_WALLET_PATH.",
  },
  6003: {
    code: 6003,
    name: "TokenNotRegistered",
    message: "Token is not a recognized stablecoin",
    suggestion:
      "Only USDC and USDT are supported for spending. Use a stablecoin for transfers, or swap non-stablecoins through a stablecoin pair.",
  },
  6004: {
    code: 6004,
    name: "ProtocolNotAllowed",
    message: "Protocol not allowed by policy",
    suggestion:
      "Use shield_update_policy to add the protocol to the allowlist, or switch protocolMode to allow-all (mode 0).",
  },
  6005: {
    code: 6005,
    name: "TransactionTooLarge",
    message: "Transaction exceeds maximum single transaction size",
    suggestion:
      "Reduce the amount or use shield_update_policy to increase maxTransactionSizeUsd.",
  },
  6006: {
    code: 6006,
    name: "DailyCapExceeded",
    message: "Daily spending cap would be exceeded",
    suggestion:
      "Wait for the 24h rolling window to reset, or use shield_update_policy to increase dailySpendingCapUsd.",
  },
  6007: {
    code: 6007,
    name: "LeverageTooHigh",
    message: "Leverage exceeds maximum allowed",
    suggestion:
      "Reduce leverage or use shield_update_policy to increase maxLeverageBps.",
  },
  6008: {
    code: 6008,
    name: "TooManyPositions",
    message: "Maximum concurrent open positions reached",
    suggestion:
      "Close an existing position before opening a new one, or increase maxConcurrentPositions.",
  },
  6009: {
    code: 6009,
    name: "PositionOpeningDisallowed",
    message: "Cannot open new positions (policy disallows)",
    suggestion: "Use shield_update_policy to set canOpenPositions to true.",
  },
  6010: {
    code: 6010,
    name: "SessionNotAuthorized",
    message: "Session not authorized",
    suggestion:
      "The validate_and_authorize step may have failed. Check vault status and policy compliance.",
  },
  6011: {
    code: 6011,
    name: "InvalidSession",
    message: "Invalid session: does not belong to this vault",
    suggestion:
      "Ensure you are using the correct vault address for this session.",
  },
  6012: {
    code: 6012,
    name: "OpenPositionsExist",
    message: "Vault has open positions, cannot close",
    suggestion: "Close all open positions before closing the vault.",
  },
  6013: {
    code: 6013,
    name: "TooManyAllowedProtocols",
    message: "Policy configuration invalid: too many allowed protocols",
    suggestion:
      "Maximum 10 allowed protocols. Remove protocols you no longer need.",
  },
  6014: {
    code: 6014,
    name: "AgentAlreadyRegistered",
    message: "Agent already registered for this vault",
    suggestion: "Use shield_revoke_agent first, then register the new agent.",
  },
  6015: {
    code: 6015,
    name: "NoAgentRegistered",
    message: "No agent registered for this vault",
    suggestion:
      "Use shield_register_agent to register an agent before executing trades.",
  },
  6016: {
    code: 6016,
    name: "VaultNotFrozen",
    message: "Vault is not frozen (expected frozen for reactivation)",
    suggestion:
      "Only frozen vaults can be reactivated. The vault may already be active.",
  },
  6017: {
    code: 6017,
    name: "VaultAlreadyClosed",
    message: "Vault is already closed",
    suggestion:
      "This vault has been permanently closed. Create a new vault instead.",
  },
  6018: {
    code: 6018,
    name: "InsufficientBalance",
    message: "Insufficient vault balance for withdrawal",
    suggestion:
      "Use shield_check_vault to verify balances. Deposit more funds or reduce the withdrawal amount.",
  },
  6019: {
    code: 6019,
    name: "DeveloperFeeTooHigh",
    message: "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)",
    suggestion: "Set developerFeeRate to 500 or less (maximum 0.05%).",
  },
  6020: {
    code: 6020,
    name: "InvalidFeeDestination",
    message: "Fee destination account invalid",
    suggestion: "Provide a valid Solana public key for the fee destination.",
  },
  6021: {
    code: 6021,
    name: "InvalidProtocolTreasury",
    message: "Protocol treasury account does not match expected address",
    suggestion:
      "This is an internal error. The protocol treasury address is hardcoded.",
  },
  6022: {
    code: 6022,
    name: "InvalidAgentKey",
    message: "Invalid agent: cannot be the zero address",
    suggestion: "Provide a valid Solana public key for the agent.",
  },
  6023: {
    code: 6023,
    name: "AgentIsOwner",
    message: "Invalid agent: agent cannot be the vault owner",
    suggestion:
      "The agent key must be different from the vault owner. Use a separate keypair.",
  },
  6024: {
    code: 6024,
    name: "Overflow",
    message: "Arithmetic overflow",
    suggestion: "The amount is too large. Reduce the value and try again.",
  },
  6025: {
    code: 6025,
    name: "InvalidTokenAccount",
    message: "Token account does not belong to vault or has wrong mint",
    suggestion:
      "Ensure the token account is owned by the vault PDA and matches the token mint.",
  },
  6026: {
    code: 6026,
    name: "TimelockNotExpired",
    message: "Timelock period has not expired yet",
    suggestion:
      "Wait for the timelock period to expire before applying the pending policy update.",
  },
  6027: {
    code: 6027,
    name: "TimelockActive",
    message: "Vault has timelock active — use queue_policy_update instead",
    suggestion:
      "This vault has a timelock configured. Use shield_queue_policy_update to queue changes, then apply after the timelock expires.",
  },
  6028: {
    code: 6028,
    name: "NoTimelockConfigured",
    message: "No timelock configured on this vault",
    suggestion:
      "This vault does not have a timelock. Use shield_update_policy directly instead of queue_policy_update.",
  },
  6029: {
    code: 6029,
    name: "DestinationNotAllowed",
    message: "Destination not in allowed list",
    suggestion:
      "Use shield_update_policy to add the destination address to allowedDestinations.",
  },
  6030: {
    code: 6030,
    name: "TooManyDestinations",
    message: "Too many destinations (max 10)",
    suggestion:
      "Maximum 10 allowed destinations. Remove destinations you no longer need before adding new ones.",
  },
  6031: {
    code: 6031,
    name: "InvalidProtocolMode",
    message: "Invalid protocol mode (must be 0, 1, or 2)",
    suggestion:
      "Set protocolMode to 0 (allow all), 1 (allowlist), or 2 (denylist).",
  },
  6032: {
    code: 6032,
    name: "InvalidNonSpendingAmount",
    message: "Non-spending action must have amount = 0",
    suggestion:
      "Risk-reducing actions (ClosePosition, DecreasePosition, CloseAndSwapPosition) and other non-spending actions must pass amount = 0.",
  },
  6033: {
    code: 6033,
    name: "NoPositionsToClose",
    message: "No open positions to close or cancel",
    suggestion:
      "The vault has no open positions. Use sync_positions to correct the counter if it is out of sync.",
  },
  6034: {
    code: 6034,
    name: "CpiCallNotAllowed",
    message: "Instruction must be top-level (CPI calls not allowed)",
    suggestion:
      "validate_and_authorize must be called as a top-level instruction, not via CPI. Check the transaction composition.",
  },
  6035: {
    code: 6035,
    name: "MissingFinalizeInstruction",
    message: "Transaction must include finalize_session after validate",
    suggestion:
      "Every validate_and_authorize must be followed by a finalize_session in the same transaction. Check the transaction composition.",
  },
  6036: {
    code: 6036,
    name: "NonTrackedSwapMustReturnStablecoin",
    message:
      "Non-stablecoin swap must return stablecoin (balance did not increase)",
    suggestion:
      "When swapping a non-stablecoin token, the output must be USDC or USDT and the vault's stablecoin balance must increase. Route through a stablecoin pair.",
  },
  6037: {
    code: 6037,
    name: "SlippageTooHigh",
    message:
      "Jupiter slippage exceeds policy max_slippage_bps or quoted_out is zero",
    suggestion:
      "Reduce the slippage tolerance or use shield_update_policy to increase maxSlippageBps.",
  },
  6038: {
    code: 6038,
    name: "InvalidJupiterInstruction",
    message: "Cannot parse Jupiter swap instruction data",
    suggestion:
      "The Jupiter swap instruction has an unrecognized format. Ensure you are using Jupiter V6 SharedAccountsRoute or Route.",
  },
  6039: {
    code: 6039,
    name: "InvalidFlashTradeInstruction",
    message: "Cannot parse Flash Trade instruction data",
    suggestion:
      "The Flash Trade instruction has an unrecognized discriminator. Ensure you are using a supported Flash Trade action.",
  },
  6040: {
    code: 6040,
    name: "FlashTradePriceZero",
    message: "Flash Trade priceWithSlippage is zero",
    suggestion:
      "The Flash Trade instruction has a zero price, which would accept any fill price. Provide a valid priceWithSlippage.",
  },
  6041: {
    code: 6041,
    name: "DustDepositDetected",
    message:
      "Top-level SPL Token transfer not allowed between validate and finalize",
    suggestion:
      "A top-level SPL Token Transfer or TransferChecked instruction was detected between validate and finalize. All token movements must happen via CPI through recognized DeFi programs (Jupiter, Flash Trade), not as top-level SPL Token instructions.",
  },
  6042: {
    code: 6042,
    name: "InvalidJupiterLendInstruction",
    message: "Cannot parse Jupiter Lend instruction data",
    suggestion:
      "The Jupiter Lend instruction has an unrecognized format. Ensure you are using Jupiter Lend deposit or withdraw instructions from the official API.",
  },
  6043: {
    code: 6043,
    name: "SlippageBpsTooHigh",
    message: "Slippage BPS exceeds maximum (5000 = 50%)",
    suggestion:
      "The max_slippage_bps policy value exceeds the hard cap of 5000 (50%). Use a value between 0 and 5000.",
  },
  6044: {
    code: 6044,
    name: "ProtocolMismatch",
    message: "DeFi instruction program does not match declared target_protocol",
    suggestion:
      "The DeFi instruction targets a different program than declared in target_protocol. Ensure target_protocol matches the actual program ID of the DeFi instruction in the transaction.",
  },
  6045: {
    code: 6045,
    name: "TooManyDeFiInstructions",
    message: "Non-stablecoin swap allows exactly one DeFi instruction",
    suggestion:
      "Non-stablecoin swaps allow exactly one DeFi instruction per session. Split multi-step swaps into separate transactions (e.g., WIF→USDC then USDC→BONK).",
  },

  // --- Multi-Agent errors (Workstream A) ---
  6046: {
    code: 6046,
    name: "MaxAgentsReached",
    message: "Maximum agents per vault reached (limit: 10)",
    suggestion:
      "Remove an existing agent with shield_revoke_agent before registering a new one. Maximum 10 agents per vault.",
  },
  6047: {
    code: 6047,
    name: "InsufficientPermissions",
    message: "Agent lacks permission for this action type",
    suggestion:
      "The agent's permission bitmask does not include this action. Use shield_update_agent_permissions to grant the required permission bits.",
  },
  6048: {
    code: 6048,
    name: "InvalidPermissions",
    message: "Permission bitmask contains invalid bits",
    suggestion:
      "The permission bitmask has bits set beyond the valid range (0-20). Use predefined constants like FULL_PERMISSIONS, SWAP_ONLY, PERPS_ONLY, etc.",
  },

  // --- Escrow errors (Workstream B) ---
  6049: {
    code: 6049,
    name: "EscrowNotActive",
    message: "Escrow is not in Active status",
    suggestion:
      "The escrow has already been settled or refunded. Check the escrow status with shield_check_escrow.",
  },
  6050: {
    code: 6050,
    name: "EscrowExpired",
    message: "Escrow has expired",
    suggestion:
      "The escrow expiration time has passed. Use shield_refund_escrow to return funds to the source vault.",
  },
  6051: {
    code: 6051,
    name: "EscrowNotExpired",
    message: "Escrow has not expired yet",
    suggestion:
      "The escrow is still within its active period. Wait for expiration before requesting a refund, or settle it with valid proof.",
  },
  6052: {
    code: 6052,
    name: "InvalidEscrowVault",
    message: "Invalid escrow vault",
    suggestion:
      "The source or destination vault does not match the escrow's recorded vaults. Verify the vault addresses.",
  },
  6053: {
    code: 6053,
    name: "EscrowConditionsNotMet",
    message: "Escrow conditions not met",
    suggestion:
      "The provided proof does not match the escrow's condition_hash (SHA-256). Verify the proof data.",
  },
  6054: {
    code: 6054,
    name: "EscrowDurationExceeded",
    message: "Escrow duration exceeds maximum (30 days)",
    suggestion:
      "The escrow expiration is more than 30 days from now. Reduce the expiresAt to within 2,592,000 seconds of creation.",
  },

  // --- Instruction Constraints errors (Workstream C) ---
  6055: {
    code: 6055,
    name: "InvalidConstraintConfig",
    message: "Invalid constraint configuration: bounds exceeded",
    suggestion:
      "The constraint configuration exceeds maximum limits. Check entry count and data constraint sizes.",
  },
  6056: {
    code: 6056,
    name: "ConstraintViolated",
    message: "Instruction constraint violated",
    suggestion:
      "A DeFi instruction in the transaction violates the vault's instruction constraints. Check the constraint rules with shield_check_constraints.",
  },
  6057: {
    code: 6057,
    name: "InvalidConstraintsPda",
    message: "Invalid constraints PDA: wrong owner or vault",
    suggestion:
      "The constraints account does not belong to the specified vault. Verify the vault address.",
  },
  6058: {
    code: 6058,
    name: "NoPendingConstraintsUpdate",
    message: "No pending constraints update to apply or cancel",
    suggestion:
      "No constraints update is queued. Use shield_queue_constraints_update to queue one first.",
  },
  6059: {
    code: 6059,
    name: "PendingConstraintsUpdateExists",
    message: "A pending constraints update already exists",
    suggestion:
      "Cancel the existing pending update with shield_cancel_constraints_update before queuing a new one.",
  },
  6060: {
    code: 6060,
    name: "ConstraintsUpdateNotExpired",
    message: "Constraints update timelock has not expired",
    suggestion:
      "Wait for the timelock period to expire before applying the pending constraints update.",
  },
  6061: {
    code: 6061,
    name: "InvalidPendingConstraintsPda",
    message: "Invalid pending constraints PDA: wrong owner or vault",
    suggestion:
      "The pending constraints account does not belong to the specified vault. Verify the vault address.",
  },
  6062: {
    code: 6062,
    name: "ConstraintsUpdateExpired",
    message: "Pending constraints update has expired and is stale",
    suggestion:
      "The pending constraints update is past its expiration window. Cancel it and queue a fresh update.",
  },
};

/** Truncate and strip control characters from external messages. */
function sanitizeMessage(msg: string, maxLen = 200): string {
  return msg.replace(/[\x00-\x1f]/g, "").slice(0, maxLen);
}

/**
 * Look up an Anchor error code and return a structured ErrorInfo.
 * Falls back to a generic message for unknown codes.
 */
export function lookupError(code: number): ErrorInfo {
  return (
    ERROR_MAP[code] ?? {
      code,
      name: "UnknownError",
      message: `Unknown Anchor error code ${code}`,
      suggestion: "Check the transaction logs for details.",
    }
  );
}

/**
 * Extract an Anchor error code from a thrown error.
 * Returns null if not an Anchor program error.
 */
function extractAnchorErrorCode(error: unknown): number | null {
  if (error && typeof error === "object") {
    // Anchor errors have an `error.code` or `code` property
    const e = error as Record<string, unknown>;
    if (typeof e.code === "number" && e.code >= 6000) {
      return e.code;
    }
    // AnchorError format
    if (
      e.error &&
      typeof e.error === "object" &&
      typeof (e.error as Record<string, unknown>).errorCode === "object"
    ) {
      const errorCode = (e.error as Record<string, unknown>)
        .errorCode as Record<string, unknown>;
      if (typeof errorCode.number === "number") {
        return errorCode.number;
      }
    }
  }
  return null;
}

/**
 * Format any error into a user-friendly MCP tool response.
 */
export function formatError(error: unknown): string {
  // Anchor program error
  const code = extractAnchorErrorCode(error);
  if (code !== null) {
    const info = lookupError(code);
    return (
      `Error: ${info.message} (${info.name}, code ${info.code})\n` +
      `Suggestion: ${info.suggestion}`
    );
  }

  // Jupiter API error (rate limit, server error, bad request)
  if (
    error instanceof Error &&
    error.name === "JupiterApiError" &&
    "statusCode" in error
  ) {
    const statusCode = (error as any).statusCode as number;
    const safeMsg = sanitizeMessage(error.message);
    if (statusCode === 429) {
      return (
        `Jupiter rate limited: ${safeMsg}\n` +
        "Suggestion: Wait 10 seconds and retry. If this persists, configure a Jupiter API key at portal.jup.ag for higher rate limits."
      );
    }
    if (statusCode >= 500) {
      return (
        `Jupiter service error: ${safeMsg}\n` +
        "Suggestion: Jupiter API is temporarily unavailable. Retry in 30 seconds."
      );
    }
    if (statusCode === 400) {
      return (
        `Jupiter bad request: ${safeMsg}\n` +
        "Suggestion: Check that the input/output mints are valid, the amount is positive, and the token pair has sufficient liquidity."
      );
    }
    return (
      `Jupiter API error (${statusCode}): ${safeMsg}\n` +
      "Suggestion: Check the Jupiter API status at status.jup.ag."
    );
  }

  // Network / RPC error
  if (error instanceof Error) {
    if (
      error.message.includes("failed to send transaction") ||
      error.message.includes("Transaction simulation failed")
    ) {
      return (
        `Transaction failed: ${error.message}\n` +
        "Suggestion: Check that the RPC endpoint is reachable and the account has enough SOL for fees."
      );
    }
    if (
      error.message.includes("Account does not exist") ||
      error.message.includes("could not find account")
    ) {
      return (
        `Account not found: ${error.message}\n` +
        "Suggestion: Verify the vault address is correct. The vault may not have been created yet."
      );
    }
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}

export { ERROR_MAP };
