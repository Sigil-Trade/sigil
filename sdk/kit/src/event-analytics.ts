/**
 * Event analytics — activity feed, event categorization, human-readable descriptions.
 *
 * Transforms raw Anchor event logs into dashboard-ready activity items.
 * The Activity tab is the second most-used dashboard feature after Overview.
 */

import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import type { DecodedPhalnxEvent, PhalnxEventName } from "./events.js";
import { parseAndDecodePhalnxEvents } from "./events.js";
import { formatUsd, formatAddress, formatTokenAmount } from "./formatting.js";
import { resolveToken } from "./tokens.js";
import { parseActionType, type Network } from "./types.js";
import { resolveProtocolName } from "./protocol-names.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type EventCategory =
  | "trade"
  | "deposit"
  | "withdrawal"
  | "policy"
  | "agent"
  | "escrow"
  | "security"
  | "fee";

export interface VaultActivityItem {
  timestamp: number;
  txSignature: string;
  eventType: PhalnxEventName;
  category: EventCategory;
  agent: Address | null;
  amount: bigint | null;
  amountDisplay: string | null;
  tokenMint: Address | null;
  tokenSymbol: string | null;
  actionType: string | null;
  protocol: Address | null;
  protocolName: string | null;
  success: boolean;
  description: string;
}

// ─── Event Category Map ──────────────────────────────────────────────────────

const EVENT_CATEGORY_MAP: Record<string, EventCategory> = {
  ActionAuthorized: "trade",
  SessionFinalized: "trade",
  DelegationRevoked: "trade",
  AgentTransferExecuted: "trade",
  AgentSpendLimitChecked: "trade",
  PositionsSynced: "trade",
  FundsDeposited: "deposit",
  FundsWithdrawn: "withdrawal",
  PolicyUpdated: "policy",
  PolicyChangeQueued: "policy",
  PolicyChangeApplied: "policy",
  PolicyChangeCancelled: "policy",
  InstructionConstraintsCreated: "policy",
  InstructionConstraintsUpdated: "policy",
  InstructionConstraintsClosed: "policy",
  ConstraintsChangeQueued: "policy",
  ConstraintsChangeApplied: "policy",
  ConstraintsChangeCancelled: "policy",
  AgentRegistered: "agent",
  AgentRevoked: "agent",
  AgentPermissionsUpdated: "agent",
  AgentUnpausedEvent: "agent",
  VaultCreated: "security",
  VaultFrozen: "security",
  VaultReactivated: "security",
  VaultClosed: "security",
  AgentPausedEvent: "security",
  FeesCollected: "fee",
  EscrowCreated: "escrow",
  EscrowSettled: "escrow",
  EscrowRefunded: "escrow",
};

/** Categorize a decoded event into a high-level group. Defaults to "trade". */
export function categorizeEvent(eventName: string): EventCategory {
  return EVENT_CATEGORY_MAP[eventName] ?? "trade";
}

// ─── Event Description ───────────────────────────────────────────────────────

/**
 * Generate a human-readable description for a decoded event.
 * Uses fintech language — no raw error codes or program IDs.
 */
