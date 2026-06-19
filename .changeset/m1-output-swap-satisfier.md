---
"@usesigil/kit": minor
---

seal(): `outputSwapMint` satisfier for the M1 output-ownership gate (on-chain error 6112)

The on-chain M1 closure makes `finalize_session` MANDATE that a stablecoin-input acquiring swap land its output in a vault-owned account that strictly increases. `seal()` now accepts an `outputSwapMint` (the mint being acquired): it derives and pins the vault's canonical ATA on `validate_and_authorize` + `finalize_session` and rewrites the DeFi swap's output destination to that vault account.

**Breaking (behavioral):** a stablecoin-input acquiring swap that omits `outputSwapMint` now throws `SIGIL_ERROR__SDK__INVALID_PARAMS` (fail-loud) — Sigil never infers what the agent is buying. Declare the acquired mint to migrate. Non-stablecoin-input swaps and transfers are unaffected. Also adds the 6112 error mapping and bumps the recognized on-chain error range to 6112.
