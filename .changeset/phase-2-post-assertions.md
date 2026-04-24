---
"@usesigil/kit": minor
---

Add post-execution assertion mutation surface (Phase 2 phantom cleanup).

New public APIs on `@usesigil/kit`:

- **`createPostAssertions(rpc, vault, owner, network, entries, opts)`** —
  writes a `PostExecutionAssertions` PDA with 1..=4 entries. Validates
  client-side before the RPC round-trip; invalid input throws
  `PostAssertionValidationError` with typed `validationCode` + `entryIndex`
  so FE callers can pinpoint the bad entry.
- **`closePostAssertions(rpc, vault, owner, network, opts)`** — closes the
  PDA and refunds rent. After close, `has_post_assertions` flips 0 on
  PolicyConfig and `finalize_session` skips the post-assertion scan.
- **`validatePostAssertionEntries(entries)`** — pure client-side validator
  mirroring on-chain `validate_entries()`. Exported from
  `@usesigil/kit/dashboard`.
- **`PostAssertionValidationError`** — structurally DxError-compatible
  (`code: number = 7008`, `message`, `recovery: string[]`) plus typed
  `validationCode` + `entryIndex`. The mutation wrappers do NOT wrap via
  `toDxError` — FE receives typed fields intact.

New `@usesigil/kit/post-assertions` subpath:

- **`leverageCapLteBps({ ... })`** — generic CrossFieldLte builder. Enforces
  `field_A × 10000 ≤ maxBps × field_B` on-chain (u128 safe math, no division).
- **`JupiterPerpsPostAssertionUnsupportedError`** — thrown at authoring time
  when the target account is owned by Jupiter Perpetuals. Jupiter Perps uses
  a 2-tx keeper-fulfillment model that silently bypasses post-execution
  assertions. Jupiter Perps remains fully supported via pre-execution
  `InstructionConstraints` (via `@sigil-trade/constraints`).
- **`flashTradeLeverageCap({ positionAccount, maxLeverage })`** —
  one-call convenience for Flash Trade leverage caps. Offsets pinned to the
  `flash-sdk@^15.14.1` Perpetuals IDL with a drift-check unit test that
  fails on any flash-sdk bump that shifts `size_usd` or `collateral_usd`.

No breaking changes. Existing mutation + authoring surfaces unchanged.
