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
  /** Phase 2 TA-19 mock override (default false). */
  observeOnly?: boolean;
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
              // TA-17 (Phase 3): fresh agent has no consecutive failures.
              consecutiveFailures: 0,
              reserved: new Uint8Array(6),
            },
          ],
      feeDestination,
      status,
      bump: 255,
      createdAt: 1000n,
      totalTransactions: 0n,
      totalVolume: 0n,
      totalFeesCollected: 0n,
      totalDepositedUsd: overrides?.totalDepositedUsd ?? 0n,
      totalWithdrawnUsd: overrides?.totalWithdrawnUsd ?? 0n,
      totalFailedTransactions: 0n,
      activeSessions: 0,
      observeOnly: overrides?.observeOnly ?? false,
      frozenAtTimestamp: 0n,
      freezeReason: 0,
      // Phase 8 LBL-01: immutable PDA seed-key. At init, this equals the
      // owner — so the mock factory mirrors that invariant. Tests that
      // exercise post-ownership-transfer state should NOT update this
      // field; only `owner` mutates on transfer, `vaultAuthority` stays
      // at the original initial-owner pubkey.
      vaultAuthority: owner,
    },
    policy: {
      discriminator: new Uint8Array(8),
      vault,
      dailySpendingCapUsd: dailyCap,
      maxTransactionSizeUsd: maxTx,
      protocolMode: overrides?.protocolMode ?? 0,
      protocols: overrides?.protocols ?? [],
      developerFeeRate: overrides?.developerFeeRate ?? 0,
      maxSlippageBps: 100,
      timelockDuration: 0n,
      allowedDestinations: [],
      hasPendingPolicy: false,
      hasProtocolCaps: false,
      protocolCaps: [],
      sessionExpirySeconds: 0n,
      bump: 255,
      policyVersion: 0n,
      hasPostAssertions: 0,
      destinationMode: 0,
      // Mock fixtures don't exercise the on-chain digest assertion path —
      // tests use this state for reads only. Pad with zeros.
      policyPreviewDigest: new Uint8Array(32),
      createdAtSlot: 0n,
      // TA-05 (Phase 3): operating_hours is read by SDK consumers; default
      // all-24h matches the on-chain "no operating-hours constraint" semantics.
      operatingHours: 0x00ffffff,
      // TA-07 (Phase 3): empty graylist + default-off auto-promote.
      destinationGraylist: [],
      autoPromoteGrays: false,
      // TA-17 (Phase 3): default threshold of 5.
      autoRevokeThreshold: 5,
      // TA-12/14 (Phase 5): post-execution invariants. Mock defaults are 0
      // (no floor, no per-recipient cap) — matches "off" semantics.
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
      // G6 (audit 2026-05-18 cosign opt-in): mock default = false
      // (low-friction). Matches the production default; tests exercising
      // the cosign-required path should override at construction time.
      cosignRequired: false,
      // D-5 (audit 2026-05-19, F-RP3-1): mock default = `Pubkey::default()`
      // (gate disabled). The base58 encoding of 32 zero bytes is
      // "11111111111111111111111111111111" (the System Program pubkey).
      // Matches the on-chain init default; tests exercising the
      // reactivate-cosign gate should override here AND construct a vault
      // that has queued+applied the opt-in via `queue_policy_update`.
      cosignSessionPubkey:
        "11111111111111111111111111111111" as unknown as Address,
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
