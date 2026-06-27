/**
 * Event analytics — activity feed, event categorization, human-readable descriptions.
 *
 * Transforms raw Anchor event logs into dashboard-ready activity items.
 * The Activity tab is the second most-used dashboard feature after Overview.
 */

import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
} from "./kit-adapter.js";
import { AccountRole, getBase58Encoder } from "./kit-adapter.js";
import type { DecodedSigilEvent, SigilEventName } from "./events.js";
import { parseAndDecodeSigilEvents } from "./events.js";
import { formatUsd, formatAddress, formatTokenAmount } from "./formatting.js";
import { resolveToken } from "./tokens.js";
import { type Network } from "./types.js";
import { resolveProtocolName } from "./protocol-names.js";
import { SIGIL_PROGRAM_ADDRESS } from "./generated/programs/index.js";
import { IDL_ERROR_MAP } from "./errors/agent-errors.generated.js";
import {
  VALIDATE_AND_AUTHORIZE_DISCRIMINATOR,
  parseValidateAndAuthorizeInstruction,
} from "./generated/instructions/validateAndAuthorize.js";
import { ON_CHAIN_ERROR_MAP, type ErrorCategory } from "./agent-errors.js";

/** base58 → bytes encoder, built once (the factory allocates closures). */
const BASE58_ENCODER = getBase58Encoder();

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

// ─── Blocked-Attempt Reconstruction ──────────────────────────────────────────
//
// A Sigil policy block (`return Err(...)`) in validate_and_authorize reverts the
// WHOLE transaction. A reverted tx emits no Anchor event and writes nothing
// on-chain, so a blocked attempt exists ONLY in the failed transaction's program
// logs. The helpers below reconstruct ONE blocked VaultActivityItem from those
// logs + the (already-fetched) transaction. Everything here is reconstructed
// best-effort from untrusted RPC data — see the per-field honesty notes.

/** Minimal shape of the JSON-encoded `getTransaction` result this module reads. */
interface JsonTxLike {
  meta?: {
    err?: unknown;
    logMessages?: readonly string[] | null;
  } | null;
  transaction?: {
    message?: {
      header?: {
        numRequiredSignatures: number;
      };
      accountKeys?: readonly string[];
      instructions?: readonly {
        programIdIndex: number;
        accounts: readonly number[];
        data: string;
      }[];
    };
  };
}

/**
 * Parse the Sigil on-chain error code from a failed transaction's program logs.
 *
 * SECURITY MODEL — `Program log:` content is attacker-controlled free text (any
 * program, including one an attacker's wrapper CPIs into, can emit a lookalike
 * `AnchorError ... Error Number: 6006.` line). The ONLY runtime-emitted,
 * program-ID-scoped, unspoofable signal of a Sigil failure is the runtime line
 * `Program <SIGIL_ID> failed: custom program error: 0x<hex>`. So the code is
 * extracted from THAT line, and only when Sigil failed as the TOP-LEVEL program
 * (invoke depth 1). The Anchor `Error Number:` log line is used only as a
 * fallback reason when it appears INSIDE the Sigil top-level frame and the
 * runtime `failed:` line lacks a parsable hex — never from a nested or
 * out-of-frame line. This rejects:
 *   - a wrapper program that CPIs Sigil (depth ≥2) and lets a caught Sigil error
 *     surface in logs while the tx fails for another reason (false positive);
 *   - a nested non-Sigil program returning an in-range `custom program error`
 *     (hex collision) — its `failed:` line is not `Program <SIGIL_ID> failed:`;
 *   - memo/log injection of `0x1776` text outside a Sigil frame.
 * A code is accepted ONLY if it is a real Sigil error (present in IDL_ERROR_MAP,
 * 6000–6117); a downstream/venue failure (e.g. `0x1`) yields null → no row.
 *
 * @returns the Sigil error code, or null if none is attributable to Sigil.
 */
