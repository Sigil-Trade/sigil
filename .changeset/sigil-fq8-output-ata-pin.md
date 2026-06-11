---
"@usesigil/kit": patch
---

fix(kit): regenerate the SessionAuthority codec for the F-Q8 output-stablecoin-ATA pin

The on-chain `SessionAuthority` account gained an appended
`output_stablecoin_account: Pubkey` field (F-Q8: `finalize_session` now pins
the measured stablecoin ATA by pubkey, blocking substitution of a different
vault-owned stablecoin ATA on the non-stablecoin-input spend path). SIZE grew
515 → 547.

Regenerated `sdk/kit/src/generated/accounts/sessionAuthority.ts` via Codama so
the kit codec matches the program:

- `getSessionAuthoritySize()` now returns `547` (was `515`).
- The decoder/encoder include the new `outputStablecoinAccount: Address` field.

This fixes a latent session-discovery break: `findSessionsByVault()`
(`state-resolver.ts`) filters `getProgramAccounts` on `{ dataSize:
getSessionAuthoritySize() }`. Against the upgraded program (547-byte sessions),
the stale 515-byte filter would have matched zero accounts, silently returning
no sessions. Additive, non-breaking for consumers (new field on decoded
SessionAuthority objects).
