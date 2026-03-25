# Experimental Tests

Tests for upcoming Solana features that are **not yet on mainnet**. Excluded from the default test run.

## SIMD-0296: Larger Transactions (4,096 bytes)

- **Status:** Accepted, targeting Agave 4.1 (~Q3 2026)
- **Surfpool testnet:** https://simd-0296.surfnet.dev/
- **Impact:** Eliminates the 1,232-byte transaction size constraint. ALT compression becomes optional.

### Running

```bash
pnpm --filter @phalnx/kit test:experimental
```

### Removal Timeline

Remove this directory when SIMD-0296 is active on mainnet and the SDK's `MAX_TX_SIZE` constant is updated to 4,096. At that point, the SIMD-0296 tests should be migrated to the main test suite as standard transaction size validation.
