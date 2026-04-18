/**
 * StateResolver — L0 foundation for resolving vault state with pre-computed budgets.
 *
 * One batched RPC call resolves all vault accounts (AgentVault, PolicyConfig,
 * SpendTracker, AgentSpendOverlay, InstructionConstraints) and computes
 * boundary-corrected rolling 24h budgets that exactly mirror the on-chain math.
 *
 * Pure functions (getRolling24hUsd, getAgentRolling24hUsd, getProtocolSpend)
 * are exported independently for unit testing and reuse.
 */

import {
  fetchEncodedAccounts,
  getAddressDecoder,
  getAddressEncoder,
  getU64Decoder,
  type Address,
  type Base64EncodedBytes,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
} from "./kit-adapter.js";
import {
  decodeAgentSpendOverlay,
  type AgentSpendOverlay,
} from "./generated/accounts/agentSpendOverlay.js";
import {
  decodeAgentVault,
  type AgentVault,
} from "./generated/accounts/agentVault.js";
import {
  decodeInstructionConstraints,
  type InstructionConstraints,
} from "./generated/accounts/instructionConstraints.js";
import {
  decodePolicyConfig,
  type PolicyConfig,
} from "./generated/accounts/policyConfig.js";
import {
  decodeSpendTracker,
  type SpendTracker,
} from "./generated/accounts/spendTracker.js";
import {
  getEscrowDepositDecoder,
  type EscrowDeposit,
} from "./generated/accounts/escrowDeposit.js";
import {
  getSessionAuthorityDecoder,
  getSessionAuthoritySize,
  type SessionAuthority,
} from "./generated/accounts/sessionAuthority.js";
import {
  fetchMaybePendingPolicyUpdate,
  type PendingPolicyUpdate,
} from "./generated/accounts/pendingPolicyUpdate.js";
import {
  fetchMaybePendingConstraintsUpdate,
  type PendingConstraintsUpdate,
} from "./generated/accounts/pendingConstraintsUpdate.js";
import type { AgentContributionEntry } from "./generated/types/agentContributionEntry.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import {
  SIGIL_ERROR__SDK__VAULT_NOT_FOUND,
  SIGIL_ERROR__SDK__POLICY_NOT_FOUND,
} from "./errors/codes.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getAgentOverlayPDA,
  getConstraintsPDA,
  getEscrowPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getPendingConstraintsPDA,
} from "./resolve-accounts.js";
import {
  EPOCH_DURATION,
  NUM_EPOCHS,
  OVERLAY_EPOCH_DURATION,
  OVERLAY_NUM_EPOCHS,
  SIGIL_PROGRAM_ADDRESS,
  PROTOCOL_TREASURY,
  ROLLING_WINDOW_SECONDS,
  U64_MAX,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  type Network,
} from "./types.js";
import { deriveAta } from "./tokens.js";
import { formatUsd } from "./formatting.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Budget state for a single spending dimension. All values in USD (6 decimals). */
export interface EffectiveBudget {
  spent24h: bigint;
  cap: bigint;
  remaining: bigint; // max(cap - spent24h, 0)
}

export interface ProtocolBudget extends EffectiveBudget {
  protocol: Address;
}

/** A single epoch data point for spending time-series charts. */
export interface SpendingEpoch {
  /** Epoch identifier (unix_timestamp / 600). */
  epochId: number;
  /** Unix seconds at start of epoch (epochId * 600). */
  timestamp: number;
  /** Raw 6-decimal stablecoin base units. */
  usdAmount: bigint;
  /** Pre-formatted display string via formatUsd(), e.g. "$123.45". */
  usdAmountFormatted: string;
}

/** Complete resolved vault state from a single batched RPC call. */
export interface ResolvedVaultState {
  vault: AgentVault;
  policy: PolicyConfig;
  tracker: SpendTracker | null;
  overlay: AgentSpendOverlay | null;
  constraints: InstructionConstraints | null;

  globalBudget: EffectiveBudget;
  agentBudget: EffectiveBudget | null;
  /** Per-agent budgets for all agents in the vault (indexed by agent address). */
  allAgentBudgets: Map<Address, EffectiveBudget>;
  protocolBudgets: ProtocolBudget[];
  maxTransactionUsd: bigint;

  /** Vault stablecoin ATA balances (USDC + USDT). 0n if ATA doesn't exist. */
  stablecoinBalances: { usdc: bigint; usdt: bigint };

