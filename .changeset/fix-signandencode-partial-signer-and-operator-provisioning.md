---
"@usesigil/kit": patch
---

Fix transaction signing for partial signers, and enable operator-grant test provisioning:

- `signAndEncode` now correctly signs a compiled transaction with a
  `TransactionPartialSigner` (e.g. a `@solana/kit` KeyPairSigner). It previously
  assumed the signer returned a signed transaction, but a partial signer returns
  a `SignatureDictionary` (a signature map with no `messageBytes`), so
  `getBase64EncodedWireTransaction` threw `TypeError: Cannot read properties of
undefined (reading 'length')` — breaking `executeTransaction` and any
  programmatic `seal()` / `createVault` caller that passes a bare keypair. It now
  delegates to `signTransactionWithSigners`, the canonical Kit primitive that
  handles both partial and modifying signers and asserts full-signedness. Error
  codes (`SIGNER_INVALID` / `SIGNATURE_INVALID`) are preserved.
- `provisionVault` (testing helper) now seats OPERATOR-capability agents through
  the on-chain queue → timelock → apply path. V2 rejects an instant OPERATOR
  grant on a single-key vault with `ErrOperatorGrantRequiresTimelock` (6107), so
  the helper queues the grant, waits out the on-chain delay against the cluster
  clock, then applies it (observer/disabled grants stay instant). It also
  tolerates transient public-devnet RPC 429s on its reads (test-only retry).
