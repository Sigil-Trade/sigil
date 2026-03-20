import {
  Connection,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";

export interface SimulateOptions {
  replaceRecentBlockhash?: boolean;
  accountAddresses?: string[];
}

export interface SimulationError {
  message: string;
  anchorCode?: number;
  anchorName?: string;
  suggestion?: string;
  logs?: string[];
}

export interface SimulationResult {
  success: boolean;
  unitsConsumed?: number;
  logs?: string[];
  returnData?: SimulatedTransactionResponse["returnData"];
  accounts?: SimulatedTransactionResponse["accounts"];
  error?: SimulationError;
}

/**
 * Detect whether a Connection is pointed at a Helius RPC endpoint.
 */
export function isHeliusConnection(connection: Connection): boolean {
  try {
    const endpoint = (connection as any)._rpcEndpoint as string | undefined;
    return endpoint ? /helius/i.test(endpoint) : false;
  } catch {
    return false;
  }
}

/**
 * All Phalnx Anchor error codes (6000–6069) mapped to human-readable names and suggestions.
 */
export const ANCHOR_ERROR_MAP: Record<
  number,
  { name: string; suggestion: string }
> = {
  6000: {
    name: "VaultNotActive",
    suggestion: "Check vault status — it may be frozen or closed.",
  },
  6001: {
    name: "UnauthorizedAgent",
    suggestion: "The signing key is not a registered agent for this vault.",
  },
  6002: {
    name: "UnauthorizedOwner",
    suggestion: "Only the vault owner can call this instruction.",
  },
  6003: {
    name: "UnsupportedToken",
    suggestion: "Use USDC or USDT — only supported stablecoins are accepted.",
  },
  6004: {
    name: "ProtocolNotAllowed",
    suggestion:
      "This protocol is not in the vault's allowlist. Update policy to include it.",
  },
  6005: {
    name: "TransactionTooLarge",
    suggestion: "Break the transaction into smaller parts.",
  },
  6006: {
    name: "SpendingCapExceeded",
    suggestion:
      "Rolling 24h spending cap would be exceeded. Wait or increase the cap.",
  },
  6007: {
    name: "LeverageTooHigh",
    suggestion: "Reduce leverage to within the policy's maxLeverage limit.",
  },
  6008: {
    name: "TooManyPositions",
    suggestion: "Close an existing position before opening a new one.",
  },
  6009: {
    name: "PositionOpeningDisallowed",
    suggestion:
      "Policy does not allow opening new positions. Update policy if needed.",
  },
  6010: {
    name: "SessionNotAuthorized",
    suggestion: "No active session. Call validate_and_authorize first.",
  },
  6011: {
    name: "InvalidSession",
    suggestion:
      "Session does not belong to this vault or is for escrow actions.",
  },
  6012: {
    name: "OpenPositionsExist",
    suggestion: "Close all positions before closing the vault.",
  },
  6013: {
    name: "TooManyAllowedProtocols",
    suggestion:
      "Maximum 10 protocols allowed. Remove some before adding new ones.",
  },
  6014: {
    name: "AgentAlreadyRegistered",
    suggestion: "This agent is already registered for the vault.",
  },
  6015: {
    name: "NoAgentRegistered",
    suggestion: "Register an agent before attempting agent operations.",
  },
  6016: {
    name: "VaultNotFrozen",
    suggestion: "Vault must be frozen (all agents revoked) to reactivate.",
  },
  6017: {
    name: "VaultAlreadyClosed",
    suggestion: "This vault is permanently closed and cannot be used.",
  },
  6018: {
    name: "InsufficientBalance",
    suggestion: "Vault does not have enough tokens. Deposit more funds.",
  },
  6019: {
    name: "DeveloperFeeTooHigh",
    suggestion: "Developer fee rate must be ≤ 500 (5 BPS = 0.05%).",
  },
  6020: {
    name: "InvalidFeeDestination",
    suggestion:
      "Fee destination must match the vault's configured fee_destination.",
  },
  6021: {
    name: "InvalidProtocolTreasury",
    suggestion: "Protocol treasury address does not match expected.",
  },
  6022: {
    name: "InvalidAgentKey",
    suggestion: "Agent public key cannot be the zero address.",
  },
  6023: {
    name: "AgentIsOwner",
    suggestion: "The vault owner cannot also be registered as an agent.",
  },
  6024: {
    name: "Overflow",
    suggestion: "Arithmetic overflow — amount too large or calculation error.",
  },
  6025: {
    name: "InvalidTokenAccount",
    suggestion: "Token account does not belong to vault or has wrong mint.",
  },
  6026: {
    name: "TimelockNotExpired",
    suggestion: "Wait for the timelock period to expire before applying.",
  },
  6027: {
    name: "TimelockActive",
    suggestion:
      "Vault has timelock — use queue_policy_update instead of direct update.",
  },
  6028: {
    name: "NoTimelockConfigured",
    suggestion: "This vault has no timelock. Use update_policy directly.",
  },
  6029: {
    name: "DestinationNotAllowed",
    suggestion: "Transfer destination is not in the allowed destinations list.",
  },
  6030: {
    name: "TooManyDestinations",
    suggestion: "Maximum 10 allowed destinations. Remove some before adding.",
  },
  6031: {
    name: "InvalidProtocolMode",
    suggestion:
      "Protocol mode must be 0 (all), 1 (allowlist), or 2 (denylist).",
  },
  6032: {
    name: "InvalidNonSpendingAmount",
    suggestion:
      "Non-spending actions (close, cancel, etc.) must have amount = 0.",
  },
  6033: {
    name: "NoPositionsToClose",
    suggestion: "No open positions to close or cancel.",
  },
  6034: {
    name: "CpiCallNotAllowed",
    suggestion:
      "validate_and_authorize must be called as a top-level instruction, not via CPI.",
  },
  6035: {
    name: "MissingFinalizeInstruction",
    suggestion:
      "Transaction must include finalize_session after validate_and_authorize.",
  },
  6036: {
    name: "NonTrackedSwapMustReturnStablecoin",
    suggestion: "Non-stablecoin swaps must output to a stablecoin (USDC/USDT).",
  },
  6037: {
    name: "SwapSlippageExceeded",
    suggestion:
      "Swap slippage exceeds policy max_slippage_bps. Reduce slippage tolerance or update policy.",
  },
  6038: {
    name: "InvalidJupiterInstruction",
    suggestion:
      "Cannot parse Jupiter swap instruction data. Verify instruction format.",
  },
  6039: {
    name: "UnauthorizedTokenTransfer",
    suggestion:
      "Top-level SPL Token transfers are blocked between validate and finalize.",
  },
  6040: {
    name: "SlippageBpsTooHigh",
    suggestion: "max_slippage_bps cannot exceed 5000 (50%).",
  },
  6041: {
    name: "ProtocolMismatch",
    suggestion:
      "DeFi instruction program does not match declared target_protocol.",
  },
  6042: {
    name: "TooManyDeFiInstructions",
    suggestion: "Non-stablecoin swaps allow exactly one DeFi instruction.",
  },
  6043: {
    name: "MaxAgentsReached",
    suggestion:
      "Vault already has 10 agents. Remove one before adding another.",
  },
  6044: {
    name: "InsufficientPermissions",
    suggestion:
      "Agent lacks permission for this action type. Update permissions.",
  },
  6045: {
    name: "InvalidPermissions",
    suggestion:
      "Permission bitmask contains invalid bits beyond the 21 defined action types.",
  },
  6046: {
    name: "EscrowNotActive",
    suggestion: "Escrow is not in Active status.",
  },
  6047: {
    name: "EscrowExpired",
    suggestion: "Escrow has expired. Use refund_escrow to reclaim funds.",
  },
  6048: {
    name: "EscrowNotExpired",
    suggestion: "Cannot refund escrow before expiry. Wait or settle instead.",
  },
  6049: {
    name: "InvalidEscrowVault",
    suggestion: "Source or destination vault does not match the escrow.",
  },
  6050: {
    name: "EscrowConditionsNotMet",
    suggestion: "SHA-256 proof does not match escrow condition_hash.",
  },
  6051: {
    name: "EscrowDurationExceeded",
    suggestion: "Escrow duration exceeds 30-day maximum.",
  },
  6052: {
    name: "InvalidConstraintConfig",
    suggestion:
      "Constraint configuration exceeds bounds (max 10 entries, 5 constraints each).",
  },
  6053: {
    name: "ConstraintViolated",
    suggestion: "Instruction data violates a configured constraint.",
  },
  6054: {
    name: "InvalidConstraintsPda",
    suggestion:
      "Constraints PDA does not match expected address for this vault.",
  },
  6055: {
    name: "InvalidPendingConstraintsPda",
    suggestion: "Pending constraints PDA does not match expected address.",
  },
  6056: {
    name: "AgentSpendLimitExceeded",
    suggestion: "Agent's rolling 24h spend exceeds per-agent spending limit.",
  },
  6057: {
    name: "OverlaySlotExhausted",
    suggestion:
      "Per-agent overlay is full; cannot register agent with spending limit.",
  },
  6058: {
    name: "AgentSlotNotFound",
    suggestion:
      "Agent has per-agent spending limit but no overlay tracking slot.",
  },
  6059: {
    name: "UnauthorizedTokenApproval",
    suggestion:
      "Unauthorized SPL Token Approve between validate and finalize.",
  },
  6060: {
    name: "InvalidSessionExpiry",
    suggestion: "Session expiry slots out of range (10-450).",
  },
  6061: {
    name: "UnconstrainedProgramBlocked",
    suggestion:
      "Program has no constraint entry and strict mode is enabled.",
  },
  6062: {
    name: "ProtocolCapExceeded",
    suggestion:
      "Per-protocol rolling 24h spending cap would be exceeded.",
  },
  6063: {
    name: "ProtocolCapsMismatch",
    suggestion:
      "protocol_caps length must match protocols length when has_protocol_caps is true.",
  },
  6064: {
    name: "ActiveEscrowsExist",
    suggestion:
      "Cannot close vault with active escrow deposits.",
  },
  6065: {
    name: "ConstraintsNotClosed",
    suggestion:
      "Instruction constraints must be closed before closing vault.",
  },
  6066: {
    name: "PendingPolicyExists",
    suggestion:
      "Pending policy update must be applied or cancelled before closing vault.",
  },
  6067: {
    name: "AgentPaused",
    suggestion:
      "Agent is paused and cannot execute actions.",
  },
  6068: {
    name: "AgentAlreadyPaused",
    suggestion: "Agent is already paused.",
  },
  6069: {
    name: "AgentNotPaused",
    suggestion: "Agent is not paused.",
  },
};

/**
 * Parse Anchor error information from simulation logs.
 */
function parseAnchorError(
  logs: string[],
): { code: number; name: string } | null {
  for (const log of logs) {
    // Pattern: "Error Code: VaultNotActive. Error Number: 6000"
    const named = log.match(/Error Code: (\w+)\.\s*Error Number: (\d+)/);
    if (named) {
      return { code: parseInt(named[2], 10), name: named[1] };
    }

    // Pattern: "custom program error: 0x1770"
    const hex = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hex) {
      const code = parseInt(hex[1], 16);
      const entry = ANCHOR_ERROR_MAP[code];
      return { code, name: entry?.name ?? `UnknownError(${code})` };
    }
  }

  return null;
}