  resolvedAtTimestamp: bigint;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

function bytesMatchAddress(bytes: ReadonlyUint8Array, addr: Address): boolean {
  const encoded = addressEncoder.encode(addr);
  if (bytes.length !== encoded.length) return false;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] !== encoded[i]) return false;
  }
  return true;
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

/**
 * Convert a 32-byte ReadonlyUint8Array to a Kit Address.
 * Uses the same Codama address codec as resolve-accounts.ts.
 */
export function bytesToAddress(bytes: ReadonlyUint8Array): Address {
  return addressDecoder.decode(bytes);
}

/**
 * Find an agent's slot index + lifetime metrics from an AgentSpendOverlay.
 *
 * PR 3.B F038: extracted from 5 duplicate sites across agent-analytics,
 * portfolio-analytics, and spending-analytics.
 *
 * @returns `{ slotIdx, lifetimeSpend, lifetimeTxCount }` or `null` if the
 * agent is not found in the overlay entries.
 */
export function findAgentOverlaySlot(
  overlay: AgentSpendOverlay | null | undefined,
  agentAddress: Address,
): { slotIdx: number; lifetimeSpend: bigint; lifetimeTxCount: bigint } | null {
  if (!overlay) return null;
  const slotIdx = overlay.entries.findIndex((e) => {
    try {
      return bytesToAddress(e.agent) === agentAddress;
    } catch {
      return false;
    }
  });
  if (slotIdx < 0) return null;
  const lifetimeSpend =
    slotIdx < overlay.lifetimeSpend.length
      ? overlay.lifetimeSpend[slotIdx]
      : 0n;
  const lifetimeTxCount =
    slotIdx < (overlay.lifetimeTxCount?.length ?? 0)
      ? overlay.lifetimeTxCount[slotIdx]
      : 0n;
  return { slotIdx, lifetimeSpend, lifetimeTxCount };
}

/**
 * Mirror of SpendTracker::get_rolling_24h_usd() from tracker.rs:103-151.
 *
 * Iterates all 144 buckets, summing those within the 24h window.
 * Boundary bucket is proportionally scaled. BigInt division truncates
 * like Rust integer division.
 */
export function getRolling24hUsd(
  tracker: SpendTracker,
  nowUnix: bigint,
): bigint {
  if (nowUnix <= 0n) return 0n;

  const epochDuration = BigInt(EPOCH_DURATION);
  const numEpochs = BigInt(NUM_EPOCHS);
  const currentEpoch = nowUnix / epochDuration;

  // Early exit: if no writes in 144+ epochs, all data is expired
  if (currentEpoch - tracker.lastWriteEpoch > numEpochs) return 0n;

  // G-2: Saturating subtraction — avoid negative windowStart when nowUnix < 86400
  const windowStart =
    nowUnix > BigInt(ROLLING_WINDOW_SECONDS)
      ? nowUnix - BigInt(ROLLING_WINDOW_SECONDS)
      : 0n;
  let total = 0n;

  for (const bucket of tracker.buckets) {
    if (bucket.usdAmount === 0n) continue;

    const bucketStart = bucket.epochId * epochDuration;
    const bucketEnd = bucketStart + epochDuration;

    // Skip if entirely outside window
    if (bucketEnd <= windowStart || bucket.epochId > currentEpoch) continue;

    if (bucketStart >= windowStart) {
      // Fully inside window
      total += bucket.usdAmount;
    } else {
      // Boundary bucket — proportional scaling
      const overlap = bucketEnd - windowStart;
      total += (bucket.usdAmount * overlap) / epochDuration;
    }
  }

  // G-1: Clamp to u64::MAX to match on-chain Rust math
  return total > U64_MAX ? U64_MAX : total;
}

/**
 * Mirror of AgentSpendOverlay::get_agent_rolling_24h_usd() from
 * agent_spend_overlay.rs:136-199.
 *
 * Iterates backward from lastWriteEpoch, summing contributions within
 * the 24h window. Uses proportional scaling for boundary buckets.
 */
