---
"@usesigil/kit": patch
---

Fix devnet test-helper + RPC error reporting against the V2 program:

- `sendAndConfirmTransaction` no longer masks on-chain errors that carry BigInt
  fields. A failed transaction whose `status.err` contained a u64 (e.g. an
  instruction index) previously threw `TypeError: Do not know how to serialize a
  BigInt` from the error path itself, hiding the real `Custom` program code.
- `sendAndConfirmTransaction` / `sendKitTransaction` accept a `skipPreflight`
  option. Slot-bound transactions (e.g. `initialize_vault`'s PEN-CROSS-2 preview
  digest, which binds the execution slot) cannot be preflight-simulated: the sim
  runs at the current slot and rejects the future-slot digest with
  `PolicyPreviewMismatch` before the tx can land.
- `provisionVault` (testing helper) now works against the live program: it
  retries the slot-bind (`PolicyPreviewMismatch` 6071) with `skipPreflight`, and
  accepts a `protocols` allowlist so callers can create a non-inert ACTIVE vault
  that passes the F-11 init guard (6073) and the M-9 reactivate guard
  (`ActiveVaultRequiresAllowlist`).
