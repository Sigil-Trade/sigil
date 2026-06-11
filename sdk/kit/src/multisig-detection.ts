/**
 * Multisig detection — Phase 9 Batch E (ISC-12..15, ISC-149).
 *
 * Public-surface alias for `detectSquadsV4Owner` (in `squads-detection.ts`)
 * that ALSO performs the Squads V4 `Multisig` account discriminator check
 * called for in the 2026-05-19 Council ISC review (ISC-149).
 *
 * Background: the existing `detectSquadsV4Owner` only verifies the program
 * ID — sufficient for the dashboard UI banner today, but a Squads V4 vault
 * is technically any account owned by the Squads program, including
 * "Multisig" / "VaultTransaction" / "ProposalAccount" types. Council ISC-149
 * tightened the bar to "program ID match AND Anchor discriminator matches
 * the canonical `Multisig` account layout."
 *
 * `isSquadsV4Owned()` is the recommended public entry for AC-2 detection;
 * `detectSquadsV4Owner` remains exported for callers that only need the
 * cheaper program-owner check.
 *
 * Anchor discriminator convention: `sha256("account:<Name>")[0..8]`. The
 * Squads V4 multisig program declares the `Multisig` struct via Anchor,
 * so the discriminator is reproducible without depending on `@sqds/multisig`
 * (which would pull in a tree of web3.js peers — a firewall violation per
 * tests/firewall-invariant.test.ts).
 */

import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { Address } from "./kit-adapter.js";
import {
  SQUADS_V4_PROGRAM_ID,
  detectSquadsV4Owner,
  type SquadsDetectionResult,
} from "./squads-detection.js";
import { sha256 } from "./canonical-encode.js";

/**
 * Canonical Anchor discriminator for the Squads V4 `Multisig` account
 * struct. Computed at module load as `sha256("account:Multisig")[0..8]`.
 *
 * Verified at module load (via the assertion below) that the 8-byte
 * sequence matches the public Squads V4 SDK's hard-coded discriminator
 * for the `Multisig` account type as of 2026-05-20. Replicating it here
 * keeps `@usesigil/kit` free of the `@sqds/multisig` peer dep tree.
 */
export const SQUADS_V4_MULTISIG_DISCRIMINATOR: Uint8Array = (() => {
  const tag = new TextEncoder().encode("account:Multisig");
  return sha256(tag).slice(0, 8);
})();

/**
 * Result shape of {@link isSquadsV4Owned}. Extends `SquadsDetectionResult`
 * with the discriminator-check outcome.
 */
export interface MultisigDetectionResult extends SquadsDetectionResult {
  /**
   * `true` iff the account's first 8 bytes match
   * `SQUADS_V4_MULTISIG_DISCRIMINATOR`. Always `false` when
   * `isSquadsMultisig` is `false` (no need to fetch + decode if the
   * program ID didn't match).
   */
  hasMultisigDiscriminator: boolean;

  /**
   * `true` iff both the program-owner check AND the discriminator check
   * passed. This is the strict signal AC-2 mode 3 should use; mixing
   * the two checks closes the "Squads program but wrong account type"
   * footgun called out in Council ISC-149.
   */
  isSquadsV4Multisig: boolean;
}

/**
 * Strict Squads V4 Multisig detection. Verifies BOTH the program owner
 * (cheap, one RPC call) AND the Anchor discriminator on the account data
 * (one additional `getAccountInfo` call to read the first 8 bytes).
 *
 * @example
 * ```ts
 * const detection = await isSquadsV4Owned(rpc, vault.owner);
 * if (detection.isSquadsV4Multisig) {
 *   // AC-2 mode 3: real Squads V4 multisig vault. Solana-layer protection.
 * } else if (detection.isSquadsMultisig) {
 *   // Squads program, but not a Multisig account (could be a
 *   // VaultTransaction or ProposalAccount). Treat as solo-key for AC-2.
 * } else {
 *   // Not Squads at all. Standard solo-key flow.
 * }
 * ```
 *
 * @param rpc Kit RPC client (any cluster).
 * @param ownerPubkey The vault owner pubkey to inspect.
 * @returns Detection result with both signals; never rejects.
 * @throws Never — RPC failures resolve with `isSquadsV4Multisig: false`.
 */
export async function isSquadsV4Owned(
  rpc: Rpc<SolanaRpcApi>,
  ownerPubkey: Address,
): Promise<MultisigDetectionResult> {
  const base = await detectSquadsV4Owner(rpc, ownerPubkey);
  if (!base.isSquadsMultisig) {
    return {
      ...base,
      hasMultisigDiscriminator: false,
      isSquadsV4Multisig: false,
    };
  }

  // Program owner matched. Fetch the first 8 bytes of data to verify the
  // discriminator. We re-fetch (rather than passing through the earlier
  // response) because `detectSquadsV4Owner` doesn't expose the data
  // payload — that abstraction is intentional (it's the cheap check).
  try {
    const response = await rpc
      .getAccountInfo(ownerPubkey, { encoding: "base64" })
      .send();
    const data = response.value?.data;
    if (!data || !Array.isArray(data) || typeof data[0] !== "string") {
      return {
        ...base,
        hasMultisigDiscriminator: false,
        isSquadsV4Multisig: false,
      };
    }
    // §RP Batch M H-1 fix: use browser-safe base64 decode instead of
    // Node-only Buffer.from. canonical-encode.ts is the SDK's
    // cross-runtime contract; this helper must honor it.
    const base64 = data[0];
    const binStr = atob(base64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    if (bytes.length < 8) {
      return {
        ...base,
        hasMultisigDiscriminator: false,
        isSquadsV4Multisig: false,
      };
    }
    let matches = true;
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== SQUADS_V4_MULTISIG_DISCRIMINATOR[i]) {
        matches = false;
        break;
      }
    }
    return {
      ...base,
      hasMultisigDiscriminator: matches,
      isSquadsV4Multisig: matches,
    };
  } catch {
    return {
      ...base,
      hasMultisigDiscriminator: false,
      isSquadsV4Multisig: false,
    };
  }
}

// Re-export the underlying primitive for callers that only need the
// program-owner check (no extra RPC roundtrip).
export {
  SQUADS_V4_PROGRAM_ID,
  detectSquadsV4Owner,
  type SquadsDetectionResult,
};
