/**
 * Balance tracking and P&L computation for Sigil vaults.
 *
 * Two complementary approaches:
 * - `getVaultPnL()`: Lifetime P&L from on-chain cumulative counters (single RPC call)
 * - `BalanceSnapshotStore` + `getBalancePnL()`: Session-scoped P&L from balance snapshots (for charts)
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import { isStablecoinMint, type Network } from "./types.js";
import { computePnlPercent } from "./math-utils.js";
import { resolveVaultStateForOwner } from "./state-resolver.js";
import { resolveToken } from "./tokens.js";
import { getSigilModuleLogger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenBalance {
  /** SPL token mint address */
  mint: Address;
  /** Raw balance in base units */
  balance: bigint;
  /** Human-readable symbol (e.g., "USDC") or truncated mint for unknown tokens */
  symbol: string;
  /** Token decimals (6 for USDC/USDT, 9 for SOL, etc.) */
  decimals: number;
}

export interface VaultPnL {
  /** Cumulative stablecoin deposits from AgentVault.total_deposited_usd */
  totalDeposited: bigint;
  /** Cumulative stablecoin withdrawals from AgentVault.total_withdrawn_usd */
  totalWithdrawn: bigint;
  /** Current vault stablecoin balance (USDC + USDT) */
  currentBalance: bigint;
  /** Net investment = totalDeposited - totalWithdrawn */
  netInvestment: bigint;
  /** P&L = currentBalance - netInvestment */
  pnl: bigint;
  /**
   * P&L as percentage of net investment (e.g., 20.5 for +20.5%).
   * Returns 0 when netInvestment <= 0 (vault fully in profit with no net deposits).
   * Use the `pnl` bigint field for absolute value in that case.
   */
  pnlPercent: number;
}

export interface BalanceSnapshot {
  timestamp: bigint;
  balances: TokenBalance[];
}

export interface BalancePnL {
  startBalance: bigint;
  currentBalance: bigint;
  delta: bigint;
  percentChange: number;
}

// ─── On-chain P&L (lifetime) ────────────────────────────────────────────────

/**
 * Pure P&L computation from an already-resolved vault state. No RPC.
 *
 * Use this variant when you already have `ResolvedVaultStateForOwner` in hand
 * (e.g. from a shared `getOverview` context) to avoid a duplicate
 * `resolveVaultStateForOwner` call.
 */
export function getVaultPnLFromState(state: {
  vault: { totalDepositedUsd: bigint; totalWithdrawnUsd: bigint };
  stablecoinBalances: { usdc: bigint; usdt: bigint };
}): VaultPnL {
  const totalDeposited = state.vault.totalDepositedUsd;
  const totalWithdrawn = state.vault.totalWithdrawnUsd;
  const currentBalance =
    state.stablecoinBalances.usdc + state.stablecoinBalances.usdt;
  const netInvestment = totalDeposited - totalWithdrawn;
  const pnl = currentBalance - netInvestment;
  const pnlPercent = computePnlPercent(pnl, netInvestment);

  return {
    totalDeposited,
    totalWithdrawn,
    currentBalance,
    netInvestment,
    pnl,
    pnlPercent,
  };
}

/**
 * Compute lifetime P&L for a vault from on-chain cumulative counters.
 * Single RPC call via resolveVaultStateForOwner. O(1) — no event parsing needed.
 *
 * P&L = current_stablecoin_balance - (total_deposited_usd - total_withdrawn_usd)
 *
 * When you already have resolved state, prefer {@link getVaultPnLFromState} to
 * skip the duplicate RPC.
 */
export async function getVaultPnL(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: Network = "mainnet-beta",
): Promise<VaultPnL> {
  const state = await resolveVaultStateForOwner(rpc, vault, undefined, network);
  return getVaultPnLFromState(state);
}

// ─── Token balance query ────────────────────────────────────────────────────

import { TOKEN_PROGRAM_ADDRESS } from "./types.js";

/** Parsed token account data shape from jsonParsed encoding. */
interface ParsedTokenAccountData {
  parsed: {
    info: {
      mint: string;
      tokenAmount: { amount: string; decimals: number };
    };
  };
}

/**
 * Fetch all SPL token balances for a vault PDA.
 * Uses getTokenAccountsByOwner with jsonParsed encoding.
 * Excludes zero-balance accounts. Resolves well-known symbols.
 */
export async function getVaultTokenBalances(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  network: Network = "mainnet-beta",
): Promise<TokenBalance[]> {
  const response = await rpc
    .getTokenAccountsByOwner(
      vault,
      { programId: TOKEN_PROGRAM_ADDRESS },
      { encoding: "jsonParsed" },
    )
    .send();

  const balances: TokenBalance[] = [];
  for (const item of response.value) {
    const data = item.account.data as unknown as ParsedTokenAccountData;
    if (!data?.parsed?.info?.tokenAmount) continue;

    const info = data.parsed.info;
    const mint = info.mint as Address;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount === 0n) continue;

    const resolved = resolveToken(mint as string, network);
    const symbol = resolved
      ? resolved.symbol
      : (mint as string).slice(0, 4) + "...";
    const decimals = resolved ? resolved.decimals : info.tokenAmount.decimals;
    balances.push({ mint, balance: amount, symbol, decimals });
  }
  return balances;
}

// ─── Balance Snapshot Store (client-side, session-scoped) ───────────────────