/**
 * Simulate a versioned transaction and return structured results with
 * Anchor error parsing.
 */
export async function simulateTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  options?: SimulateOptions,
): Promise<SimulationResult> {
  const replaceRecentBlockhash = options?.replaceRecentBlockhash ?? true;

  const config: any = {
    replaceRecentBlockhash,
    sigVerify: false,
    commitment: "confirmed",
  };
  if (options?.accountAddresses) {
    config.accounts = {
      encoding: "base64",
      addresses: options.accountAddresses,
    };
  }

  const response = await connection.simulateTransaction(tx, config);

  const { err, logs, unitsConsumed, returnData, accounts } = response.value;

  if (!err) {
    return {
      success: true,
      unitsConsumed: unitsConsumed ?? undefined,
      logs: logs ?? undefined,
      returnData: returnData ?? undefined,
      accounts: accounts ?? undefined,
    };
  }

  // Parse Anchor error from logs
  const anchorError = logs ? parseAnchorError(logs) : null;
  const mapEntry = anchorError ? ANCHOR_ERROR_MAP[anchorError.code] : undefined;

  const errorMessage = typeof err === "string" ? err : JSON.stringify(err);

  return {
    success: false,
    unitsConsumed: unitsConsumed ?? undefined,
    logs: logs ?? undefined,
    returnData: returnData ?? undefined,
    accounts: accounts ?? undefined,
    error: {
      message: errorMessage,
      anchorCode: anchorError?.code,
      anchorName: anchorError?.name ?? mapEntry?.name,
      suggestion: mapEntry?.suggestion,
      logs: logs ?? undefined,
    },
  };
}
