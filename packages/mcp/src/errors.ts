export interface ErrorInfo {
  code: number;
  name: string;
  message: string;
  suggestion: string;
}

/**
 * Maps all 28 AgentShield Anchor error codes (6000–6027) to
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
    name: "TokenNotAllowed",
    message: "Token not in allowed list",
    suggestion:
      "Use shield_update_policy to add the token to allowedTokens, or use an allowed token.",
  },
  6004: {
    code: 6004,
    name: "ProtocolNotAllowed",
    message: "Protocol not in allowed list",
    suggestion:
      "Use shield_update_policy to add the protocol to allowedProtocols.",
  },
  6005: {
    code: 6005,
    name: "TransactionTooLarge",
    message: "Transaction exceeds maximum single transaction size",
    suggestion:
      "Reduce the amount or use shield_update_policy to increase maxTransactionSize.",
  },
  6006: {
    code: 6006,
    name: "DailyCapExceeded",
    message: "Daily spending cap would be exceeded",
    suggestion:
      "Wait for the 24h rolling window to reset, or use shield_update_policy to increase dailySpendingCap.",
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
    suggestion:
      "Use shield_update_policy to set canOpenPositions to true.",
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
    suggestion:
      "Close all open positions before closing the vault.",
  },
  6014: {
    code: 6014,
    name: "TooManyAllowedTokens",
    message: "Policy configuration invalid: too many allowed tokens",
    suggestion:
      "Maximum 10 allowed tokens. Remove tokens you no longer need.",
  },
  6015: {
    code: 6015,
    name: "TooManyAllowedProtocols",
    message: "Policy configuration invalid: too many allowed protocols",
    suggestion:
      "Maximum 10 allowed protocols. Remove protocols you no longer need.",
  },
  6016: {
    code: 6016,
    name: "AgentAlreadyRegistered",
    message: "Agent already registered for this vault",
    suggestion:
      "Use shield_revoke_agent first, then register the new agent.",
  },
  6017: {
    code: 6017,
    name: "NoAgentRegistered",
    message: "No agent registered for this vault",
    suggestion:
      "Use shield_register_agent to register an agent before executing trades.",
  },
  6018: {
    code: 6018,
    name: "VaultNotFrozen",
    message: "Vault is not frozen (expected frozen for reactivation)",
    suggestion:
      "Only frozen vaults can be reactivated. The vault may already be active.",
  },
  6019: {
    code: 6019,
    name: "VaultAlreadyClosed",
    message: "Vault is already closed",
    suggestion:
      "This vault has been permanently closed. Create a new vault instead.",
  },
  6020: {
    code: 6020,
    name: "InsufficientBalance",
    message: "Insufficient vault balance for withdrawal",
    suggestion:
      "Use shield_check_vault to verify balances. Deposit more funds or reduce the withdrawal amount.",
  },
  6021: {
    code: 6021,
    name: "DeveloperFeeTooHigh",
    message:
      "Developer fee rate exceeds maximum (50 / 1,000,000 = 0.5 BPS)",
    suggestion:
      "Set developerFeeRate to 50 or less (maximum 0.005%).",
  },
  6022: {
    code: 6022,
    name: "InvalidFeeDestination",
    message: "Fee destination account invalid",
    suggestion:
      "Provide a valid Solana public key for the fee destination.",
  },
  6023: {
    code: 6023,
    name: "InvalidProtocolTreasury",
    message: "Protocol treasury account does not match expected address",
    suggestion:
      "This is an internal error. The protocol treasury address is hardcoded.",
  },
  6024: {
    code: 6024,
    name: "TooManySpendEntries",
    message:
      "Spend entry limit reached (too many active entries in rolling window)",
    suggestion:
      "Wait for older entries to expire from the 24h rolling window.",
  },
  6025: {
    code: 6025,
    name: "InvalidAgentKey",
    message: "Invalid agent: cannot be the zero address",
    suggestion: "Provide a valid Solana public key for the agent.",
  },
  6026: {
    code: 6026,
    name: "AgentIsOwner",
    message: "Invalid agent: agent cannot be the vault owner",
    suggestion:
      "The agent key must be different from the vault owner. Use a separate keypair.",
  },
  6027: {
    code: 6027,
    name: "Overflow",
    message: "Arithmetic overflow",
    suggestion:
      "The amount is too large. Reduce the value and try again.",
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
