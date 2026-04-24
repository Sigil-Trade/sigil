/**
 * `@usesigil/kit/protocol-registry` — Sigil's hand-curated Verified-tier
 * annotation registry.
 *
 * Migrated from `sigil-dashboard/src/lib/protocol-registry/` per the v2.2
 * FE↔BE contract commitment C6. Now consumed by the dashboard, the future
 * React Native mobile app, the future `@usesigil/mcp` server, the emergency
 * CLI — and any third-party partner that needs tier classification without
 * a round-trip to `sigil.trade`.
 *
 * Format choice: JSON, not YAML. Every annotation file declares ONE
 * verified protocol (hand-curated, audited programId + display metadata).
 * New protocols require adding one JSON file + one import line below.
 *
 * ## JSON import attribute
 *
 * Every annotation import uses `with { type: "json" }`. Without it, raw
 * Node ESM loaders (Node ≥ 20.10) reject the module at consume time with
 * `ERR_IMPORT_ATTRIBUTE_MISSING`. Vitest / ts-mocha / Webpack / Vite mask
 * the error via their transform pipelines, so forgetting the attribute
 * passes local tests but ships a broken package — the exact bug caught
 * during sigil-constraints 0.3.0-beta.1 pre-flight.
 *
 * ## What "Verified" means
 *
 * The Sigil team has hand-confirmed the programId is correct AND provides
 * convenience metadata (name, category, notes). The CONSTRAINT PARSER runs
 * the SAME PATH on Verified and Unverified programs — this registry is a
 * convenience + trust-signaling layer, not a safety gate. Non-constrainable
 * is a PARSER verdict (missing IDL / binary-only / dynamic layout), NOT a
 * registry property. See `Sigil.resolveProtocolTier()` in `./protocol-tier.ts`.
 */
import jupiter from "./annotations/jupiter.json" with { type: "json" };
import flashTrade from "./annotations/flash-trade.json" with { type: "json" };
import jupiterLend from "./annotations/jupiter-lend.json" with { type: "json" };
import jupiterEarn from "./annotations/jupiter-earn.json" with { type: "json" };
import jupiterBorrow from "./annotations/jupiter-borrow.json" with { type: "json" };
import drift from "./annotations/drift.json" with { type: "json" };
import kamino from "./annotations/kamino.json" with { type: "json" };

/**
 * Single Verified-tier annotation shape. Byte-identical to the dashboard's
 * pre-migration interface at `sigil-dashboard/src/lib/protocol-registry/index.ts`
 * so consumers switching from local imports to `@usesigil/kit` see zero
 * behavioral drift.
 */
export interface ProtocolAnnotation {
  /** Canonical base58 programId. Hand-verified against the deployed program. */
  readonly programId: string;
  /** Human-readable display name, e.g. "Jupiter V6". */
  readonly name: string;
  /** Always `true` for annotations shipped in this registry. */
  readonly verified: boolean;
  /** Bucket for UI grouping, e.g. "swap-aggregator", "perps", "lending". */
  readonly category: string;
  /** Optional free-form context (CU budget, known quirks, caveats). */
  readonly notes?: string;
}

/**
 * All registered annotations in display order (most-used first). Consumers
 * should NOT mutate — the array is `readonly` at the type level; the
 * underlying data is also `as const` below to guard against runtime edits.
 */
export const PROTOCOL_ANNOTATIONS: readonly ProtocolAnnotation[] = [
  jupiter,
  flashTrade,
  jupiterLend,
  jupiterEarn,
  jupiterBorrow,
  drift,
  kamino,
] as const;

/**
 * The set of programIds in the Verified tier. Computed once at module
 * load. `VERIFIED_PROGRAMS.has(programId)` is the canonical synchronous
 * check for "does Sigil have hand-curated metadata for this program."
 *
 * Consumers (dashboard `/api/resolve-protocol`, mobile tier UI, MCP)
 * should query this set — NOT filter PROTOCOL_ANNOTATIONS linearly on the
 * hot path. Use `lookupProtocolAnnotation()` when metadata is also needed.
 */
export const VERIFIED_PROGRAMS: ReadonlySet<string> = new Set(
  PROTOCOL_ANNOTATIONS.filter((a) => a.verified).map((a) => a.programId),
);

/**
 * Look up a protocol annotation by programId. Returns `null` if the
 * programId is NOT in the Verified registry.
 *
 * Currently an O(n) linear search across 7 entries — fast enough that a
 * `Map` lookup would be premature optimization. If the registry grows
 * past ~50 entries, swap to a `Map<string, ProtocolAnnotation>` built
 * once at module load.
 */
export function lookupProtocolAnnotation(
  programId: string,
): ProtocolAnnotation | null {
  return PROTOCOL_ANNOTATIONS.find((a) => a.programId === programId) ?? null;
}
