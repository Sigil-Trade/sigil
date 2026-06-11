/**
 * CAIP-2 Solana chain identifiers + AL4 isMainnet derivation.
 * Phase 9 Batch J (ISC-77..80, 147).
 *
 * Per the CAIP-2 spec (https://chainagnostic.org/CAIPs/caip-2), Solana
 * networks are identified by a `solana:<genesis-hash-prefix>` string. The
 * canonical IDs are registered at
 * https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip2.md.
 *
 * Sigil SDK V2 ships AL4 as a CAIP-2 chain id PLUS a derived `isMainnet`
 * boolean. Per Council ISC-147, exposing the full CAIP-2 string (not just
 * the boolean) preserves the future ability to bind testnet / localnet
 * intents without changing the SealResult shape — collapsing 4 networks
 * into 2 was flagged as a "footgun in waiting".
 */

import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_NETWORK } from "./errors/codes.js";

/** CAIP-2 namespace for Solana. */
export const CAIP2_NAMESPACE_SOLANA = "solana" as const;

/** Mainnet-beta CAIP-2 chain id. */
export const CAIP2_SOLANA_MAINNET =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

/** Devnet CAIP-2 chain id. */
export const CAIP2_SOLANA_DEVNET =
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;

/** Testnet CAIP-2 chain id (declared for completeness; not currently produced by `toCaip2`). */
export const CAIP2_SOLANA_TESTNET =
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" as const;

/**
 * The set of CAIP-2 strings the SDK currently emits. The narrower string
 * literal type prevents callers from constructing ad-hoc strings.
 */
export type SigilCaip2Chain =
  | typeof CAIP2_SOLANA_MAINNET
  | typeof CAIP2_SOLANA_DEVNET;

/**
 * Convert the SDK's internal `"devnet" | "mainnet"` network discriminant
 * to its canonical CAIP-2 chain id.
 *
 * @throws if `network` is not one of the two supported values. (Type
 * narrowing prevents this at compile time; the runtime check catches
 * misuse from JS callers or `any`-cast bypasses.)
 */
export function toCaip2(network: "devnet" | "mainnet"): SigilCaip2Chain {
  if (network === "mainnet") return CAIP2_SOLANA_MAINNET;
  if (network === "devnet") return CAIP2_SOLANA_DEVNET;
  throw new SigilSdkDomainError(
    SIGIL_ERROR__SDK__INVALID_NETWORK,
    `toCaip2: network must be 'devnet' or 'mainnet', got ${String(network)}`,
    {
      context: {
        operation: "toCaip2",
        received: String(network),
      } as never,
    },
  );
}

/**
 * Derive the AL4 `isMainnet` boolean from a CAIP-2 chain id.
 *
 * `isMainnet === true` ONLY when the chain id matches the canonical
 * mainnet-beta value. Devnet, testnet, localnet — anything else — all
 * return false. This is intentional: `isMainnet` is a SECURITY signal
 * (gate destructive defaults behind it); fuzzy matching would be a
 * footgun.
 */
export function isMainnetCaip2(chain: string): boolean {
  return chain === CAIP2_SOLANA_MAINNET;
}

/**
 * Convenience: combine `toCaip2` + `isMainnetCaip2` from a `"devnet" | "mainnet"`
 * input. Used by `seal()` to populate `SealResult.network` and
 * `SealResult.isMainnet` in a single call.
 */
export function deriveNetworkIdentity(network: "devnet" | "mainnet"): {
  network: SigilCaip2Chain;
  isMainnet: boolean;
} {
  const chain = toCaip2(network);
  return { network: chain, isMainnet: isMainnetCaip2(chain) };
}