export function parseSigilBlockErrorCode(
  logs: readonly string[],
): number | null {
  const sigilId = SIGIL_PROGRAM_ADDRESS as string;
  // Whether Sigil is CURRENTLY the TOP-LEVEL frame (`invoke [1]`). Sigil's
  // enforced top-level requirement means a legitimate, authoritative block is
  // the program failing at depth 1; nested (CPI'd) Sigil failures are ignored.
  let sigilAtTopLevel = false;
  // Last Anchor `Error Number:` seen while Sigil was the top-level frame — used
  // only as a reason fallback for the trusted depth-1 `failed:` line below.
  let pendingTopLevelAnchorCode: number | null = null;

  for (const log of logs) {
    // ── Frame tracking (use the actual runtime `[N]` depth) ─────────────────
    if (log.startsWith(`Program ${sigilId} invoke [`)) {
      sigilAtTopLevel = matchInvokeDepth(log) === 1;
      // A new frame starts fresh — never carry a prior frame's reason forward
      // (defense-in-depth against malformed/forged log arrays; real Agave logs
      // always close a frame with success/failed before the next invoke).
      pendingTopLevelAnchorCode = null;
      continue;
    }
    if (log.startsWith(`Program ${sigilId} success`)) {
      sigilAtTopLevel = false;
      pendingTopLevelAnchorCode = null;
      continue;
    }

    // ── Trusted signal: runtime `Program <SIGIL_ID> failed:` at depth 1 ──────
    if (log.startsWith(`Program ${sigilId} failed:`)) {
      const isTopLevel = sigilAtTopLevel;
      sigilAtTopLevel = false;
      if (!isTopLevel) continue; // nested (CPI'd) Sigil failure is not authoritative
      const hex = matchCustomProgramError(log);
      if (hex !== null && isSigilErrorCode(hex)) return hex;
      // Runtime line had no parsable in-range hex — fall back to the Anchor
      // `Error Number:` captured from THIS top-level frame, if any.
      if (
        pendingTopLevelAnchorCode !== null &&
        isSigilErrorCode(pendingTopLevelAnchorCode)
      ) {
        return pendingTopLevelAnchorCode;
      }
      continue;
    }

    // ── Capture Anchor reason ONLY at Sigil top level (never trusted alone) ──
    if (sigilAtTopLevel) {
      const anchorCode = matchAnchorErrorNumber(log);
      if (anchorCode !== null) pendingTopLevelAnchorCode = anchorCode;
    }
  }

  return null;
}

