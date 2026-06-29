/**
 * Item 1 — verified-build gate arming helper.
 *
 * `computeVerifiedBuildHash` resolves the 32-byte program-data SHA-256 that an
 * owner pins into `PolicyConfig.protocol_hashes` (via
 * `PolicyChanges.protocolHashes`) to ARM the verified-build gate for a
 * protocol. Once armed, `validate_and_authorize` rejects a target whose
 * deployed ELF no longer matches the pinned hash (on-chain 6116/6117),
 * closing the upgrade-TOCTOU: an owner allowlists a program, it is later
 * upgraded to a drain contract, and pure-pubkey allowlisting keeps
 * authorizing.
 *
 * This is a thin, intent-named wrapper over {@link getProgramDataHash} — hash
 * ONLY. It deliberately does NOT touch the digest or the 10-entry array;
 * assembling those (seed-from-live + slot resolution + TA-19 digest) is the
 * job of the policy mutation builders, which keep the ix arg and the digest
 * byte-identical. Splitting "compute one hash" from "assemble the array"
 * avoids re-introducing the dual-builder digest drift the 2026-06-11 audit
 * closed (PolicyPreviewMismatch 6071).
 */
import type { Address, Rpc, SolanaRpcApi } from "../kit-adapter.js";
import { getProgramDataHash } from "../program-hash.js";

/**
 * Fetch a deployed upgradeable program's `ProgramData` account and return the
 * 32-byte SHA-256 of its executable ELF — the value to arm into
 * `PolicyChanges.protocolHashes` for the verified-build gate.
 *
 * Throws (via {@link getProgramDataHash}) if the program is not an upgradeable
 * deployment, the `ProgramData` account is missing / not owned by
 * BPFLoaderUpgradeable, or the RPC response is truncated — so a caller can
 * never silently pin a hash over a non-program or a malformed response.
 *
 * @param rpc        a `@solana/kit` RPC client
 * @param programId  the address of the deployed protocol program (NOT its
 *                   `ProgramData` account)
 * @returns the 32-byte SHA-256 of the program's current ELF
 *
 * @example
 * ```ts
 * const hash = await computeVerifiedBuildHash(rpc, jupiterProgramId);
 * await owner.queuePolicyUpdate({
 *   protocolHashes: new Map([[jupiterProgramId, hash]]),
 * });
 * ```
 */
export async function computeVerifiedBuildHash(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<Uint8Array> {
  return getProgramDataHash(rpc, programId);
}
