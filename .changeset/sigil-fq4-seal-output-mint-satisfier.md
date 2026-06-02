---
"@usesigil/kit": patch
---

fix(kit): seal() resolves vault-owned Token-2022 output mints (F-Q4 honest path)

`seal()` now auto-resolves the mints of vault-owned Token-2022 token accounts the
sandwiched DeFi instruction writes and feeds them into `validate_and_authorize`'s
`remaining_accounts`. Previously a legitimate swap delivering a Token-2022 token
into a pre-existing vault ATA reverted on-chain with
`ErrToken2022OutputMintUnresolvable` (6106) because the on-chain F-Q4 gate could
not resolve the mint to vet its extensions. The honest path now succeeds while the
on-chain gate remains the sole, non-omittable enforcer (a PermanentDelegate /
TransferHook / ConfidentialTransfer mint is still rejected on-chain).

- New exported pure helper `resolveT22OutputMintMetas()` mirrors the on-chain
  demand exactly (Token-2022-owned + account length >= 72 + token-account
  authority == vault) and appends each distinct mint as a READONLY meta to
  `validate` only (`finalize_session` does not run the gate).
- A batched `getMultipleAccounts` fetch runs only when the Token-2022 program
  appears in the bundle — classic-SPL swaps are unaffected (no extra round-trip).
  The fetch fails closed with a contextual error on RPC failure.
- Completes the SDK propagation of error 6106 (the hand-maintained
  `ON_CHAIN_ERROR_MAP`, `SIGIL_ON_CHAIN_ERROR_MAX`, and the Codama
  `generated/errors/sigil.ts` now all carry `ErrToken2022OutputMintUnresolvable`).
