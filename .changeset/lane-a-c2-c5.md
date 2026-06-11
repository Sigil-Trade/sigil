---
"@usesigil/kit": minor
---

Lane A — FE↔BE contract v2.2 commitments C2 + C5.

> NOTE 2026-05-20 (Phase 9 Batch A): The C6 (Protocol registry + tier
> resolver primitives) portion of this changeset has been removed.
> `PROTOCOL_ANNOTATIONS`, `VERIFIED_PROGRAMS`, `lookupProtocolAnnotation`,
> `resolveProtocolTier`, and the associated trust-tier types
> (`ProtocolAnnotation`, `ProtocolTrustTier`, `ConstrainabilityResult`,
> `CheckConstrainabilityFn`, `NonConstrainableReason`, `IdlSource`) were
> deleted per the L-1 generic constitution as part of the Phase 9 SDK
> redesign. A separate Phase 9 changeset will narrate the removal.

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

- **`engines.node`** bumped from `>=18.0.0` to `>=20.10.0`. Node 18 is
  EOL upstream (April 2025) and several modern Solana ecosystem deps
  (codama, @solana/kit consumers) require Node 20+.
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

57 new tests in `sdk/kit/tests/`:
- `dashboard/errors-categorize.test.ts` (32) — DxError range boundaries
- `agent-bootstrap.test.ts` (25) — template determinism + substitution +
  injection resistance + input validation

(Originally the C6 protocol-registry + protocol-tier suites added another
22 tests; those were removed in Phase 9 Batch A along with the modules.)

Counts manifest + CI updated.
