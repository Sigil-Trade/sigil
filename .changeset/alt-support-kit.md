---
"@phalnx/kit": minor
---

Add Address Lookup Table (ALT) support for transaction size compression.

- New `AltCache` class with TTL-based caching and graceful RPC failure degradation
- Network-aware ALT config (`getPhalnxAltAddress`, placeholder addresses)
- `compressTransactionMessageUsingAddressLookupTables` integration in composer
- `measureTransactionSize()` non-throwing size check helper
- ALT collection, merging, and resolution in IntentEngine + TransactionExecutor
- Shield `extractInstructionsFromCompiled` resolves ALT-compressed accounts via AltCache
- Fix error code collision: SIZE_OVERFLOW remapped from 7005 to 7033 (TX_SIZE_OVERFLOW)
- ALT-aware transaction size fallback with context (altsApplied flag)
