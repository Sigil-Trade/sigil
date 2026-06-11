---
"@usesigil/kit": minor
---

Phase 9 SDK redesign — bring the SDK fully in sync with the on-chain
layer (V2 Phases 1-8), delete the tier classifier, ship the Phase 8
ownership/freeze/observe-only helpers, and stage the canonical-encoder
shared utility that AL3/AL4/AL2 envelope intent-binding will consume
in 0.16.1.

See `CHANGELOG.md` for the full surface diff and `MIGRATION.md` for
breaking-change recipes (notably the upcoming
`requireMainnetConfirmation` default flip in v1.0).
