/**
 * Protocol analytics — per-protocol spending breakdown and cross-vault usage.
 *
 * getProtocolBreakdown(): Pure function — donut chart data for spending by protocol.
 * getProtocolUsageAcrossVaults(): Async — aggregated protocol usage across all vaults.
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import type { ResolvedVaultState } from "./state-resolver.js";
import { computeUtilizationPercent } from "./math-utils.js";
import {
  findVaultsByOwner,
  resolveVaultStateForOwner,
} from "./state-resolver.js";
import { resolveProtocolName } from "./protocol-names.js";
import type { Network } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProtocolBreakdownItem {
  protocol: Address;
  protocolName: string;
  spent24h: bigint;
  cap: bigint | null;
  utilization: number;
  /** This protocol's share of total vault spending (0-100%) */
  percentOfTotalSpend: number;
}

export interface PlatformProtocolUsage {
  protocol: Address;
  protocolName: string;
  vaultCount: number;
  totalSpend24h: bigint;
}

// ─── getProtocolBreakdown ────────────────────────────────────────────────────

/**
 * Per-protocol spending breakdown for a single vault.
 * Used for the Spending tab donut chart.
 */
export function getProtocolBreakdown(
  state: ResolvedVaultState,
): ProtocolBreakdownItem[] {
  const { protocolBudgets, globalBudget } = state;
  const totalSpend = globalBudget.spent24h;

  return protocolBudgets.map((pb) => ({
    protocol: pb.protocol,
    protocolName: resolveProtocolName(pb.protocol),
    spent24h: pb.spent24h,
    cap: pb.cap > 0n ? pb.cap : null,
    utilization: computeUtilizationPercent(pb.spent24h, pb.cap),
    percentOfTotalSpend: computeUtilizationPercent(pb.spent24h, totalSpend),
  }));
}

// ─── getProtocolUsageAcrossVaults ────────────────────────────────────────────

/**
 * Protocol usage across all of an owner's vaults.
 * Parallel RPC — N vaults resolved concurrently.
 */
export async function getProtocolUsageAcrossVaults(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  network: Network = "mainnet-beta",
): Promise<PlatformProtocolUsage[]> {
  const discovered = await findVaultsByOwner(rpc, owner);

  // Use allSettled so one failed vault doesn't kill the entire query
  const results = await Promise.allSettled(
    discovered.map((v) =>
      resolveVaultStateForOwner(rpc, v.vaultAddress, undefined, network),
    ),
  );
  const states = results
    .filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof resolveVaultStateForOwner>>
      > => r.status === "fulfilled",
    )
    .map((r) => r.value);

  const protocolMap = new Map<
    string,
    { vaultCount: number; totalSpend: bigint }
  >();

  for (const state of states) {
    for (const pb of state.protocolBudgets) {
      const existing = protocolMap.get(pb.protocol) ?? {
        vaultCount: 0,
        totalSpend: 0n,
      };
      existing.vaultCount++;
      existing.totalSpend += pb.spent24h;
      protocolMap.set(pb.protocol, existing);
    }
  }

  const usage: PlatformProtocolUsage[] = [];
  for (const [protocol, data] of protocolMap) {
    usage.push({
      protocol: protocol as Address,
      protocolName: resolveProtocolName(protocol),
      vaultCount: data.vaultCount,
      totalSpend24h: data.totalSpend,
    });
  }

  usage.sort((a, b) =>
    b.totalSpend24h > a.totalSpend24h
      ? 1
      : b.totalSpend24h < a.totalSpend24h
        ? -1
        : 0,
  );

  return usage;
}