/**
 * Convert a Sigil CAIP-2 string to a Wallet Standard chain identifier.
 *
 * Wallet Standard (https://github.com/wallet-standard/wallet-standard) uses
 * `solana:<network-id>` per the SIWS / Solana Mobile spec, which is the
 * exact same shape as Sigil's CAIP-2 strings (per the ChainAgnostic CAIP-2
 * registry — https://chainagnostic.org/CAIPs/caip-2). The conversion is
 * therefore identity at the value level — but the explicit helper
 * documents the boundary so that future wallet-standard surface changes
 * (e.g. an extra cluster discriminant, a versioning suffix) localize to
 * this one function rather than spreading raw CAIP-2 casts across SIWS,
 * connector adapters, and the seal() result shape.
 *
 * The return type is the wider template-literal `\`solana:${string}\`` to
 * keep the helper assignable to Wallet Standard `IdentifierString` /
 * `WalletWithSolanaFeatures` chain fields without consumers needing to
 * narrow back through `SigilCaip2Chain`.
 *
 * @param caip2 — a CAIP-2 chain id produced by {@link toCaip2} or one of
 *   the `CAIP2_SOLANA_*` constants. The argument MUST already be in the
 *   `solana:<id>` form; this helper does not validate.
 */
export function toWalletStandardChain(
  caip2: SigilCaip2Chain,
): `solana:${string}` {
  return caip2;
}

// ─── M-3 (audit 2026-05-21): RPC-grounded network verification ──────────────
//
// `isMainnetCaip2()` and `toCaip2()` are PURE string transforms over a
// caller-supplied "devnet" | "mainnet" discriminant — they cannot detect
// the case where a caller hands the SDK a `devnet` RPC URL while passing
// `network: "mainnet"`. seal.ts handles this via the genesis-hash gate
// in `assertGenesisHash` (called unconditionally inside the
// `createSigilClientAsync` factory unless `skipGenesisAssertion=true`),
// but consumers that build raw transactions outside the factory path
// have no equivalent check.
//
// `verifyNetworkIdentity()` is an opt-in, non-throwing diagnostic that
// any consumer can call to verify their RPC actually serves the cluster
// they think it does. Returns a structured result instead of throwing so
// it can be used in linter-style preflight checks without disrupting
// transactional flows.

/**
 * Network discriminant the SDK accepts as a `"devnet" | "mainnet"`
 * string. Re-exported here so consumers of `verifyNetworkIdentity` don't
 * need a separate import.
 */
export type SigilNetwork = "devnet" | "mainnet";

/**
 * Canonical Solana genesis hashes, keyed by network. Values are the full
 * 44-character base58 hashes returned by `rpc.getGenesisHash()`.
 *
 *   mainnet-beta: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
 *   devnet:       EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
 *   testnet:      4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY
 *
 * Source: Solana Foundation Cluster RPC documentation
 * (https://solana.com/docs/core/clusters). Hardcoded here so the
 * verification path is offline-deterministic — a malicious RPC cannot
 * substitute its own "canonical" hash.
 */
export const SOLANA_GENESIS_HASHES = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

/** The set of networks `verifyNetworkIdentity` can report as `actualNetwork`. */
export type SigilActualNetwork = keyof typeof SOLANA_GENESIS_HASHES | "unknown";

/**
 * Minimal RPC shape consumed by {@link verifyNetworkIdentity}. Matches
 * the `@solana/kit` RPC contract so callers can pass the same `rpc`
 * object they already use elsewhere in the SDK.
 */
export interface GenesisRpc {
  getGenesisHash(): { send(): Promise<string> };
}

/** Structured result returned by {@link verifyNetworkIdentity}. */
export interface NetworkIdentityResult {
  /** `true` iff the RPC's reported genesis matches the caller's `claimedNetwork`. */
  verified: boolean;
  /**
   * The network the RPC actually serves, derived from `getGenesisHash()`.
   * `"unknown"` indicates the RPC returned a hash that doesn't match any
   * canonical cluster (likely a Surfpool/LiteSVM local validator).
   */
  actualNetwork: SigilActualNetwork;
  /**
   * Optional human-readable explanation. Populated when `verified === false`
   * (mismatch) OR when `getGenesisHash()` errored / returned malformed data.
   */
  reason?: string;
  /** The raw hash observed from the RPC (for diagnostic logging). */
  observedGenesisHash?: string;
  /** The hash the SDK expected for `claimedNetwork`. */
  expectedGenesisHash: string;
}

