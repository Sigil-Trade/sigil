export interface ErrorInfo {
  code: number;
  name: string;
  message: string;
  suggestion: string;
}

/**
 * Maps all 46 AgentShield Anchor error codes (6000–6045) to
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
      "This operation requires the vault owner's wallet. Check AGENTSHIELD_WALLET_PATH.",
  },
  6003: {
    code: 6003,
    name: "TokenNotRegistered",
    message: "Token not registered in oracle registry",
    suggestion:
      "Register the token in the oracle registry before using it, or use a token that is already registered.",
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
    name: "SessionExpired",
    message: "Session has expired",
    suggestion:
      "The session exceeded its 20-slot window. Retry the operation — a new session will be created.",
  },
  6011: {
    code: 6011,
    name: "SessionNotAuthorized",
    message: "Session not authorized",
    suggestion:
      "The validate_and_authorize step may have failed. Check vault status and policy compliance.",
  },
  6012: {
    code: 6012,
    name: "InvalidSession",
    message: "Invalid session: does not belong to this vault",
    suggestion:
      "Ensure you are using the correct vault address for this session.",
  },
  6013: {
    code: 6013,
    name: "OpenPositionsExist",
    message: "Vault has open positions, cannot close",
    suggestion: "Close all open positions before closing the vault.",
  },
  6014: {
    code: 6014,
    name: "TooManyAllowedProtocols",
    message: "Policy configuration invalid: too many allowed protocols",
    suggestion:
      "Maximum 10 allowed protocols. Remove protocols you no longer need.",
  },
  6015: {
    code: 6015,
    name: "AgentAlreadyRegistered",
    message: "Agent already registered for this vault",
    suggestion: "Use shield_revoke_agent first, then register the new agent.",
  },
  6016: {
    code: 6016,
    name: "NoAgentRegistered",
    message: "No agent registered for this vault",
    suggestion:
      "Use shield_register_agent to register an agent before executing trades.",
  },
  6017: {
    code: 6017,
    name: "VaultNotFrozen",
    message: "Vault is not frozen (expected frozen for reactivation)",
    suggestion:
      "Only frozen vaults can be reactivated. The vault may already be active.",
  },
  6018: {
    code: 6018,
    name: "VaultAlreadyClosed",
    message: "Vault is already closed",
    suggestion:
      "This vault has been permanently closed. Create a new vault instead.",
  },
  6019: {
    code: 6019,
    name: "InsufficientBalance",
    message: "Insufficient vault balance for withdrawal",
    suggestion:
      "Use shield_check_vault to verify balances. Deposit more funds or reduce the withdrawal amount.",
  },
  6020: {
    code: 6020,
    name: "DeveloperFeeTooHigh",
    message: "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)",
    suggestion: "Set developerFeeRate to 500 or less (maximum 0.05%).",
  },
  6021: {
    code: 6021,
    name: "InvalidFeeDestination",
    message: "Fee destination account invalid",
    suggestion: "Provide a valid Solana public key for the fee destination.",
  },
  6022: {
    code: 6022,
    name: "InvalidProtocolTreasury",
    message: "Protocol treasury account does not match expected address",
    suggestion:
      "This is an internal error. The protocol treasury address is hardcoded.",
  },
  6023: {
    code: 6023,
    name: "InvalidAgentKey",
    message: "Invalid agent: cannot be the zero address",
    suggestion: "Provide a valid Solana public key for the agent.",
  },
  6024: {
    code: 6024,
    name: "AgentIsOwner",
    message: "Invalid agent: agent cannot be the vault owner",
    suggestion:
      "The agent key must be different from the vault owner. Use a separate keypair.",
  },
  6025: {
    code: 6025,
    name: "Overflow",
    message: "Arithmetic overflow",
    suggestion: "The amount is too large. Reduce the value and try again.",
  },
  6026: {
    code: 6026,
    name: "DelegationFailed",
    message: "Token delegation approval failed",
    suggestion:
      "The vault may not have sufficient token balance. Check vault balance and try again.",
  },
  6027: {
    code: 6027,
    name: "RevocationFailed",
    message: "Token delegation revocation failed",
    suggestion:
      "The session may have already been finalized. Check session status.",
  },
  6028: {
    code: 6028,
    name: "OracleFeedStale",
    message: "Oracle feed value is too stale",
    suggestion:
      "The oracle price data is outdated (exceeds 100-slot staleness window). Wait for a fresh price update and retry.",
  },
  6029: {
    code: 6029,
    name: "OracleFeedInvalid",
    message: "Cannot parse oracle feed data",
    suggestion:
      "The oracle feed account data is malformed. Verify the oracle configuration in the oracle registry.",
  },
  6030: {
    code: 6030,
    name: "TokenSpendBlocked",
    message: "Unpriced token cannot be spent (receive-only)",
    suggestion:
      "This token has no oracle price feed and is configured as receive-only. It cannot be used for spending.",
  },
  6031: {
    code: 6031,
    name: "InvalidTokenAccount",
    message: "Token account does not belong to vault or has wrong mint",
    suggestion:
      "Ensure the token account is owned by the vault PDA and matches the token mint.",
  },
  6032: {
    code: 6032,
    name: "OracleAccountMissing",
    message: "Oracle-priced token requires feed account in remaining_accounts",
    suggestion:
      "Pass the oracle feed account when transacting with oracle-priced tokens. The SDK resolves this automatically.",
  },
  6033: {
    code: 6033,
    name: "OracleConfidenceTooWide",
    message: "Oracle price confidence interval too wide",
    suggestion:
      "The oracle price has high uncertainty (>10% confidence interval). Wait for more stable market conditions and retry.",
  },
  6034: {
    code: 6034,
    name: "OracleUnsupportedType",
    message: "Oracle account owner is not a recognized oracle program",
    suggestion:
      "The oracle feed account must be owned by either Pyth Receiver or Switchboard On-Demand program. Check the oracle registry.",
  },
  6035: {
    code: 6035,
    name: "OracleNotVerified",
    message: "Pyth price update not fully verified by Wormhole",
    suggestion:
      "The Pyth price update has not been verified by Wormhole guardians. Use a fully verified price feed.",
  },
  6036: {
    code: 6036,
    name: "TimelockNotExpired",
    message: "Timelock period has not expired yet",
    suggestion:
      "Wait for the timelock period to expire before applying the pending policy update.",
  },
  6037: {
    code: 6037,
    name: "TimelockActive",
    message: "Vault has timelock active — use queue_policy_update instead",
    suggestion:
      "This vault has a timelock configured. Use shield_queue_policy_update to queue changes, then apply after the timelock expires.",
  },
  6038: {
    code: 6038,
    name: "NoTimelockConfigured",
    message: "No timelock configured on this vault",
    suggestion:
      "This vault does not have a timelock. Use shield_update_policy directly instead of queue_policy_update.",
  },
  6039: {
    code: 6039,
    name: "DestinationNotAllowed",
    message: "Destination not in allowed list",
    suggestion:
      "Use shield_update_policy to add the destination address to allowedDestinations.",
  },
  6040: {
    code: 6040,
    name: "TooManyDestinations",
    message: "Too many destinations (max 10)",
    suggestion:
      "Maximum 10 allowed destinations. Remove destinations you no longer need before adding new ones.",
  },
  6041: {
    code: 6041,
    name: "InvalidProtocolMode",
    message: "Invalid protocol mode (must be 0, 1, or 2)",
    suggestion:
      "Set protocolMode to 0 (allow all), 1 (allowlist), or 2 (denylist).",
  },
  6042: {
    code: 6042,
    name: "OracleRegistryFull",
    message: "Oracle registry is full (max 105 entries)",
    suggestion:
      "The oracle registry has reached its maximum capacity of 105 token entries. Remove unused entries before adding new ones.",
  },
  6043: {
    code: 6043,
    name: "UnauthorizedRegistryAdmin",
    message: "Unauthorized: not the oracle registry authority",
    suggestion:
      "Only the oracle registry authority can modify the registry. Verify you are using the correct admin wallet.",
  },
  6044: {
    code: 6044,
    name: "OraclePriceDivergence",
    message: "Primary and fallback oracle prices diverge beyond threshold",
    suggestion:
      "The primary and fallback oracle feeds report prices that differ too much. Wait for price convergence or verify oracle feed configuration.",
  },
  6045: {
    code: 6045,
    name: "OracleBothFeedsFailed",
    message: "Both primary and fallback oracle feeds failed",
    suggestion:
      "Neither oracle feed returned a valid price. Check that the oracle accounts are valid and not stale.",
  },
};

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
