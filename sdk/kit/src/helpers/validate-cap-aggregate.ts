/**
 * validateAgentCapAggregate — enforce sum of agent per-agent caps ≤ vault
 * daily cap.
 *
 * Rationale: D12 closes Pentester finding F3 ("$100/agent × 10 agents =
 * $1,000 rolling — vault daily cap $500"). The on-chain program enforces
 * the vault-wide cap and the per-agent cap as separate checks, but both
 * are satisfied simultaneously when the sum of per-agent caps exceeds
 * the vault cap — any single agent inside its own limit can still
 * contribute to a combined burn above the vault ceiling. Blocking this
 * in the SDK before any of `createVault`, `registerAgent`, or
 * `queueAgentPermissionsUpdate` sends the instruction keeps the UX
 * honest: the consumer sees the problem during setup, not at cap time.
 *
 * Called at two entry points:
 *   1. `createVault` (A8) with `existingAgentCaps: []` — validates the
 *      initial agent's cap against the new vault's daily cap.
 *   2. `addAgent` / `queueAgentPermissionsUpdate` (Sprint 2) with
 *      `existingAgentCaps` populated from the current vault state.
 *
 * A cap of `0n` means the agent is Observer-class and has no spending
 * budget of its own — it contributes zero to the aggregate and is
 * always valid regardless of the existing caps' sum.
 *
 * @throws {SigilSdkDomainError} SIGIL_ERROR__SDK__CAP_EXCEEDED when
 *   `sum(existingAgentCaps) + newAgentCap > vaultDailyCap`.
 */

import { SigilSdkDomainError } from "../errors/sdk.js";
import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "../errors/codes.js";

export interface ValidateAgentCapAggregateParams {
  /** Vault-wide daily spending cap in USD base units (6-decimal). */
  vaultDailyCap: bigint;
  /**
   * Per-agent caps for every agent already registered on the vault.
   * Empty on first agent (fresh `createVault`); populated from
   * resolved vault state on subsequent `addAgent` calls.
   */
  existingAgentCaps: readonly bigint[];
  /** Per-agent cap for the agent being added or updated. */
  newAgentCap: bigint;
}

export function validateAgentCapAggregate(
  params: ValidateAgentCapAggregateParams,
): void {
  const { vaultDailyCap, existingAgentCaps, newAgentCap } = params;

  // Reject negative inputs early — bigint doesn't prevent them, but
  // every cap on the system is a magnitude value.
  if (vaultDailyCap < 0n || newAgentCap < 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__CAP_EXCEEDED,
      `validateAgentCapAggregate received negative input — ` +
        `vaultDailyCap=${vaultDailyCap}, newAgentCap=${newAgentCap}. ` +
        `Caps are unsigned magnitudes.`,
      { context: { vaultDailyCap, newAgentCap } as never },
    );
  }
  for (const c of existingAgentCaps) {
    if (c < 0n) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__CAP_EXCEEDED,
        `validateAgentCapAggregate received a negative existingAgentCap (${c}).`,
        { context: { existingAgentCaps: [...existingAgentCaps] } as never },
      );
    }
  }

  let sum = newAgentCap;
  for (const cap of existingAgentCaps) sum += cap;

  if (sum > vaultDailyCap) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__CAP_EXCEEDED,
      `Aggregate per-agent cap (${sum} in 6-decimal USD base units) ` +
        `exceeds vault daily cap (${vaultDailyCap}). Sum of all agents' ` +
        `spendingLimitUsd must be ≤ dailySpendingCapUsd to prevent ` +
        `concurrent-burn attacks where each agent stays within its own ` +
        `limit but the combined outflow breaches the vault's ceiling.`,
      {
        context: {
          vaultCap: vaultDailyCap,
          sum,
          agents: [...existingAgentCaps, newAgentCap],
        } as never,
      },
    );
  }
}
