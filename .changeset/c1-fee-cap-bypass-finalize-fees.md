---
"@usesigil/kit": minor
---

fix(C-1): relocate fee collection to finalize (security)

`seal()` now attaches the protocol-treasury and developer fee-destination token
accounts to the `finalize_session` instruction instead of `validate_and_authorize`,
matching the on-chain C-1 fix. Fees are collected at finalize on the MEASURED
spend (inside the spend caps), not upfront on the agent-declared amount. This
closes a tier-1 fee-cap-bypass drain where a compromised agent could declare a
huge amount so the upfront fee (a percentage of the declared amount) drained
≈100% of the vault to the protocol treasury in a single transaction while every
spend cap saw only a dust spend.

Consumer impact: the composed-transaction account layout changed — the two fee
token accounts moved from the validate instruction to the finalize instruction.
Callers using `seal()` need no changes (handled internally). Callers building the
`validate_and_authorize` / `finalize_session` instructions manually via the
generated builders must move `protocolTreasuryTokenAccount` and
`feeDestinationTokenAccount` to the finalize instruction.
