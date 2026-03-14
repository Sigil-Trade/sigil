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
  type Address,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
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
import type { AgentContributionEntry } from "./generated/types/agentContributionEntry.js";
import {
  getPolicyPDA,
  getTrackerPDA,
  getAgentOverlayPDA,
  getConstraintsPDA,
} from "./resolve-accounts.js";
import {
  EPOCH_DURATION,
  NUM_EPOCHS,
  OVERLAY_EPOCH_DURATION,
  OVERLAY_NUM_EPOCHS,
  ROLLING_WINDOW_SECONDS,
} from "./types.js";

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

/** Complete resolved vault state from a single batched RPC call. */
export interface ResolvedVaultState {
  vault: AgentVault;
  policy: PolicyConfig;
  tracker: SpendTracker | null;
  overlay: AgentSpendOverlay | null;
  constraints: InstructionConstraints | null;

  globalBudget: EffectiveBudget;
  agentBudget: EffectiveBudget | null;
  protocolBudgets: ProtocolBudget[];
  maxTransactionUsd: bigint;

  resolvedAtTimestamp: bigint;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

function bytesMatchAddress(
  bytes: ReadonlyUint8Array,
  addr: Address,
): boolean {
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

  const windowStart = nowUnix - BigInt(ROLLING_WINDOW_SECONDS);
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

  return total;
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

  const windowStart = nowUnix - BigInt(ROLLING_WINDOW_SECONDS);
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

  return total;
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

// ─── resolveVaultState ───────────────────────────────────────────────────────

/**
 * Resolve complete vault state from a single batched RPC call.
 *
 * Derives 4 PDAs, fetches all 5 accounts in one getMultipleAccounts,
 * decodes, and pre-computes global/agent/protocol budgets with
 * boundary-corrected rolling 24h math.
 */
export async function resolveVaultState(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  agent: Address,
  nowUnix?: bigint,
): Promise<ResolvedVaultState> {
  // 1. Derive PDAs in parallel
  const [[policyPda], [trackerPda], [overlayPda], [constraintsPda]] =
    await Promise.all([
      getPolicyPDA(vault),
      getTrackerPDA(vault),
      getAgentOverlayPDA(vault, 0),
      getConstraintsPDA(vault),
    ]);

  // 2. Single batch fetch (one RPC round-trip)
  const encoded = await fetchEncodedAccounts(rpc, [
    vault,
    policyPda,
    trackerPda,
    overlayPda,
    constraintsPda,
  ]);

  // 3. Decode — vault and policy are required, others are optional
  const decodedVault = decodeAgentVault(encoded[0]);
  if (!decodedVault.exists) {
    throw new Error(`Vault account ${vault} does not exist`);
  }

  const decodedPolicy = decodePolicyConfig(encoded[1]);
  if (!decodedPolicy.exists) {
    throw new Error(`PolicyConfig for vault ${vault} does not exist`);
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
  const globalRemaining = globalCap > globalSpent ? globalCap - globalSpent : 0n;
  const globalBudget: EffectiveBudget = {
    spent24h: globalSpent,
    cap: globalCap,
    remaining: globalRemaining,
  };

  // 6. Agent budget
  let agentBudget: EffectiveBudget | null = null;
  const agentEntry = decodedVault.data.agents.find(
    (a) => a.pubkey === agent,
  );

  if (agentEntry && agentEntry.spendingLimitUsd > 0n) {
    const agentCap = agentEntry.spendingLimitUsd;

    if (overlay) {
      // Find the agent's entry in the overlay
      const overlayEntry = overlay.entries.find((e) =>
        bytesMatchAddress(e.agent, agent),
      );

      if (overlayEntry) {
        const agentSpent = getAgentRolling24hUsd(overlayEntry, timestamp);
        agentBudget = {
          spent24h: agentSpent,
          cap: agentCap,
          remaining: agentCap > agentSpent ? agentCap - agentSpent : 0n,
        };
      } else {
        // Agent has a limit but no overlay entry yet (no spend recorded)
        agentBudget = { spent24h: 0n, cap: agentCap, remaining: agentCap };
      }
    } else {
      // Overlay not initialized — agent hasn't spent anything
      agentBudget = { spent24h: 0n, cap: agentCap, remaining: agentCap };
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

  return {
    vault: decodedVault.data,
    policy: decodedPolicy.data,
    tracker,
    overlay,
    constraints,
    globalBudget,
    agentBudget,
    protocolBudgets,
    maxTransactionUsd: decodedPolicy.data.maxTransactionSizeUsd,
    resolvedAtTimestamp: timestamp,
  };
}
