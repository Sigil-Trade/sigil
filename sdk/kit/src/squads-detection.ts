/**
 * G6 (audit 2026-05-18 cosign opt-in) — Squads V4 multisig detection helper.
 *
 * Read-only off-chain SDK helper that inspects whether a given vault owner
 * pubkey is owned by the Squads V4 multisig program. Used by the dashboard
 * to decide whether to surface the "single-signer protection" warning
 * banner when the owner has not opted into TA-09 cosign enforcement.
 *
 * Categorization per AC-2 (Owner Key Leak) post-mitigation modes:
 *
 *   1. Solo key + cosign_required=false (default, low-friction):
 *      owner signature alone authorizes elevated mutations. UI surfaces
 *      a warning recommending Squads multisig OR enabling cosign.
 *      Use case: dev/test, low-stakes vaults, AI agent automation.
 *
 *   2. Solo key + cosign_required=true (explicit opt-in):
 *      TA-09 enforces cosign on elevated mutations. Use case: solo
 *      founder wants Sigil-native per-mutation co-signature.
 *
 *   3. Squads V4 multisig owner + cosign_required=false (recommended
 *      for production): multisig at the Solana layer enforces N-of-M
 *      on every owner action; Sigil cosign is unnecessary on top.
 *      Detection via this helper allows the dashboard to recognize
 *      this mode and skip the warning banner.
 *
 * IMPORTANT: Sigil DOES NOT enforce multisig on-chain. The vault owner
 * field is just a Pubkey. Squads is a separate Solana-level concern
 * that users set up on their own at https://app.squads.so. This helper
 * only DETECTS the configuration to give the dashboard ergonomic
 * affordances — it is NOT a security boundary.
 *
 * Off-chain helper category per [INTERFACES_V2 §4.4]:
 * (https://github.com/usesigil/agent-middleware/blob/main/docs/revamp/INTERFACES_V2.md)
 * `TA-18` is the existing Squads detection primitive locked LOCKED-OFF-
 * CHAIN-ONLY. This file is the V2 implementation surface for that
 * primitive, scoped to the read-only program-owner check.
 *
 * @see https://docs.squads.so for Squads protocol documentation
 * @see programs/sigil/src/instructions/queue_policy_update.rs — on-chain
 *      cosign elevation gating gated on `policy.cosign_required`
 */

import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { Address } from "./kit-adapter.js";

/**
 * Squads V4 multisig program ID (mainnet + devnet — same address per
 * https://docs.squads.so/main/v/development/squads-v4/program-addresses).
 *
 * Verified against the Squads V4 GitHub repo + the canonical Squads SDK
 * docs (`@sqds/multisig`) as of 2026-05-18.
 */
export const SQUADS_V4_PROGRAM_ID: Address =
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" as Address;

/**
 * Result shape of {@link detectSquadsV4Owner}. The `detectionMethod`
 * field is exposed for telemetry / debugging — production UI only
 * needs to branch on `isSquadsMultisig`.
 */
export interface SquadsDetectionResult {
  /**
   * `true` iff the account exists AND its `owner` field equals
   * {@link SQUADS_V4_PROGRAM_ID}. `false` in every other case
   * (account missing, RPC failure, owned by a different program).
   *
   * The dashboard uses this to decide whether to suppress the
   * "single-signer protection" warning banner in AC-2 mode 3.
   */
  isSquadsMultisig: boolean;

  /**
   * The actual `owner` field from `getAccountInfo`, surfaced for
   * advanced UI surfaces that want to display "owned by program X" or
   * to detect other multisig programs (Squads V3, Realms, etc.).
   * `null` when the account does not exist OR the RPC call failed.
   */
  programOwner: Address | null;

  /**
   * Detection method used (for telemetry / debugging).
   *
   * - `"program-owner"`: the RPC returned an account whose `owner`
   *   field we successfully compared against `SQUADS_V4_PROGRAM_ID`.
   *   `isSquadsMultisig` is true OR false based on equality.
   * - `"account-missing"`: the RPC returned `null` for `value` — the
   *   pubkey is not a created account (or has been closed since).
   *   `isSquadsMultisig` is forced to `false`. A wallet-keypair owner
   *   that has not yet been funded falls into this bucket.
   * - `"rpc-failure"`: the RPC call threw or returned a non-2xx /
   *   malformed response. `isSquadsMultisig` is forced to `false`
   *   (fail-safe: assume not multisig and let the warning banner
   *   surface; do not silently call a wallet multisig when we don't
   *   know).
   */
  detectionMethod: "program-owner" | "account-missing" | "rpc-failure";
}

/**
 * Read-only check: is the given pubkey an account owned by the Squads
 * V4 multisig program?
 *
 * Reads `getAccountInfo(pubkey)` from the RPC and inspects the `owner`
 * field. If the account doesn't exist, returns `isSquadsMultisig=false`
 * and method `"account-missing"`. If the RPC call fails (network
 * issue), returns `isSquadsMultisig=false` and method `"rpc-failure"` —
 * fail-safe: assume not multisig and let the warning UI surface.
 *
 * Does NOT decode Squads-specific account data. Pure program-owner check.
 * This is intentional — Sigil makes NO assumption about the multisig's
 * threshold, member count, time-lock, or any other internal Squads
 * configuration. The dashboard surfaces "this is a Squads vault" as a
 * binary signal; users follow the link to squads.so to inspect the
 * actual configuration.
 *
 * Performance: a single `getAccountInfo` RPC call. Suitable for
 * dashboard read flows; not recommended for hot-path transaction
 * building (cache the result for the session).
 *
 * @example
 * ```ts
 * import { detectSquadsV4Owner } from "@usesigil/kit";
 *
 * const result = await detectSquadsV4Owner(rpc, vaultOwnerPubkey);
 * if (result.isSquadsMultisig) {
 *   // AC-2 mode 3: multisig protection at the Solana layer.
 *   // Suppress the "single-signer protection" warning banner.
 * } else if (!policy.cosignRequired) {
 *   // AC-2 mode 1: solo key + cosign opted out.
 *   // Show the warning banner recommending Squads OR cosign.
 * } else {
 *   // AC-2 mode 2: solo key + cosign opted in.
 *   // Sigil-native per-mutation co-signature. Show calmer banner.
 * }
 * ```
 *
 * @param rpc Kit RPC client (any cluster).
 * @param ownerPubkey The vault owner pubkey to inspect.
 * @returns Detection result; always resolved (never rejects).
 */
export async function detectSquadsV4Owner(
  rpc: Rpc<SolanaRpcApi>,
  ownerPubkey: Address,
): Promise<SquadsDetectionResult> {
  try {
    const response = await rpc
      .getAccountInfo(ownerPubkey, { encoding: "base64" })
      .send();

    // Kit's getAccountInfo wraps the response in `{ value: ... | null }`.
    // null = account does not exist OR was closed.
    if (!response.value) {
      return {
        isSquadsMultisig: false,
        programOwner: null,
        detectionMethod: "account-missing",
      };
    }

    const programOwner = response.value.owner as unknown as Address;
    return {
      isSquadsMultisig: programOwner === SQUADS_V4_PROGRAM_ID,
      programOwner,
      detectionMethod: "program-owner",
    };
  } catch {
    // Fail-safe: any RPC error (network, malformed response, timeout)
    // resolves to "not multisig". The UI warning banner surfaces;
    // we never silently claim multisig protection on uncertain data.
    return {
      isSquadsMultisig: false,
      programOwner: null,
      detectionMethod: "rpc-failure",
    };
  }
}