export function getAgentRolling24hUsd(
  entry: AgentContributionEntry,
  nowUnix: bigint,
): bigint {
  if (nowUnix <= 0n) return 0n;

  const epochDuration = BigInt(OVERLAY_EPOCH_DURATION);
  const numEpochs = BigInt(OVERLAY_NUM_EPOCHS);
  const currentEpoch = nowUnix / epochDuration;

  // Early exit: if last write was more than 24 epochs ago, all expired
  if (currentEpoch - entry.lastWriteEpoch > numEpochs) return 0n;

  // G-2: Saturating subtraction — avoid negative windowStart when nowUnix < 86400
  const windowStart =
    nowUnix > BigInt(ROLLING_WINDOW_SECONDS)
      ? nowUnix - BigInt(ROLLING_WINDOW_SECONDS)
      : 0n;
  let total = 0n;

  // Iterate backward from lastWriteEpoch (most recent data)
  for (let k = 0; k < OVERLAY_NUM_EPOCHS; k++) {
    const epochForK = entry.lastWriteEpoch - BigInt(k);
    if (epochForK < 0n) break;

    const bucketStart = epochForK * epochDuration;
    const bucketEnd = bucketStart + epochDuration;

    // If this bucket ends before the window start, we're done (going backward)
    if (bucketEnd <= windowStart) break;

    // If this bucket is in the future, skip it
    if (epochForK > currentEpoch) continue;

    const bucketIdx = Number(epochForK % numEpochs);
    const contribution = entry.contributions[bucketIdx];
    if (contribution === 0n) continue;

    if (bucketStart >= windowStart) {
      // Fully within window
      total += contribution;
    } else {
      // Boundary bucket — proportional scaling
      const overlap = bucketEnd - windowStart;
      total += (contribution * overlap) / epochDuration;
    }
  }

  // G-1: Clamp to u64::MAX to match on-chain Rust math
  return total > U64_MAX ? U64_MAX : total;
}

/**
 * Mirror of SpendTracker::get_protocol_spend() from tracker.rs:155-172.
 *
 * Simple 24h window check (NOT rolling boundary-corrected).
 * Returns the windowSpend if the counter exists and hasn't expired.
 */
export function getProtocolSpend(
  tracker: SpendTracker,
  protocolAddress: Address,
  nowUnix: bigint,
): bigint {
  if (nowUnix <= 0n) return 0n;

  const epochDuration = BigInt(EPOCH_DURATION);
  const numEpochs = BigInt(NUM_EPOCHS);
  const currentEpoch = nowUnix / epochDuration;

  for (const counter of tracker.protocolCounters) {
    if (bytesMatchAddress(counter.protocol, protocolAddress)) {
      // Check if window is still valid (< 144 epochs = 24h)
      if (currentEpoch - counter.windowStart < numEpochs) {
        return counter.windowSpend;
      }
      return 0n; // Window expired
    }
  }

  return 0n; // No counter found
}

/**
 * Convert SpendTracker epoch buckets into a chronologically sorted time-series
 * for dashboard charts (Recharts area charts, tooltips).
 *
 * Mirrors getRolling24hUsd() iteration but outputs individual data points
 * instead of a sum. Zero-amount epochs are skipped (sparse-friendly).
 * No proportional boundary scaling — raw epoch amounts for chart display.
 *
 * @param tracker - SpendTracker account data (null for vaults with no tracker PDA)
 * @param nowUnix - Current unix timestamp in seconds
 * @returns Chronologically sorted SpendingEpoch[] (ascending by timestamp)
 */
export function getSpendingHistory(
  tracker: SpendTracker | null,
  nowUnix: bigint,
): SpendingEpoch[] {
  if (!tracker || nowUnix <= 0n) return [];

  const epochDuration = BigInt(EPOCH_DURATION);
  const numEpochs = BigInt(NUM_EPOCHS);
  const currentEpoch = nowUnix / epochDuration;

  // Early exit: if no writes in 144+ epochs, all data is expired
  if (currentEpoch - tracker.lastWriteEpoch > numEpochs) return [];

  const windowStartEpoch = currentEpoch - numEpochs;
  const result: SpendingEpoch[] = [];

  for (const bucket of tracker.buckets) {
    if (bucket.usdAmount === 0n) continue;
    if (bucket.epochId < windowStartEpoch) continue;
    if (bucket.epochId > currentEpoch) continue;

    result.push({
      epochId: Number(bucket.epochId),
      timestamp: Number(bucket.epochId * epochDuration),
      usdAmount: bucket.usdAmount,
      usdAmountFormatted: formatUsd(bucket.usdAmount),
    });
  }

  // Sort chronologically (circular buffer order ≠ time order)
  result.sort((a, b) => a.timestamp - b.timestamp);

  return result;
}

