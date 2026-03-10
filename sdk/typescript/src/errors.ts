/**
 * Structured SDK error with machine-readable metadata.
 * Maps on-chain Anchor error codes to actionable suggestions.
 */
export class PhalnxSDKError extends Error {
  readonly code: number;
  readonly errorName: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly field?: string;
  readonly suggestion?: string;

  constructor(opts: {
    code: number;
    name: string;
    message: string;
    expected?: string;
    actual?: string;
    field?: string;
    suggestion?: string;
  }) {
    super(opts.message);
    this.name = "PhalnxSDKError";
    this.code = opts.code;
    this.errorName = opts.name;
    this.expected = opts.expected;
    this.actual = opts.actual;
    this.field = opts.field;
    this.suggestion = opts.suggestion;
  }
}

interface ErrorEntry {
  name: string;
  message: string;
  suggestion: string;
}

const SDK_ERROR_MAP: Record<number, ErrorEntry> = {
  6000: {
    name: "VaultNotActive",
    message: "Vault is not active",
    suggestion: "Reactivate the vault or create a new one.",
  },
  6001: {
    name: "UnauthorizedAgent",
    message: "Unauthorized: signer is not a registered agent",
    suggestion: "Verify the agent keypair matches one registered on the vault.",
  },
  6004: {
    name: "ProtocolNotAllowed",
    message: "Protocol not allowed by policy",
    suggestion: "Add the protocol to the vault's allowlist.",
  },
  6005: {
    name: "TransactionTooLarge",
    message: "Transaction exceeds maximum single transaction size",
    suggestion: "Reduce the amount or increase maxTransactionSizeUsd.",
  },
  6006: {
    name: "DailyCapExceeded",
    message: "Daily spending cap would be exceeded",
    suggestion:
      "Wait for the 24h rolling window to reset or increase dailySpendingCapUsd.",
  },
  6007: {
    name: "LeverageTooHigh",
    message: "Leverage exceeds maximum allowed",
    suggestion: "Reduce leverage or increase maxLeverageBps.",
  },
  6008: {
    name: "TooManyPositions",
    message: "Maximum concurrent open positions reached",
    suggestion: "Close an existing position before opening a new one.",
  },
  6009: {
    name: "PositionOpeningDisallowed",
    message: "Cannot open new positions (policy disallows)",
    suggestion: "Set canOpenPositions to true in the vault policy.",
  },
  6029: {
    name: "DestinationNotAllowed",
    message: "Destination not in allowed list",
    suggestion: "Add the destination to allowedDestinations.",
  },
  6037: {
    name: "SlippageTooHigh",
    message: "Slippage exceeds policy max_slippage_bps",
    suggestion: "Reduce slippage tolerance or increase maxSlippageBps.",
  },
  6047: {
    name: "InsufficientPermissions",
    message: "Agent lacks permission for this action type",
    suggestion: "Update the agent's permission bitmask to include this action.",
  },
  6063: {
    name: "AgentSpendLimitExceeded",
    message: "Agent's rolling 24h spend exceeds their individual limit",
    suggestion:
      "Wait for the rolling window or increase the agent's spending_limit_usd.",
  },
  6074: {
    name: "AgentPaused",
    message: "Agent is paused and cannot execute actions",
    suggestion:
      "The vault owner has paused this agent. Contact the owner to unpause.",
  },
  6075: {
    name: "AgentAlreadyPaused",
    message: "Agent is already paused",
    suggestion: "The agent is already paused — no action needed.",
  },
  6076: {
    name: "AgentNotPaused",
    message: "Agent is not paused",
    suggestion:
      "Cannot unpause an agent that is not paused. Check agent status first.",
  },
};

/**
 * Parse an on-chain error into a structured PhalnxSDKError.
 * Returns null if the error is not a recognized Anchor program error.
 */
export function parseOnChainError(error: unknown): PhalnxSDKError | null {
  const code = extractErrorCode(error);
  if (code === null) return null;

  const entry = SDK_ERROR_MAP[code];
  if (!entry) {
    return new PhalnxSDKError({
      code,
      name: "UnknownError",
      message: `Anchor error code ${code}`,
      suggestion: "Check the transaction logs for details.",
    });
  }

  return new PhalnxSDKError({
    code,
    name: entry.name,
    message: entry.message,
    suggestion: entry.suggestion,
  });
}

/**
 * Create a precheck failure error with structured metadata.
 */
export function precheckError(opts: {
  check: string;
  expected: string;
  actual: string;
  suggestion: string;
}): PhalnxSDKError {
  return new PhalnxSDKError({
    code: -1,
    name: "PrecheckFailed",
    message: `Precheck failed: ${opts.check}`,
    expected: opts.expected,
    actual: opts.actual,
    field: opts.check,
    suggestion: opts.suggestion,
  });
}

function extractErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  if (typeof e.code === "number" && e.code >= 6000) return e.code;

  if (e.error && typeof e.error === "object") {
    const inner = e.error as Record<string, unknown>;
    if (inner.errorCode && typeof inner.errorCode === "object") {
      const ec = inner.errorCode as Record<string, unknown>;
      if (typeof ec.number === "number") return ec.number;
    }
  }

  // Try parsing from error message (SendTransactionError logs)
  if (e.message && typeof e.message === "string") {
    const match = e.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      if (code >= 6000) return code;
    }
  }

  return null;
}
