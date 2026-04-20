/**
 * Shared mock vault state factory for unit tests.
 *
 * Consolidates duplicated makeCachedState() / mockResolvedState() patterns
 * from wrap.test.ts, shield.test.ts, velocity-tracker.test.ts, etc.
 */

import type { Address } from "../kit-adapter.js";
import { VaultStatus } from "../generated/types/vaultStatus.js";
import type { ResolvedVaultState } from "../state-resolver.js";
import { FULL_CAPABILITY } from "../types.js";
import { MOCK_VAULT, MOCK_AGENT, MOCK_OWNER } from "./mock-rpc.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MockVaultStateOverrides {
  vault?: Address;
  agent?: Address;
  owner?: Address;
  status?: VaultStatus;
  agentPaused?: boolean;
  agentCapability?: bigint;
  /** @deprecated Use agentCapability instead. */
  agentPermissions?: bigint;
  noAgents?: boolean;
  dailyCap?: bigint;
  spent24h?: bigint;
  protocolMode?: number;
  protocols?: Address[];
  developerFeeRate?: number;
  feeDestination?: Address;
  totalDepositedUsd?: bigint;
  totalWithdrawnUsd?: bigint;
  stablecoinBalances?: { usdc: bigint; usdt: bigint };
  maxTransactionSizeUsd?: bigint;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createMockVaultState(
  overrides?: MockVaultStateOverrides,
): ResolvedVaultState {
  const vault = overrides?.vault ?? MOCK_VAULT;
  const agent = overrides?.agent ?? MOCK_AGENT;
  const owner = overrides?.owner ?? MOCK_OWNER;
  const status = overrides?.status ?? VaultStatus.Active;
  const dailyCap = overrides?.dailyCap ?? 1_000_000_000n;
  const spent = overrides?.spent24h ?? 0n;
  const maxTx = overrides?.maxTransactionSizeUsd ?? dailyCap;
  const feeDestination =
    overrides?.feeDestination ??
    ("FeeDestination1111111111111111111111111111" as Address);

  return {
    vault: {
      discriminator: new Uint8Array(8),
      owner,
      vaultId: 0n,
      agents: overrides?.noAgents
        ? []
        : [
            {
              pubkey: agent,
              capability: Number(
                overrides?.agentCapability ??
                  overrides?.agentPermissions ??
                  FULL_CAPABILITY,
              ),
              spendingLimitUsd: 0n,
              paused: overrides?.agentPaused ?? false,
              reserved: new Uint8Array(7),
            },
          ],
      feeDestination,
      status,
      bump: 255,
      createdAt: 1000n,
      totalTransactions: 0n,
      totalVolume: 0n,
      activeEscrowCount: 0,
      totalFeesCollected: 0n,
      totalDepositedUsd: overrides?.totalDepositedUsd ?? 0n,
      totalWithdrawnUsd: overrides?.totalWithdrawnUsd ?? 0n,
      totalFailedTransactions: 0n,
      activeSessions: 0,
    },
    policy: {
      discriminator: new Uint8Array(8),
      vault,
      dailySpendingCapUsd: dailyCap,
      maxTransactionSizeUsd: maxTx,
      protocolMode: overrides?.protocolMode ?? 0,
      protocols: overrides?.protocols ?? [],
      maxLeverageBps: 0,
      developerFeeRate: overrides?.developerFeeRate ?? 0,
      maxSlippageBps: 100,
      timelockDuration: 0n,
      allowedDestinations: [],
      hasConstraints: false,
      hasPendingPolicy: false,
      hasProtocolCaps: false,
      protocolCaps: [],
      sessionExpirySlots: 0n,
      bump: 255,
      policyVersion: 0n,
      hasPostAssertions: 0,
    },
    tracker: null,
    overlay: null,
    constraints: null,
    globalBudget: {
      spent24h: spent,
      cap: dailyCap,
      remaining: dailyCap > spent ? dailyCap - spent : 0n,
    },
    agentBudget: null,
    allAgentBudgets: new Map(),
    protocolBudgets: [],
    maxTransactionUsd: maxTx,
    stablecoinBalances: overrides?.stablecoinBalances ?? { usdc: 0n, usdt: 0n },
    resolvedAtTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
}