// ─── resolveVaultState ───────────────────────────────────────────────────────

/**
 * Resolve complete vault state from a single batched RPC call.
 *
 * Derives 4 PDAs + 2 stablecoin ATAs, fetches all 7 accounts in one
 * getMultipleAccounts, decodes, and pre-computes global/agent/protocol
 * budgets with boundary-corrected rolling 24h math.
 *
 * @param network - Optional network for stablecoin mint resolution (defaults to "mainnet-beta")
 */
export async function resolveVaultState(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  agent: Address,
  nowUnix?: bigint,
  network?: Network,
): Promise<ResolvedVaultState> {
  const net = network ?? "mainnet-beta";
  const usdcMint = net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const usdtMint = net === "devnet" ? USDT_MINT_DEVNET : USDT_MINT_MAINNET;

  // 1. Derive PDAs + stablecoin ATAs in parallel
  const [
    [policyPda],
    [trackerPda],
    [overlayPda],
    [constraintsPda],
    vaultUsdcAta,
    vaultUsdtAta,
  ] = await Promise.all([
    getPolicyPDA(vault),
    getTrackerPDA(vault),
    getAgentOverlayPDA(vault, 0),
    getConstraintsPDA(vault),
    deriveAta(vault, usdcMint),
    deriveAta(vault, usdtMint),
  ]);

  // 2. Single batch fetch (one RPC round-trip — 7 accounts)
  const encoded = await fetchEncodedAccounts(rpc, [
    vault,
    policyPda,
    trackerPda,
    overlayPda,
    constraintsPda,
    vaultUsdcAta,
    vaultUsdtAta,
  ]);

  // 3. Decode — vault and policy are required, others are optional
  const decodedVault = decodeAgentVault(encoded[0]);
  if (!decodedVault.exists) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__VAULT_NOT_FOUND,
      `Vault account ${vault} does not exist`,
      { context: { vault } },
    );
  }

  const decodedPolicy = decodePolicyConfig(encoded[1]);
  if (!decodedPolicy.exists) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__POLICY_NOT_FOUND,
      `PolicyConfig for vault ${vault} does not exist`,
      { context: { vault } },
    );
  }

  const decodedTracker = decodeSpendTracker(encoded[2]);
  const tracker: SpendTracker | null = decodedTracker.exists
    ? decodedTracker.data
    : null;

  const decodedOverlay = decodeAgentSpendOverlay(encoded[3]);
  const overlay: AgentSpendOverlay | null = decodedOverlay.exists
    ? decodedOverlay.data
    : null;

  const decodedConstraints = decodeInstructionConstraints(encoded[4]);
  const constraints: InstructionConstraints | null = decodedConstraints.exists
    ? decodedConstraints.data
    : null;

  // 4. Timestamp
  const timestamp = nowUnix ?? BigInt(Math.floor(Date.now() / 1000));

  // 5. Global budget
  const globalSpent = tracker ? getRolling24hUsd(tracker, timestamp) : 0n;
  const globalCap = decodedPolicy.data.dailySpendingCapUsd;
  const globalRemaining =
    globalCap > globalSpent ? globalCap - globalSpent : 0n;
  const globalBudget: EffectiveBudget = {
    spent24h: globalSpent,
    cap: globalCap,
    remaining: globalRemaining,
  };

  // 6. Agent budgets — single pass builds both agentBudget and allAgentBudgets
  let agentBudget: EffectiveBudget | null = null;
  const allAgentBudgets = new Map<Address, EffectiveBudget>();
  for (const entry of decodedVault.data.agents) {
    if (entry.spendingLimitUsd <= 0n) continue;
    const entryAddr = entry.pubkey;
    const cap = entry.spendingLimitUsd;

    let budget: EffectiveBudget;
    if (overlay) {
      const overlayEntry = overlay.entries.find((e) =>
        bytesMatchAddress(e.agent, entryAddr),
      );
      if (overlayEntry) {
        const spent = getAgentRolling24hUsd(overlayEntry, timestamp);
        budget = {
          spent24h: spent,
          cap,
          remaining: cap > spent ? cap - spent : 0n,
        };
      } else {
        budget = { spent24h: 0n, cap, remaining: cap };
      }
    } else {
      budget = { spent24h: 0n, cap, remaining: cap };
    }

    allAgentBudgets.set(entryAddr, budget);
    // Kit Address is a branded string — === is correct (always normalized base58)
    if (entryAddr === agent) {
      agentBudget = budget;
    }
  }

  // 7. Protocol budgets
  const protocolBudgets: ProtocolBudget[] = [];
  if (decodedPolicy.data.hasProtocolCaps && tracker) {
    const protocols = decodedPolicy.data.protocols;
    const caps = decodedPolicy.data.protocolCaps;

    for (let i = 0; i < protocols.length; i++) {
      const protocolCap = caps[i];
      if (protocolCap === undefined || protocolCap === 0n) continue;

      const protocol = protocols[i];
      const spent = getProtocolSpend(tracker, protocol, timestamp);
      protocolBudgets.push({
        protocol,
        spent24h: spent,
        cap: protocolCap,
        remaining: protocolCap > spent ? protocolCap - spent : 0n,
      });
    }
  }

  // 8. Parse stablecoin ATA balances.
  //
  // The previous implementation wrapped each parse in a bare `try/catch`,
  // which swallowed any error produced by the block — both the normal
  // "account missing" case (handled cleanly by the `.exists` / length
  // guards below) and anything the SPL-data handling might throw in the
  // future. The catch was effectively dead code: no currently-reachable
  // branch inside the `.exists` guard throws. But it was a latent trap —
  // any future change that DID start throwing (a stricter codec, a new
  // encoding variant, a malformed-RPC fallback) would have been silently
  // absorbed and downstream drain detection (seal.ts:611-643 reads
  // `stablecoinBalances` as the drain baseline) would quietly see a zero
  // balance and disable the LARGE_OUTFLOW / FULL_DRAIN gates.
  //
  // Removing the catch preserves the current behaviour (the guards return
  // 0n on missing accounts) while leaving the door open for a future
  // "state unknown, refuse to transact" path instead of silently
  // substituting zero.
  let usdcBalance = 0n;
  let usdtBalance = 0n;

  const usdcEncoded = encoded[5];
  if (usdcEncoded?.exists) {
    const usdcData = (usdcEncoded as { data: Uint8Array }).data;
    if (usdcData && usdcData.length >= 72) {
      // SPL Token amount at offset 64 (u64 LE). `data` is cast as
      // Uint8Array by the batch fetcher; if a future RPC layer ever hands
      // back a different shape (e.g. base64 string), `BigInt(undefined)` /
      // `BigInt(char)` will throw inside the loop — that propagation is
      // what C2 wants, don't add an `instanceof` guard that silently skips.
      for (let i = 0; i < 8; i++) {
        usdcBalance |= BigInt(usdcData[64 + i]) << BigInt(i * 8);
      }
    }
  }

  const usdtEncoded = encoded[6];
  if (usdtEncoded?.exists) {
    const usdtData = (usdtEncoded as { data: Uint8Array }).data;
    if (usdtData && usdtData.length >= 72) {
      for (let i = 0; i < 8; i++) {
        usdtBalance |= BigInt(usdtData[64 + i]) << BigInt(i * 8);
      }
    }
  }

  return {
    vault: decodedVault.data,
    policy: decodedPolicy.data,
    tracker,
    overlay,
    constraints,
    globalBudget,
    agentBudget,
    allAgentBudgets,
    protocolBudgets,
    maxTransactionUsd: decodedPolicy.data.maxTransactionSizeUsd,
    stablecoinBalances: { usdc: usdcBalance, usdt: usdtBalance },
    resolvedAtTimestamp: timestamp,
  };
}

