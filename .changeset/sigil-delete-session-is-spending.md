---
"@usesigil/kit": minor
---

refactor(sigil): delete `SessionAuthority.is_spending` field (Option A V2)

The `is_spending: bool` field on `SessionAuthority` was redundant —
it was always set to `authorized_amount > 0` at validate time. All
consumers now derive directly from `authorized_amount`. The
`ActionAuthorized` and `SessionFinalized` events lose the same field;
off-chain consumers should check `amount > 0` instead.

This is a breaking event/account change. Shipped under the V2 program
ID at Stage 6 (no in-place upgrade of devnet `7FtAXUcr...`).

The SDK `isSpendingAction()` and `ACTION_TYPE_NAMES_BY_INDEX` helpers
were also deleted — they were marked zombie code for legacy indexer
compatibility, and Option A removes zombie code.