/**
 * Verify that an RPC actually serves the cluster a caller claims it does.
 *
 * **Opt-in, non-throwing diagnostic.** Unlike `assertGenesisHash` in
 * seal.ts (which is called inside `createSigilClientAsync` and throws on
 * mismatch), this helper returns a structured result so callers can
 * branch on it without `try/catch`. Use it in preflight checks, in
 * `mainnetConfirmed` confirmation flows that want to surface the
 * mismatch to the operator, or anywhere raw-tx-building code paths
 * bypass the client factory.
 *
 * **Does NOT change `seal()` default behaviour.** The existing seal
 * factory still calls `assertGenesisHash` (which throws) — that's the
 * load-bearing safety gate. `verifyNetworkIdentity` is purely additive.
 *
 * @example
 * ```ts
 * const result = await verifyNetworkIdentity({
 *   rpc,
 *   claimedNetwork: "mainnet",
 * });
 * if (!result.verified) {
 *   console.error(
 *     `Refusing to submit mainnet tx — RPC reports ${result.actualNetwork} ` +
 *     `(genesis ${result.observedGenesisHash}); ` +
 *     `expected mainnet (${result.expectedGenesisHash}).`,
 *   );
 *   throw new Error("Network mismatch");
 * }
 * ```
 */
export async function verifyNetworkIdentity(input: {
  rpc: GenesisRpc;
  claimedNetwork: SigilNetwork;
}): Promise<NetworkIdentityResult> {
  const { rpc, claimedNetwork } = input;
  if (claimedNetwork !== "devnet" && claimedNetwork !== "mainnet") {
    // Defensive: JS callers or `any`-cast bypasses. Returned as
    // unverified rather than throwing so the helper stays "diagnostic".
    return {
      verified: false,
      actualNetwork: "unknown",
      expectedGenesisHash: "",
      reason: `claimedNetwork must be 'devnet' or 'mainnet', got ${String(claimedNetwork)}`,
    };
  }
  const expectedGenesisHash =
    claimedNetwork === "mainnet"
      ? SOLANA_GENESIS_HASHES.mainnet
      : SOLANA_GENESIS_HASHES.devnet;

  let observed: string;
  try {
    observed = await rpc.getGenesisHash().send();
  } catch (err) {
    return {
      verified: false,
      actualNetwork: "unknown",
      expectedGenesisHash,
      reason: `getGenesisHash() failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof observed !== "string" || observed.length < 32) {
    return {
      verified: false,
      actualNetwork: "unknown",
      expectedGenesisHash,
      observedGenesisHash: observed == null ? undefined : String(observed),
      reason:
        "getGenesisHash() returned a malformed response — expected a 44-char base58 string",
    };
  }

  // Identify the actual cluster the RPC serves.
  let actualNetwork: SigilActualNetwork = "unknown";
  for (const [name, hash] of Object.entries(SOLANA_GENESIS_HASHES) as [
    SigilActualNetwork,
    string,
  ][]) {
    if (observed === hash) {
      actualNetwork = name;
      break;
    }
  }

  if (observed === expectedGenesisHash) {
    return {
      verified: true,
      actualNetwork,
      expectedGenesisHash,
      observedGenesisHash: observed,
    };
  }
  return {
    verified: false,
    actualNetwork,
    expectedGenesisHash,
    observedGenesisHash: observed,
    reason:
      `Cluster mismatch — RPC reports ${actualNetwork} (genesis ${observed}) ` +
      `but caller claimed ${claimedNetwork} (expected ${expectedGenesisHash}).`,
  };
}
