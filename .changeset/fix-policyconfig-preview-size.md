---
"@usesigil/kit": patch
---

Fix `previewCreateVault` understating rent: `POLICY_CONFIG_SIZE` was 1329 but the on-chain `PolicyConfig::SIZE` is 1649 (the verified-build `protocol_hashes` array added 320 bytes). The cost/rent shown to a human before signing the vault-creation tx was understated by ~0.0022 SOL. The size regression test is now a cross-language guard that parses the Rust `assert!(<Type>::SIZE == N)` pins for all four preview PDAs, so it can't silently drift again.
