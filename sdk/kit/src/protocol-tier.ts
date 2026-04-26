/**
 * `@usesigil/kit/protocol-tier` — Three-tier trust-model primitives.
 *
 * Implements the SDK surface for the FE↔BE contract §5c / commitment C6.
 * Every FE "approve protocol" UI queries `resolveProtocolTier(programId)`
 * and renders the matching friction level — Verified (low), Unverified
 * (medium), Non-constrainable (high). This is a FRICTION gradient, not a
 * permission gradient: all three tiers allow agent delegation.
 *
 * ## Why a factory + caller-injected async check
 *
 * The constraint parser lives in `@sigil-trade/constraints` — a PRIVATE
 * GitHub Packages package. `@usesigil/kit` publishes to public npm and
 * therefore CANNOT depend on the private package (installs break without
 * GH-Packages auth). So the async "is this programId constrainable?"
 * check is **caller-injected**:
 *
 *   - Dashboard API route: wires the `@sigil-trade/constraints` IDL fetch
 *     + `parseIdlDirect` pipeline as the callback.
 *   - MCP server: same wiring, server-side.
 *   - Emergency CLI: same wiring.
 *   - Mobile (React Native): registry-only fallback; never fetches IDLs.
 *
 * Consumers import `resolveProtocolTier` from the kit, pass their own
 * `checkConstrainability` implementation, get tier back. Single tier API,
 * many IDL-fetch backends.
 *
 * ## Why not inline the parser here
 *
 * Three reasons:
 *
 *   1. **Firewall invariant.** kit must never import from `@sigil-trade/constraints`.
 *   2. **Runtime separation.** The IDL fetcher uses `node:zlib` — Node-only.
 *      Bundling it in the kit would break browser / React Native consumers.
 *   3. **Caller choice.** A mobile app may skip the fetch entirely and use
 *      registry-only classification; the MCP server may use a caching HTTP
 *      proxy; the dashboard uses the raw constraints package. All valid
 *      backends for the same abstract "can we constrain this?" question.
 *
 * @see FRONTEND-BACKEND-CONTRACT.md §5c — "Three-tier trust model"
 * @see FRONTEND-BACKEND-CONTRACT.md §5a C6 — commitment text
 */

import { lookupProtocolAnnotation } from "./protocol-registry/index.js";

/**
 * The three TRUST tiers the FE surfaces to users (FE↔BE contract §5c).
 * This is a UX friction signal — all three tiers ALLOW the agent to
 * trade; the difference is the on-chain constraint enforcement layer
 * and the authorization UX.
 *
 * Named `ProtocolTrustTier` (NOT `ProtocolTier`) to avoid collision with
 * the pre-existing `ProtocolTier` enum at `./protocol-resolver.ts` which
 * serves a different purpose (KNOWN / DEFAULT / NOT_ALLOWED — allow-list
 * enforcement, not trust classification). The two coexist.
 */
export type ProtocolTrustTier = "verified" | "unverified" | "non-constrainable";

/**
 * Reason codes surfaced when a protocol is NOT constrainable. Stable
 * string keys — FE may match on these for targeted messaging, but the
 * authoritative display path is `detail` (human-safe).
 */
export type NonConstrainableReason =
  | "missing_idl"
  | "binary_only"
  | "dynamic_layout"
  | "parser_error";

/**
 * Which source the IDL came from when the constraint parser succeeded.
 * Stable string keys for telemetry / debug panels.
 */
export type IdlSource =
  | "registry"
  | "on_chain_metadata"
  | "solanafm"
  | "helius";

/**
 * Result of the async constrainability check. Discriminated union on
 * `constrainable` — compile-time enforces the "reason iff false /
 * idlSource iff true" invariant. TypeScript will reject invalid
 * combinations like `{ constrainable: true, reason: "missing_idl" }`
 * at construction time; before this was a union the invariant was
 * prose-only.
 *
 * Shape mirrors what the dashboard's `/api/resolve-protocol` route
 * returns today; kit codifies the interface so mobile, MCP, and CLI
 * consumers build against the same contract.
 */