// ─── resolveVaultStateForOwner ────────────────────────────────────────────────

/** Owner-facing vault state — all agents' budgets, no single-agent focus. */
export type ResolvedVaultStateForOwner = Omit<
  ResolvedVaultState,
  "agentBudget"
>;

/**
 * Resolve complete vault state for an owner — returns all agents' budgets
 * without requiring a specific agent address.
 *
 * Delegates to resolveVaultState internally. Agents with spendingLimitUsd = 0
 * are excluded from allAgentBudgets (matching on-chain behavior where
 * zero-limit agents have no budget to track).
 *
 * @param rpc - Kit RPC client
 * @param vault - Vault PDA address
 * @param nowUnix - Optional timestamp override (defaults to Date.now())
 * @param network - Optional network for stablecoin mint resolution
 */
export async function resolveVaultStateForOwner(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  nowUnix?: bigint,
  network?: Network,
): Promise<ResolvedVaultStateForOwner> {
  // System program address — guaranteed not a vault agent (can't sign),
  // so agentBudget is always null in the delegated result.
  const state = await resolveVaultState(
    rpc,
    vault,
    "11111111111111111111111111111111" as Address,
    nowUnix,
    network,
  );
  const { agentBudget: _, ...rest } = state;
  return rest;
}

// ─── Budget-Only Resolver ────────────────────────────────────────────────────

