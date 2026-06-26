---
"@usesigil/kit": minor
---

feed surfaces policy-blocked attempts reconstructed from failed-tx logs

`getVaultActivity` now reconstructs a single "blocked" activity item from a
failed transaction whose program logs carry a Sigil policy-block error code.
A Sigil block does `return Err` → the whole tx reverts → no event is emitted,
so the attempt previously never reached the activity feed. The new failed-tx
branch parses the Sigil error code from the runtime `Program <id> failed:` line
(top-level invoke depth only), maps it to its error name via the generated IDL
error map, and recovers agent/protocol/amount by decoding the
`validate_and_authorize` instruction. `buildActivityRows` already renders a
`success:false` item as a `blocked` row. Reconstructed fields are null when they
cannot be verified (the agent is kept only when it is the sole tx signer, to
avoid impersonation); no extra RPC is issued (the already-fetched tx is reused).