export type ConstrainabilityResult =
  | {
      /** Parser produced a usable `ParsedInstruction[]`. */
      readonly constrainable: true;
      /** Where the IDL was fetched from. Required when constrainable. */
      readonly idlSource: IdlSource;
      /** Optional human-safe context line, safe to render in a toast. */
      readonly detail?: string;
    }
  | {
      /** Parser failed — programId is Non-constrainable in the 3-tier model. */
      readonly constrainable: false;
      /** Why the parser couldn't constrain. Required when not constrainable. */
      readonly reason: NonConstrainableReason;
      /** Optional human-safe context line, safe to render in a toast. */
      readonly detail?: string;
    };

/**
 * The signature every caller MUST provide for the async path. Must be
 * async — the kit calls it with `await` and propagates any thrown error
 * WITHOUT silently catching.
 *
 * Contract for implementers:
 *  - Resolve to a `ConstrainabilityResult`; do NOT reject on "this
 *    protocol is non-constrainable" — that's a successful result with
 *    `constrainable: false`.
 *  - REJECT for transport / network / unexpected errors. Those propagate
 *    to the caller of `resolveProtocolTier()`.
 */
export type CheckConstrainabilityFn = (
  programId: string,
) => Promise<ConstrainabilityResult>;

/**
 * Resolve a programId to its Sigil trust tier.
 *
 * ## Algorithm
 *
 *  1. **Verified short-circuit (sync).** If `VERIFIED_PROGRAMS.has(programId)`
 *     (via `lookupProtocolAnnotation()`), return `"verified"` WITHOUT
 *     calling `checkConstrainability`. Saves the RPC round-trip for every
 *     known-good protocol.
 *  2. **Unverified vs non-constrainable (async).** For unknown programIds,
 *     call `checkConstrainability(programId)`. If `result.constrainable`,
 *     return `"unverified"`. Otherwise return `"non-constrainable"`.
 *
 * ## Error handling
 *
 * If `checkConstrainability` throws/rejects, the rejection propagates to
 * the caller — **NO silent catch**. This matches §7 of the FE↔BE contract
 * (every SDK async method rejects with DxError or subclass; kit never
 * swallows errors).
 *
 * Design note: the sync path (verified lookup) runs BEFORE the async call
 * so a transient RPC failure doesn't block classifying a known-verified
 * programId. This matters for MCP servers operating in degraded-network
 * conditions — Jupiter, Flash Trade, etc. still classify correctly.
 *
 * @param programId Base58 program address.
 * @param checkConstrainability Caller-provided async probe; see
 *   {@link CheckConstrainabilityFn} for the contract.
 *
 * @example Wire the `@sigil-trade/constraints` parser as the backend:
 * ```ts
 * import { resolveProtocolTier } from "@usesigil/kit";
 * import { fetchIdl } from "@sigil-trade/constraints/idl/fetch";
 * import { parseIdlDirect } from "@sigil-trade/constraints";
 *
 * const tier = await resolveProtocolTier(programId, async (id) => {
 *   try {
 *     const idl = await fetchIdl(rpcUrl, id);
 *     parseIdlDirect(idl, id);
 *     return { constrainable: true, idlSource: idl.source };
 *   } catch (e) {
 *     return {
 *       constrainable: false,
 *       reason: classifyParserError(e),
 *       detail: e.message,
 *     };
 *   }
 * });
 * ```
 */
export async function resolveProtocolTier(
  programId: string,
  checkConstrainability: CheckConstrainabilityFn,
): Promise<ProtocolTrustTier> {
  // Sync verified short-circuit.
  if (lookupProtocolAnnotation(programId) !== null) {
    return "verified";
  }

  // Async fallthrough — caller's check is the single source of truth for
  // the unverified/non-constrainable split. Any throw propagates.
  const result = await checkConstrainability(programId);
  return result.constrainable ? "unverified" : "non-constrainable";
}