export interface ResolvedBudget {
  globalBudget: EffectiveBudget;
  agentBudget: EffectiveBudget | null;
}

/**
 * Resolve only global + agent budgets with minimal RPC overhead.
 *
 * Fetches 4 accounts (vault, policy, tracker, overlay) instead of 7,
 * skipping constraints and 2 stablecoin ATAs. Skips protocol budget
 * computation and constraints decoding (8.3KB zero-copy).
 * ~40% cheaper than resolveVaultState() for budget-only queries.
 */
export async function resolveVaultBudget(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  agent: Address,
  nowUnix?: bigint,
): Promise<ResolvedBudget> {
  const [[policyPda], [trackerPda], [overlayPda]] = await Promise.all([
    getPolicyPDA(vault),
    getTrackerPDA(vault),
    getAgentOverlayPDA(vault, 0),
  ]);

  const encoded = await fetchEncodedAccounts(rpc, [
    vault,
    policyPda,
    trackerPda,
    overlayPda,
  ]);

  const decodedVault = decodeAgentVault(encoded[0]);
  if (!decodedVault.exists) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__VAULT_NOT_FOUND,
      `Vault account ${vault} does not exist`,
      { context: { vault } },
    );
  }

  const decodedPolicy = decodePolicyConfig(encoded[1]);
  if (!decodedPolicy.exists) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__POLICY_NOT_FOUND,
      `PolicyConfig for vault ${vault} does not exist`,
      { context: { vault } },
    );
  }

  const decodedTracker = decodeSpendTracker(encoded[2]);
  const tracker: SpendTracker | null = decodedTracker.exists
    ? decodedTracker.data
    : null;

  const decodedOverlay = decodeAgentSpendOverlay(encoded[3]);
  const overlay: AgentSpendOverlay | null = decodedOverlay.exists
    ? decodedOverlay.data
    : null;

  const timestamp = nowUnix ?? BigInt(Math.floor(Date.now() / 1000));

  // Global budget
  const globalSpent = tracker ? getRolling24hUsd(tracker, timestamp) : 0n;
  const globalCap = decodedPolicy.data.dailySpendingCapUsd;
  const globalRemaining =
    globalCap > globalSpent ? globalCap - globalSpent : 0n;
  const globalBudget: EffectiveBudget = {
    spent24h: globalSpent,
    cap: globalCap,
    remaining: globalRemaining,
  };

  // Agent budget
  let agentBudget: EffectiveBudget | null = null;
  const agentEntry = decodedVault.data.agents.find((a) => a.pubkey === agent);
  if (agentEntry && agentEntry.spendingLimitUsd > 0n) {
    const cap = agentEntry.spendingLimitUsd;
    if (overlay) {
      const overlayEntry = overlay.entries.find((e) =>
        bytesMatchAddress(e.agent, agent),
      );
      if (overlayEntry) {
        const spent = getAgentRolling24hUsd(overlayEntry, timestamp);
        agentBudget = {
          spent24h: spent,
          cap,
          remaining: cap > spent ? cap - spent : 0n,
        };
      } else {
        agentBudget = { spent24h: 0n, cap, remaining: cap };
      }
    } else {
      agentBudget = { spent24h: 0n, cap, remaining: cap };
    }
  }

  return { globalBudget, agentBudget };
}

// ─── Vault Discovery ────────────────────────────────────────────────────────

/** A discovered vault with its address and ID. */
export interface VaultLocator {
  vaultAddress: Address;
  vaultId: bigint;
}

/**
 * @deprecated Renamed to {@link VaultLocator} in PR 2.B. Will be removed at v1.0.
 */
export type DiscoveredVault = VaultLocator;

/** AgentVault account size (bytes) — used for dataSize filter. */
const AGENT_VAULT_SIZE = 634;

/** Byte offset of the `vault_id` field in AgentVault (after 8 disc + 32 owner). */
const VAULT_ID_OFFSET = 40;

const u64Decoder = getU64Decoder();