/** Match the runtime invoke depth from `Program <id> invoke [N]`. */
function matchInvokeDepth(log: string): number | null {
  const m = log.match(/invoke \[(\d+)\]/);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/** True iff `code` is a real on-chain Sigil error (present in the IDL map). */
function isSigilErrorCode(code: number): boolean {
  return Object.prototype.hasOwnProperty.call(IDL_ERROR_MAP, code);
}

/**
 * Categories that mean the AGENT was stopped by policy — the ONLY failures
 * surfaced as "blocked attempts" in the feed. PERMISSION is excluded because it
 * mixes owner-auth (e.g. UnauthorizedOwner) with agent-auth; FATAL (internal),
 * INPUT_VALIDATION (config/malformed), TRANSIENT, and RESOURCE_NOT_FOUND are
 * not agent policy-blocks. So a failed OWNER tx (e.g. a rejected policy update)
 * never appears as a "blocked attempt".
 */
const AGENT_POLICY_BLOCK_CATEGORIES: ReadonlySet<ErrorCategory> =
  new Set<ErrorCategory>([
    "SPENDING_CAP",
    "POLICY_VIOLATION",
    "PROTOCOL_NOT_SUPPORTED",
    "RATE_LIMIT",
    "ESCALATION_REQUIRED",
  ]);

/** True iff `code` is a Sigil error whose category is an agent policy-block. */
function isAgentPolicyBlockCode(code: number): boolean {
  const category = ON_CHAIN_ERROR_MAP[code]?.category;
  return category !== undefined && AGENT_POLICY_BLOCK_CATEGORIES.has(category);
}

/** Match Anchor's `Error Number: <n>` and return the decimal code. */
function matchAnchorErrorNumber(log: string): number | null {
  const m = log.match(/Error Number: (\d+)/);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/** Match `custom program error: 0x<hex>` and return the decimal code. */
function matchCustomProgramError(log: string): number | null {
  const m = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 16);
  return Number.isNaN(n) ? null : n;
}

/**
 * Recover (agent, protocol, amount) for a blocked attempt by decoding the
 * `validate_and_authorize` instruction from the failed transaction.
 *
 * The JSON-encoded tx stores compiled instructions as INDICES into
 * `message.accountKeys`; this rehydrates the validate ix into a kit
 * `Instruction` (program address + account metas + raw data) and runs the
 * generated codama parser. All three values come straight off the agent's own
 * submitted instruction — they are what the agent ATTEMPTED, not on-chain
 * outcome. Returns null for any field that cannot be recovered; never guesses.
 *
 * SECURITY — the decoded `agent` meta is fully attacker-chosen (the on-chain
 * `agent == signer` check is exactly what FAILED on a block, so it cannot be
 * relied on post-revert). To avoid framing a victim agent in the owner's feed,
 * the recovered `agent` is kept ONLY if it is one of the transaction's actual
 * signers (the first `header.numRequiredSignatures` account keys); otherwise it
 * is nulled. protocol/amount are descriptive (the attempted target/size) and
 * carry no impersonation risk, so they are surfaced as-decoded.
 */
export function reconstructBlockedAttempt(tx: JsonTxLike): {
  agent: Address | null;
  protocol: Address | null;
  amount: bigint | null;
} {
  const empty = { agent: null, protocol: null, amount: null };
  const message = tx.transaction?.message;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;
  if (!accountKeys || !instructions) return empty;

  // A legitimate validate_and_authorize has EXACTLY ONE signer — the agent (the
  // IDL types every other account as a PDA/program). So the trustworthy agent is
  // the sole signer, accountKeys[0], and only when numRequiredSignatures === 1.
  // With ≥2 signers the agent meta could point at any signer (e.g. the fee
  // payer), so we refuse to attribute rather than risk naming the wrong party.
  const numSigners = message?.header?.numRequiredSignatures ?? 0;
  const soleSigner: string | undefined =
    numSigners === 1 ? accountKeys[0] : undefined;

  const sigilId = SIGIL_PROGRAM_ADDRESS as string;

  for (const ix of instructions) {
    if (
      ix.programIdIndex < 0 ||
      ix.programIdIndex >= accountKeys.length ||
      accountKeys[ix.programIdIndex] !== sigilId
    ) {
      continue;
    }

    // Compiled-instruction `data` is a base58 STRING in the JSON tx encoding;
    // the base58 ENCODER turns that string back into the raw instruction bytes.
    let data: ReadonlyUint8Array;
    try {
      data = BASE58_ENCODER.encode(ix.data);
    } catch {
      continue;
    }
    // Only the validate_and_authorize ix carries the agent/protocol/amount we
    // want; skip other Sigil ixs (e.g. finalize_session) by discriminator.
    if (!startsWithDiscriminator(data, VALIDATE_AND_AUTHORIZE_DISCRIMINATOR)) {
      continue;
    }

    // Rehydrate compiled account indices into address-bearing metas. Role is
    // irrelevant to the parser (it reads only `.address`), but must be valid.
    const accounts: { address: Address; role: AccountRole }[] = [];
    for (const accIndex of ix.accounts) {
      const address = accountKeys[accIndex];
      if (address === undefined) return empty; // out-of-range index → undecodable
      accounts.push({
        address: address as Address,
        role: AccountRole.READONLY,
      });
    }

    try {
      const parsed = parseValidateAndAuthorizeInstruction({
        programAddress: sigilId as Address,
        accounts,
        data,
      });
      const decodedAgent = parsed.accounts.agent.address as Address;
      // Anti-spoof: keep the agent only if it IS the sole tx signer.
      return {
        agent: decodedAgent === soleSigner ? decodedAgent : null,
        protocol: parsed.data.targetProtocol as Address,
        amount: parsed.data.amount,
      };
    } catch {
      // Malformed / truncated ix (e.g. < 15 account metas) — surface the block
      // with null actor fields rather than dropping it.
      return empty;
    }
  }

  return empty;
}

/** True iff `data` begins with the 8-byte Anchor discriminator. */
function startsWithDiscriminator(
  data: ReadonlyUint8Array,
  discriminator: ReadonlyUint8Array,
): boolean {
  if (data.length < discriminator.length) return false;
  for (let i = 0; i < discriminator.length; i++) {
    if (data[i] !== discriminator[i]) return false;
  }
  return true;
}

/**
 * Build a blocked VaultActivityItem from a failed transaction. Returns null when
 * the failure is not an AGENT policy-block: either no Sigil error code in the
 * logs (a downstream venue failure), or a Sigil error in a non-agent category
 * (owner-auth / internal / config) — those must not appear as "blocked
 * attempts" in the agent's activity trail.
 */
export function buildBlockedActivityItem(
  tx: JsonTxLike,
  logs: readonly string[],
  txSignature: string,
  blockTime: number,
): VaultActivityItem | null {
  const code = parseSigilBlockErrorCode(logs);
  if (code === null) return null;
  // Surface ONLY agent policy-blocks (what the agent TRIED and got stopped). A
  // Sigil error in an owner/internal/config category (e.g. UnauthorizedOwner)
  // is not an agent "blocked attempt" — skip it so the feed stays the agent's
  // activity trail, not a dump of every Sigil revert.
  if (!isAgentPolicyBlockCode(code)) return null;

  const reason = IDL_ERROR_MAP[code]?.name ?? `SigilError${code}`;
  const { agent, protocol, amount } = reconstructBlockedAttempt(tx);

  return {
    timestamp: blockTime,
    txSignature,
    // Reconstructed (not decoded from an event) — the attempted action was a
    // validate_and_authorize that reverted. Categorized as a trade attempt.
    eventType: "ActionAuthorized" as SigilEventName,
    category: "trade",
    agent,
    amount,
    amountDisplay: amount !== null ? formatUsd(amount, 2) : null,
    tokenMint: null,
    tokenSymbol: null,
    isSpending: amount !== null && amount > 0n,
    protocol,
    protocolName: protocol ? resolveProtocolName(protocol) : null,
    success: false,
    description: reason,
  };
}

// ─── Activity Feed Fetcher ───────────────────────────────────────────────────

/**
 * Fetch and build a complete activity feed for a vault.
 * Uses getSignaturesForAddress + getTransaction (standard RPC).
 * For better performance, use Helius Enhanced Transactions API in the dashboard.
 *
 * Failed transactions that carry a Sigil policy-block error code in their
 * program logs are reconstructed into a single blocked activity item (the
 * revert emits no event, so this is the only way they reach the feed).
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

      // Failed-tx branch: a reverted tx emits no success events. If this tx
      // failed AND produced none, reconstruct a single blocked item from its
      // logs (reusing the tx already fetched above — no extra RPC). Skipped
      // unless the failure is attributable to a Sigil policy block.
      if (decoded.length === 0 && tx.meta.err != null) {
        const blocked = buildBlockedActivityItem(
          tx as JsonTxLike,
          tx.meta.logMessages,
          sigInfo.signature,
          Number(sigInfo.blockTime ?? 0),
        );
        if (blocked) items.push(blocked);
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
