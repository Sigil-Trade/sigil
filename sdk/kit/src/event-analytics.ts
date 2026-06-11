/**
 * Event analytics — activity feed, event categorization, human-readable descriptions.
 *
 * Transforms raw Anchor event logs into dashboard-ready activity items.
 * The Activity tab is the second most-used dashboard feature after Overview.
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import type { DecodedSigilEvent, SigilEventName } from "./events.js";
import { parseAndDecodeSigilEvents } from "./events.js";
import { formatUsd, formatAddress, formatTokenAmount } from "./formatting.js";
import { resolveToken } from "./tokens.js";
import { type Network } from "./types.js";
import { resolveProtocolName } from "./protocol-names.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type EventCategory =
  | "trade"
  | "deposit"
  | "withdrawal"
  | "policy"
  | "agent"
  | "security"
  | "fee";

export interface VaultActivityItem {
  timestamp: number;
  txSignature: string;
  eventType: SigilEventName;
  category: EventCategory;
  agent: Address | null;
  amount: bigint | null;
  amountDisplay: string | null;
  tokenMint: Address | null;
  tokenSymbol: string | null;
  /** Whether this was a spending action (amount > 0). */
  isSpending: boolean;
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
  FundsDeposited: "deposit",
  FundsWithdrawn: "withdrawal",
  // V2: PolicyUpdated removed — replaced by ChangeQueued/Applied/Cancelled
  PolicyChangeQueued: "policy",
  PolicyChangeApplied: "policy",
  PolicyChangeCancelled: "policy",
  InstructionConstraintsCreated: "policy",
  // V2 (MED-2 cleanup): InstructionConstraintsUpdated / InstructionConstraintsClosed
  // were replaced by ConstraintsChangeApplied / CloseConstraintsApplied. Dead
  // entries removed to prevent stale event-name matches.
  ConstraintsChangeQueued: "policy",
  ConstraintsChangeApplied: "policy",
  ConstraintsChangeCancelled: "policy",
  CloseConstraintsQueued: "policy",
  CloseConstraintsApplied: "policy",
  CloseConstraintsCancelled: "policy",
  AgentRegistered: "agent",
  AgentRevoked: "agent",
  // V2: AgentPermissionsUpdated removed — replaced by ChangeQueued/Applied/Cancelled
  AgentPermissionsChangeQueued: "agent",
  AgentPermissionsChangeApplied: "agent",
  AgentPermissionsChangeCancelled: "agent",
  AgentUnpausedEvent: "agent",
  VaultCreated: "security",
  VaultFrozen: "security",
  VaultReactivated: "security",
  VaultClosed: "security",
  AgentPausedEvent: "security",
  FeesCollected: "fee",
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
  decoded: DecodedSigilEvent,
  network: Network = "mainnet-beta",
): string {
  const f = decoded.fields;
  if (!f) return `${decoded.name} event (details unavailable)`;

  switch (decoded.name) {
    case "ActionAuthorized": {
      const agent = formatAddress(f.agent as string);
      const amount = f.usdAmount as bigint;
      const actionStr = amount > 0n ? "spending" : "action";
      return `Agent ${agent} authorized ${formatUsd(amount, 2)} ${actionStr} on ${resolveProtocolName(f.protocol as string)}`;
    }

    case "SessionFinalized": {
      const agent = formatAddress(f.agent as string);
      const success = f.success as boolean;
      const isExpired = f.isExpired as boolean;
      const spend = (f.actualSpendUsd as bigint) ?? 0n;

      if (isExpired)
        return `Session for agent ${agent} expired and was cleaned up`;
      if (!success) return `Agent ${agent} session finalized (action failed)`;
      if (spend > 0n)
        return `Agent ${agent} completed trade — ${formatUsd(spend, 2)} spent`;
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

    case "AgentPermissionsChangeQueued":
      return `Agent ${formatAddress(f.agent as string)} permissions change queued (timelock pending)`;
    case "AgentPermissionsChangeApplied":
      return `Agent ${formatAddress(f.agent as string)} permissions change applied`;
    case "AgentPermissionsChangeCancelled":
      return `Agent ${formatAddress(f.agent as string)} permissions change cancelled`;

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

    case "PolicyChangeQueued":
      return "Policy change queued — waiting for timelock to expire";
    case "PolicyChangeApplied":
      return "Queued policy change applied";
    case "PolicyChangeCancelled":
      return "Queued policy change cancelled";

    case "AgentTransferExecuted":
      return `Agent transferred ${formatUsd(f.amount as bigint, 2)} to ${formatAddress(f.destination as string)}`;

    case "AgentSpendLimitChecked":
      return `Agent ${formatAddress(f.agent as string)} spend check: ${formatUsd(f.agentRollingSpend as bigint, 2)} of ${formatUsd(f.spendingLimitUsd as bigint, 2)} daily limit used`;

    case "DelegationRevoked":
      return "Token delegation revoked after session completion";

    case "InstructionConstraintsCreated":
      return "Instruction constraints configured for this vault";
    case "ConstraintsChangeQueued":
      return "Constraint change queued — waiting for timelock";
    case "ConstraintsChangeApplied":
      return "Queued constraint change applied";
    case "ConstraintsChangeCancelled":
      return "Queued constraint change cancelled";
    case "CloseConstraintsQueued":
      return "Constraint close queued — waiting for timelock";
    case "CloseConstraintsApplied":
      return "Instruction constraints closed";
    case "CloseConstraintsCancelled":
      return "Queued constraint close cancelled";

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
  decoded: DecodedSigilEvent,
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

  // V2 Option A: isSpending derived from amount > 0. The on-chain event no
  // longer carries an isSpending field, and the legacy ActionType decoding is
  // dead (position counter + ActionType deleted 2026-04-19).
  const isSpending = amount !== null && amount > 0n;

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
    isSpending,
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
  const signatures = await rpc.getSignaturesForAddress(vault, { limit }).send();

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

      const decoded = parseAndDecodeSigilEvents([...tx.meta.logMessages]);
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