/**
 * Find all vaults owned by a wallet address.
 *
 * Strategy A: getProgramAccounts with memcmp filter (fast, requires RPC support).
 * Strategy B: Sequential PDA probing fallback (works everywhere, slower).
 *
 * @param rpc - Kit RPC client
 * @param owner - Owner wallet address
 * @param maxProbe - Maximum vault IDs to probe in fallback (default: 20)
 * @returns Array of discovered vaults
 */
/**
 * Errors that indicate the RPC doesn't support getProgramAccounts (fall back to probing).
 *
 * JSON-RPC error codes (per Solana spec + major RPC providers):
 * - -32601: Method not found (standard JSON-RPC)
 * - -32010: Program excluded from account secondary indexes (Solana-specific)
 * - HTTP 410: Method disabled at proxy level (public RPCs)
 *
 * Rate limits (-32005, HTTP 429) and network errors are NOT matched —
 * they should propagate so callers can retry or surface the issue.
 */
function isGpaUnsupportedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Check for JSON-RPC error codes (SolanaJSONRPCError or similar)
  const code = (err as { code?: number }).code;
  if (code === -32601 || code === -32010) return true;

  // Fallback: message-based matching for RPCs that don't set error codes
  const msg = err.message.toLowerCase();
  return (
    msg.includes("method not found") ||
    msg.includes("not available") ||
    msg.includes("not supported") ||
    msg.includes("disabled") ||
    msg.includes("410")
  );
}

