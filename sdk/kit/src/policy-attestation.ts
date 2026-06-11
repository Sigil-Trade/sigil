/**
 * Policy attestation reader — Phase 9 Batch E (ISC-19..21).
 *
 * `getLatestPolicyAttestation` resolves the current on-chain PolicyConfig
 * for a vault and returns the decoded view. Sigil's "attestation" model:
 * every policy mutation runs through `queue_policy_update` →
 * `apply_pending_policy` (the timelock-gated apply), and the resulting
 * `PolicyConfig` PDA is the cryptographic attestation that "the owner
 * approved these rules at timestamp T" — anchored by the `policy_version`
 * monotonic counter + the canonical `policy_preview_digest` field (TA-19).
 *
 * Returns the current policy state. Callers that need to inspect a
 * pending-but-not-yet-applied policy should call
 * `fetchPendingPolicyUpdate` separately (different PDA, different
 * decoder; not exported here because pending state isn't an attestation
 * — it's a proposal).
 */

import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { Address } from "./kit-adapter.js";
import {
  fetchPolicyConfig,
  type PolicyConfig,
} from "./generated/accounts/policyConfig.js";

/**
 * Result shape of {@link getLatestPolicyAttestation}.
 *
 * `attestation` is the decoded policy. `policyConfigPda` is the address
 * we read from (caller can use it to deep-link to a dashboard view).
 * `policyVersion` is hoisted from `attestation.policyVersion` for
 * convenience — it's the field UI surfaces always need.
 */
export interface PolicyAttestation {
  attestation: PolicyConfig;
  policyConfigPda: Address;
  policyVersion: number | bigint;
}

/**
 * Fetch + decode the live `PolicyConfig` PDA for a vault.
 *
 * @example
 * ```ts
 * const result = await getLatestPolicyAttestation(rpc, policyConfigPda);
 * console.log(
 *   `Vault is on policy version ${result.policyVersion} ` +
 *   `with daily cap $${result.attestation.dailySpendingCapUsd / 1_000_000n}.`,
 * );
 * ```
 *
 * @throws if the PDA does not exist (vault not initialized) — caller is
 *   responsible for surfacing the `policy-not-found` UX. Kit's RPC layer
 *   throws via `@solana/kit`'s `fetchEncodedAccount`-style error.
 */
export async function getLatestPolicyAttestation(
  rpc: Rpc<SolanaRpcApi>,
  policyConfigPda: Address,
): Promise<PolicyAttestation> {
  const account = await fetchPolicyConfig(rpc, policyConfigPda);
  return {
    attestation: account.data,
    policyConfigPda,
    policyVersion: account.data.policyVersion,
  };
}