export function describeEvent(
  decoded: DecodedPhalnxEvent,
  network: Network = "mainnet-beta",
): string {
  const f = decoded.fields;
  if (!f) return `${decoded.name} event (details unavailable)`;

  switch (decoded.name) {
    case "ActionAuthorized": {
      const agent = formatAddress(f.agent as string);
      const amount = f.usdAmount as bigint;
      const actionObj = f.actionType as { __kind: string } | undefined;
      const actionStr = actionObj?.__kind ?? "action";
      return `Agent ${agent} authorized ${formatUsd(amount, 2)} ${actionStr} on ${resolveProtocolName(f.protocol as string)}`;
    }

    case "SessionFinalized": {
      const agent = formatAddress(f.agent as string);
      const success = f.success as boolean;
      const isExpired = f.isExpired as boolean;
      const spend = (f.actualSpendUsd as bigint) ?? 0n;

      if (isExpired) return `Session for agent ${agent} expired and was cleaned up`;
      if (!success) return `Agent ${agent} session finalized (action failed)`;
      if (spend > 0n) return `Agent ${agent} completed trade — ${formatUsd(spend, 2)} spent`;
      return `Agent ${agent} completed action successfully`;
    }

    case "FundsDeposited": {
      const amount = f.amount as bigint;
      const mint = f.tokenMint as string;
      const token = resolveTokenSafe(mint, network);
      return `Owner deposited ${formatTokenDisplay(amount, token)}`;
    }

    case "FundsWithdrawn": {
      const amount = f.amount as bigint;
      const mint = f.tokenMint as string;
      const token = resolveTokenSafe(mint, network);
      return `Owner withdrew ${formatTokenDisplay(amount, token)}`;
    }

    case "AgentRegistered":
      return `New agent ${formatAddress(f.agent as string)} registered with vault access`;

    case "AgentRevoked":
      return `Agent ${formatAddress(f.agent as string)} removed from vault (${f.remainingAgents} remaining)`;

    case "AgentPermissionsUpdated": {
      const permCount = countBits(f.newPermissions as bigint);
      return `Agent ${formatAddress(f.agent as string)} permissions updated (${permCount} of 21 actions enabled)`;
    }

    case "VaultFrozen":
      return "Vault paused — all agent activity stopped";
    case "VaultReactivated":
      return "Vault reactivated — agent activity resumed";
    case "VaultClosed":
      return "Vault permanently closed";
    case "VaultCreated":
      return "Vault created and ready for configuration";

    case "AgentPausedEvent":
      return `Agent ${formatAddress(f.agent as string)} paused — cannot execute actions`;
    case "AgentUnpausedEvent":
      return `Agent ${formatAddress(f.agent as string)} resumed — can execute actions`;

    case "FeesCollected": {
      const protocolFee = f.protocolFeeAmount as bigint;
      const devFee = f.developerFeeAmount as bigint;
      return `Fees collected: ${formatUsd(protocolFee + devFee, 2)} (${formatUsd(protocolFee, 2)} protocol + ${formatUsd(devFee, 2)} developer)`;
    }

    case "PolicyUpdated":
      return "Vault policy updated — new spending rules active";
    case "PolicyChangeQueued":
      return "Policy change queued — waiting for timelock to expire";
    case "PolicyChangeApplied":
      return "Queued policy change applied";
    case "PolicyChangeCancelled":
      return "Queued policy change cancelled";

    case "EscrowCreated":
      return `Escrow created: ${formatUsd(f.amount as bigint, 2)} held for vault ${formatAddress(f.destinationVault as string)}`;
    case "EscrowSettled":
      return `Escrow settled — ${formatUsd(f.amount as bigint, 2)} released to destination`;
    case "EscrowRefunded":
      return `Escrow refunded — ${formatUsd(f.amount as bigint, 2)} returned to vault`;

    case "AgentTransferExecuted":
      return `Agent transferred ${formatUsd(f.amount as bigint, 2)} to ${formatAddress(f.destination as string)}`;

    case "AgentSpendLimitChecked":
      return `Agent ${formatAddress(f.agent as string)} spend check: ${formatUsd(f.agentRollingSpend as bigint, 2)} of ${formatUsd(f.spendingLimitUsd as bigint, 2)} daily limit used`;

    case "DelegationRevoked":
      return "Token delegation revoked after session completion";

    case "PositionsSynced":
      return `Position count synced: ${f.oldCount} → ${f.newCount}`;

    case "InstructionConstraintsCreated":
      return "Instruction constraints configured for this vault";
    case "InstructionConstraintsUpdated":
      return "Instruction constraints updated";
    case "InstructionConstraintsClosed":
      return "Instruction constraints removed";
    case "ConstraintsChangeQueued":
      return "Constraint change queued — waiting for timelock";
    case "ConstraintsChangeApplied":
      return "Queued constraint change applied";
    case "ConstraintsChangeCancelled":
      return "Queued constraint change cancelled";

    default:
      return `${decoded.name} event`;
  }
}