/** Platform-agnostic base64 encode for Uint8Array (no Buffer dependency). */
function uint8ToBase64(bytes: Uint8Array | ReadonlyUint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Platform-agnostic base64 decode to Uint8Array (no Buffer dependency). */
function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function findVaultsByOwner(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  maxProbe: number = 20,
): Promise<VaultLocator[]> {
  // Cap maxProbe to prevent excessive PDA derivation (V-3: DoS mitigation)
  const cappedProbe = Math.min(Math.max(0, maxProbe), 100);
  const ownerBase64 = uint8ToBase64(addressEncoder.encode(owner));

  // Strategy A: getProgramAccounts with memcmp filter
  try {
    const accounts = await rpc
      .getProgramAccounts(SIGIL_PROGRAM_ADDRESS, {
        dataSlice: { offset: VAULT_ID_OFFSET, length: 8 },
        filters: [
          { dataSize: BigInt(AGENT_VAULT_SIZE) },
          {
            memcmp: {
              offset: BigInt(8),
              bytes: ownerBase64 as Base64EncodedBytes,
              encoding: "base64",
            },
          },
        ],
        encoding: "base64",
      })
      .send();

    const parsed = (
      accounts as { pubkey: Address; account: { data: [string, string] } }[]
    ).map((entry) => {
      const raw = base64ToUint8(entry.account.data[0]);
      const vaultId = u64Decoder.decode(raw);
      return { vaultAddress: entry.pubkey, vaultId };
    });

    // V-1 fix: Re-derive PDAs to verify RPC-returned pubkeys are legitimate vault addresses.
    // A malicious RPC could return fabricated pubkeys that don't correspond to real vault PDAs.
    const verified: VaultLocator[] = [];
    for (const entry of parsed) {
      const [expectedPda] = await getVaultPDA(owner, entry.vaultId);
      if (expectedPda === entry.vaultAddress) {
        verified.push(entry);
      }
    }

    // Sort by vaultId for consistent ordering regardless of RPC response order
    return verified.sort((a, b) =>
      a.vaultId < b.vaultId ? -1 : a.vaultId > b.vaultId ? 1 : 0,
    );
  } catch (err) {
    // Rate limits must propagate — never fall back to slow probing under rate limit
    const code = (err as { code?: number }).code;
    if (
      code === -32005 ||
      (err instanceof Error && err.message.includes("429"))
    ) {
      throw err;
    }
    // Only fall back to probing if the RPC doesn't support getProgramAccounts.
    // Network errors, auth errors should propagate.
    if (!isGpaUnsupportedError(err)) {
      throw err;
    }
  }

  // Strategy B: PDA probing fallback — derive all candidate PDAs in parallel
  const pdas = await Promise.all(
    Array.from({ length: cappedProbe }, async (_, i) => {
      const [pda] = await getVaultPDA(owner, BigInt(i));
      return { address: pda, vaultId: BigInt(i) };
    }),
  );

  // Batch fetch via getMultipleAccounts (maxProbe <= 20, well under 100-account limit)
  const addresses = pdas.map((p) => p.address);
  const result = await rpc
    .getMultipleAccounts(addresses, { encoding: "base64" })
    .send();

  const discovered: VaultLocator[] = [];
  for (let i = 0; i < result.value.length; i++) {
    if (result.value[i] !== null) {
      discovered.push({
        vaultAddress: pdas[i].address,
        vaultId: pdas[i].vaultId,
      });
    }
  }

  // Already sorted by vaultId (probed sequentially 0..maxProbe)
  return discovered;
}

// ─── Escrow Discovery ──────────────────────────────────────────────────────

/** Escrow account size (bytes) — used for dataSize filter. */
const ESCROW_DEPOSIT_SIZE = 170;

/**
 * Find all escrow deposits where this vault is the source.
 * Uses getProgramAccounts with memcmp on source_vault field (offset 8).
 */
export async function findEscrowsByVault(
  rpc: Rpc<SolanaRpcApi>,
  sourceVault: Address,
): Promise<(EscrowDeposit & { address: Address })[]> {
  const vaultBase64 = uint8ToBase64(addressEncoder.encode(sourceVault));

  try {
    const accounts = await rpc
      .getProgramAccounts(SIGIL_PROGRAM_ADDRESS, {
        filters: [
          { dataSize: BigInt(ESCROW_DEPOSIT_SIZE) },
          {
            memcmp: {
              offset: BigInt(8),
              bytes: vaultBase64 as Base64EncodedBytes,
              encoding: "base64",
            },
          },
        ],
        encoding: "base64",
      })
      .send();

    // Decode directly from GPA response (avoids double RPC)
    const decoder = getEscrowDepositDecoder();
    return (
      accounts as { pubkey: Address; account: { data: [string, string] } }[]
    ).map((entry) => {
      const raw = base64ToUint8(entry.account.data[0]);
      const data = decoder.decode(raw);
      return { ...data, address: entry.pubkey };
    });
  } catch (err) {
    if (!isGpaUnsupportedError(err)) throw err;
    return []; // GPA not supported — return empty
  }
}

// ─── Session Discovery ─────────────────────────────────────────────────────

/** SessionAuthority account size (bytes) — sourced from generated code to avoid drift. */
const SESSION_AUTHORITY_SIZE = getSessionAuthoritySize();

/**
 * Find all active sessions for a vault.
 * Uses getProgramAccounts with memcmp on vault field (offset 8).
 */
export async function findSessionsByVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
): Promise<(SessionAuthority & { address: Address })[]> {
  const vaultBase64 = uint8ToBase64(addressEncoder.encode(vault));

  try {
    const accounts = await rpc
      .getProgramAccounts(SIGIL_PROGRAM_ADDRESS, {
        filters: [
          { dataSize: BigInt(SESSION_AUTHORITY_SIZE) },
          {
            memcmp: {
              offset: BigInt(8),
              bytes: vaultBase64 as Base64EncodedBytes,
              encoding: "base64",
            },
          },
        ],
        encoding: "base64",
      })
      .send();

    // Decode directly from GPA response (avoids double RPC)
    const decoder = getSessionAuthorityDecoder();
    return (
      accounts as { pubkey: Address; account: { data: [string, string] } }[]
    ).map((entry) => {
      const raw = base64ToUint8(entry.account.data[0]);
      const data = decoder.decode(raw);
      return { ...data, address: entry.pubkey };
    });
  } catch (err) {
    if (!isGpaUnsupportedError(err)) throw err;
    return []; // GPA not supported — return empty
  }
}

// ─── Pending Update Convenience Wrappers ───────────────────────────────────

/**
 * Fetch the pending policy update for a vault, if any.
 * Returns null if no pending update exists.
 */
export async function getPendingPolicyForVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
): Promise<PendingPolicyUpdate | null> {
  const [pda] = await getPendingPolicyPDA(vault);
  const result = await fetchMaybePendingPolicyUpdate(rpc, pda);
  return result.exists ? result.data : null;
}

/**
 * Fetch the pending constraints update for a vault, if any.
 * Returns null if no pending update exists.
 */
export async function getPendingConstraintsForVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
): Promise<PendingConstraintsUpdate | null> {
  const [pda] = await getPendingConstraintsPDA(vault);
  const result = await fetchMaybePendingConstraintsUpdate(rpc, pda);
  return result.exists ? result.data : null;
}