/**
 * Client-side balance snapshot store for P&L charts.
 * Preserves baseline (first-ever snapshot, never evicted) for session-lifetime P&L.
 * Supports JSON serialization for cross-session persistence (localStorage/IndexedDB).
 */
export class BalanceSnapshotStore {
  private baseline: BalanceSnapshot | null = null;
  private readonly maxEntries: number;
  private readonly snapshots: Map<bigint, TokenBalance[]> = new Map();
  private orderedTimestamps: bigint[] = [];

  constructor(maxEntries = 144) {
    this.maxEntries = maxEntries;
  }

  snapshot(timestamp: bigint, balances: TokenBalance[]): void {
    if (!this.baseline) this.baseline = { timestamp, balances };

    // Guard against duplicate timestamps — update existing, don't push duplicate
    if (this.snapshots.has(timestamp)) {
      this.snapshots.set(timestamp, balances);
      return;
    }

    this.snapshots.set(timestamp, balances);
    this.orderedTimestamps.push(timestamp);

    while (this.orderedTimestamps.length > this.maxEntries) {
      const oldest = this.orderedTimestamps.shift()!;
      this.snapshots.delete(oldest);
    }
  }

  getBaseline(): BalanceSnapshot | null {
    return this.baseline;
  }

  getFirst(): BalanceSnapshot | null {
    if (this.orderedTimestamps.length === 0) return null;
    const ts = this.orderedTimestamps[0];
    return { timestamp: ts, balances: this.snapshots.get(ts)! };
  }

  getLatest(): BalanceSnapshot | null {
    if (this.orderedTimestamps.length === 0) return null;
    const ts = this.orderedTimestamps[this.orderedTimestamps.length - 1];
    return { timestamp: ts, balances: this.snapshots.get(ts)! };
  }

  get size(): number {
    return this.orderedTimestamps.length;
  }

  clear(): void {
    this.baseline = null;
    this.snapshots.clear();
    this.orderedTimestamps = [];
  }

  toJSON(): string {
    return JSON.stringify({
      baseline: this.baseline
        ? {
            timestamp: this.baseline.timestamp.toString(),
            balances: this.baseline.balances.map((b) => ({
              ...b,
              balance: b.balance.toString(),
            })),
          }
        : null,
      snapshots: Array.from(this.snapshots.entries()).map(([ts, bals]) => ({
        timestamp: ts.toString(),
        balances: bals.map((b) => ({ ...b, balance: b.balance.toString() })),
      })),
      maxEntries: this.maxEntries,
    });
  }

  /**
   * Reconstruct a BalanceSnapshotStore from its JSON serialization.
   *
   * F12 fix (type-design-analyzer): wraps BigInt() calls in try/catch so
   * corrupted JSON surfaces a domain-relevant error instead of raw
   * SyntaxError from BigInt("not-a-number").
   */
  static fromJSON(json: string): BalanceSnapshotStore {
    const data = JSON.parse(json);
    const maxEntries = Number.isInteger(data.maxEntries)
      ? data.maxEntries
      : 144;
    const store = new BalanceSnapshotStore(maxEntries);

    const safeBigInt = (val: unknown, field: string): bigint => {
      try {
        return BigInt(val as string);
      } catch {
        getSigilModuleLogger().warn(
          `[@usesigil/kit/BalanceSnapshotStore.fromJSON] Failed to parse bigint for "${field}": ${String(val).slice(0, 50)} — using 0n`,
        );
        return 0n;
      }
    };

    if (data.baseline) {
      store.baseline = {
        timestamp: safeBigInt(data.baseline.timestamp, "baseline.timestamp"),
        balances: data.baseline.balances.map((b: Record<string, unknown>) => ({
          ...b,
          balance: safeBigInt(b.balance, "baseline.balance"),
        })),
      };
    }
    for (const snap of data.snapshots ?? []) {
      const ts = safeBigInt(snap.timestamp, "snapshot.timestamp");
      const bals = (snap.balances ?? []).map((b: Record<string, unknown>) => ({
        ...b,
        balance: safeBigInt(b.balance, "snapshot.balance"),
      }));
      store.snapshots.set(ts, bals);
      store.orderedTimestamps.push(ts);
    }
    return store;
  }
}

// ─── Session-scoped P&L (from snapshots) ────────────────────────────────────

/**
 * Session-scoped P&L from balance snapshots (for charts).
 * Uses baseline → latest for session lifetime P&L.
 * Aggregates stablecoin balances only (USDC + USDT).
 */
export function getBalancePnL(
  store: BalanceSnapshotStore,
  network: Network = "mainnet-beta",
): BalancePnL {
  const baseline = store.getBaseline();
  const latest = store.getLatest();
  if (!baseline || !latest || baseline.timestamp === latest.timestamp) {
    return {
      startBalance: 0n,
      currentBalance: 0n,
      delta: 0n,
      percentChange: 0,
    };
  }

  const sumStablecoins = (balances: TokenBalance[]): bigint =>
    balances.reduce(
      (sum, b) => (isStablecoinMint(b.mint, network) ? sum + b.balance : sum),
      0n,
    );

  const startBalance = sumStablecoins(baseline.balances);
  const currentBalance = sumStablecoins(latest.balances);
  const delta = currentBalance - startBalance;
  const percentChange = computePnlPercent(delta, startBalance);

  return { startBalance, currentBalance, delta, percentChange };
}
