---
"@usesigil/kit": minor
---

Lane A — FE↔BE contract v2.2 commitments C6 + C2 + C5.

### C6 — Protocol registry + tier resolver primitives

New public surface on `@usesigil/kit`:

- `PROTOCOL_ANNOTATIONS: readonly ProtocolAnnotation[]` — 7 hand-curated
  Verified-tier protocol annotations (Jupiter, Flash Trade, Jupiter
  Lend/Earn/Borrow, Drift, Kamino). Migrated byte-identical from the
  dashboard's local registry so the dashboard can swap its import in a
  one-line change.
- `VERIFIED_PROGRAMS: ReadonlySet<string>` — O(1) membership helper
  derived from the annotations at module load.
- `lookupProtocolAnnotation(programId): ProtocolAnnotation | null` —
  sync registry lookup.
- `resolveProtocolTier(programId, checkConstrainability): Promise<ProtocolTrustTier>` —
  composed three-tier resolver. Verified programs short-circuit
  synchronously; unknown programs fall through to a caller-injected
  async probe (returns `"unverified"` when constrainable, otherwise
  `"non-constrainable"`).
- `ProtocolAnnotation`, `ProtocolTrustTier`, `ConstrainabilityResult`
  (discriminated union), `CheckConstrainabilityFn`,
  `NonConstrainableReason`, `IdlSource` types.

Kit does NOT depend on `@sigil-trade/constraints` — the constrainability
check is caller-injected. Dashboard / MCP / mobile / CLI each wire
their own IDL-fetch backend; kit ships the classification logic.

### C2 — DxError.onChainReverted + categorizeDxError

- `DxError` gains a required `onChainReverted: boolean` field. Always
  populated by `toDxError()`; set true when the resolved code falls in
  the Anchor on-chain range [6000, 6074]. FE renders specific
  "vault's rules prevented this" messaging when true, generic error
  otherwise.
- `categorizeDxError(e): DxErrorCategory` — helper mapping code to one
  of four stable strings: `"program" | "user" | "network" | "unknown"`.
  Named `categorizeDxError` (not `categorizeError`) to avoid collision
  with the pre-existing `categorizeError(AgentError): SigilErrorCategory`
  at `src/agent-errors.ts`.
- `isOnChainReverted(code): boolean` — public helper for the specific
  6000-range check.
- `DX_ERROR_CODE_UNMAPPED` now re-exported from `@usesigil/kit/dashboard`.
- `PostAssertionValidationError` + `FlashTradeLeverageOutOfRangeError`
  classes gained `onChainReverted: false` (they're client-side
  validation errors, thrown before any RPC round-trip).

### C5 — composeAgentBootstrap + getHandoffPromptTemplate

- `composeAgentBootstrap(config): AgentBootstrap` — fills the canonical
  handoff-prompt template with vault-specific data. Returns
  `{ agentWallet, vaultPubkey, onboardingPrompt, capabilities }`.
  Deterministic: same input → byte-identical output.
- `getHandoffPromptTemplate(): string` — returns the raw template with
  `${placeholder}` slots. For callers doing their own substitution.
- `capabilityTierToNames(tier): readonly string[]` — maps the 0/1/2
  capability tier to friendly names. Exported from what was previously
  an unexported internal constant in `advanced-analytics.ts`.
- `AgentBootstrap` + `AgentBootstrapConfig` types.

Template is prompt-injection safe — single-pass regex substitution
blocks both `$&`-style back-reference attacks AND `${placeholder}`
nested-value attacks. Validated with adversarial tests.

### Breaking

- **`engines.node`** bumped from `>=18.0.0` to `>=20.10.0`. Required
  because `with { type: "json" }` import attributes (used by the
  protocol-registry) are a SyntaxError on Node < 20.10. Node 18 is
  EOL upstream (April 2025) so this matches the runtime floor anyway.
- **`DxError.onChainReverted`** is a new required field. All internal
  kit callers route through `toDxError()` which sets it; external
  consumers constructing `DxError` literals (none found in audit) must
  add the field. Two sibling classes (`PostAssertionValidationError`,
  `FlashTradeLeverageOutOfRangeError`) updated in this release.
- **`ConstrainabilityResult`** is now a discriminated union on
  `constrainable`. Consumers constructing results must provide
  `idlSource` when `constrainable: true` and `reason` when
  `constrainable: false`. Compile-time enforcement of the iff-invariant
  the prose docstring previously described.

### Test coverage

79 new tests in `sdk/kit/tests/`:
- `protocol-registry.test.ts` (15) — registry structural integrity
- `protocol-tier.test.ts` (7) — tier resolver behavior + error propagation
- `dashboard/errors-categorize.test.ts` (32) — DxError range boundaries
- `agent-bootstrap.test.ts` (25) — template determinism + substitution +
  injection resistance + input validation

Baseline 1590 → 1613 → 1613 (after union narrowing) → 1675 passing.

Counts manifest + CI updated.
