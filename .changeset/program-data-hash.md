---
"@usesigil/kit": minor
---

Add `getProgramDataHash(rpc, programId)` — computes the SHA-256 of a deployed program's executable ELF from its BPFLoaderUpgradeable `ProgramData` account. This is the value an owner pins into `PolicyConfig.protocol_hashes` for the upcoming verified-build gate (Item 3), so authorization can reject a target protocol whose on-chain build no longer matches the audited one. Also exports `getProgramDataAddress`, `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`, and `PROGRAM_DATA_HEADER_LEN`. Mirrors the on-chain hash offset (the 45-byte `ProgramData` header) byte-for-byte so a hash pinned via this helper matches the on-chain recomputation.
