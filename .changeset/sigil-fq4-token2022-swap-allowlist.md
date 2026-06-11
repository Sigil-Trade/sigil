---
"@usesigil/kit": patch
---

fix(kit): add error 6106 (ErrToken2022OutputMintUnresolvable) to the error maps

The on-chain program gained error 6106 for the F-Q4 Token-2022 swap-path
extension gate — a vault-owned Token-2022 output ATA whose mint is absent from
`remaining_accounts` (or is not Token-2022-owned) fails closed so its mint
extensions can be vetted. Regenerated the kit error projections
(`agent-errors.generated.ts`, `names.generated.ts`) so SDK error
decoding/classification recognizes 6106. Additive, non-breaking.

Note: the SDK `seal()` output-mint satisfier (which feeds the vault-owned
Token-2022 output mints into `remaining_accounts` on the honest path) is a
separate follow-on change; the on-chain gate is fail-closed-safe without it.