// ─── Activity Item Builder ───────────────────────────────────────────────────

/**
 * Build a VaultActivityItem from a decoded event + transaction metadata.
 * Main entry point for the activity feed.
 */
export function buildActivityItem(
  decoded: DecodedPhalnxEvent,
  txSignature: string,
  blockTime: number,
  network: Network = "mainnet-beta",
): VaultActivityItem {
  const f = decoded.fields;
  const category = categorizeEvent(decoded.name);

  const agent = extractAddress(f, "agent");
  const amount = extractBigInt(f, "amount") ?? extractBigInt(f, "usdAmount");
  const tokenMint = extractAddress(f, "tokenMint") ?? extractAddress(f, "mint");
  const protocol = extractAddress(f, "protocol");
  const success = f?.success !== false;

  const token = tokenMint ? resolveTokenSafe(tokenMint, network) : null;
  const amountDisplay =
    amount !== null && token
      ? formatTokenDisplay(amount, token)
      : amount !== null
        ? formatUsd(amount, 2)
        : null;

  // actionType has different shapes: Codama enum { __kind: "Swap" } vs u8 number
  let actionType: string | null = null;
  if (f?.actionType != null) {
    const at = f.actionType;
    if (typeof at === "object" && at !== null && "__kind" in at) {
      actionType = (at as { __kind: string }).__kind;
    } else if (typeof at === "number" || typeof at === "bigint") {
      actionType = parseActionType(Number(at))?.toString() ?? null;
    }
  }

  return {
    timestamp: blockTime,
    txSignature,
    eventType: decoded.name,
    category,
    agent,
    amount,
    amountDisplay,
    tokenMint,
    tokenSymbol: token?.symbol ?? null,
    actionType,
    protocol,
    protocolName: protocol ? resolveProtocolName(protocol) : null,
    success,
    description: describeEvent(decoded, network),
  };
}

// ─── Activity Feed Fetcher ───────────────────────────────────────────────────

/**
 * Fetch and build a complete activity feed for a vault.
 * Uses getSignaturesForAddress + getTransaction (standard RPC).
 * For better performance, use Helius Enhanced Transactions API in the dashboard.
 */
export async function getVaultActivity(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  limit = 20,
  network: Network = "mainnet-beta",
): Promise<VaultActivityItem[]> {
  const signatures = await rpc
    .getSignaturesForAddress(vault, { limit })
    .send();

  if (signatures.length === 0) return [];

  const items: VaultActivityItem[] = [];

  for (const sigInfo of signatures) {
    try {
      const tx = await rpc
        .getTransaction(sigInfo.signature, {
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send();

      if (!tx?.meta?.logMessages) continue;

      const decoded = parseAndDecodePhalnxEvents([...tx.meta.logMessages]);
      for (const event of decoded) {
        items.push(
          buildActivityItem(
            event,
            sigInfo.signature,
            Number(sigInfo.blockTime ?? 0),
            network,
          ),
        );
      }
    } catch {
      continue;
    }
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function extractAddress(
  fields: Record<string, unknown> | null,
  key: string,
): Address | null {
  if (!fields || !(key in fields)) return null;
  const val = fields[key];
  if (typeof val === "string" && val.length > 0) return val as Address;
  return null;
}

function extractBigInt(
  fields: Record<string, unknown> | null,
  key: string,
): bigint | null {
  if (!fields || !(key in fields)) return null;
  const val = fields[key];
  if (typeof val === "bigint") return val;
  return null;
}

function countBits(n: bigint): number {
  let count = 0;
  let v = n;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
}

function resolveTokenSafe(
  mint: string,
  network: Network,
): { symbol: string; decimals: number } | null {
  try {
    return resolveToken(mint, network);
  } catch {
    return null;
  }
}

/** Format token amount for display — delegates to formatting.ts with 2-decimal truncation. */
function formatTokenDisplay(
  amount: bigint,
  token: { symbol: string; decimals: number } | null,
): string {
  if (!token) return formatUsd(amount);
  return formatTokenAmount(amount, token.decimals, token.symbol, 2);
}
