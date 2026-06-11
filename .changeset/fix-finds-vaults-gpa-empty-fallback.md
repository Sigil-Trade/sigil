---
"@usesigil/kit": patch
---

fix(kit): make `findVaultsByOwner` resilient when an RPC restricts `getProgramAccounts`

A devnet / public RPC that excludes a high-account-count program from its
secondary index can silently return `[]` from `getProgramAccounts` (Strategy
A) instead of erroring. Previously `findVaultsByOwner` returned that `[]`
verbatim, so `discoverVaults` reported "no vaults" for an owner that actually
has them — a silent under-reporting bug that surfaced as a flaky devnet CI
failure (`dashboard-integration › finds vaults` got length 0 despite ~30
vaults existing for the wallet at ids ≥ 1,000,000).

`findVaultsByOwner` now runs the Strategy B PDA-probing safety-net whenever
Strategy A yields **zero** verified vaults (not only when it throws a
gpa-unsupported error). Probing is PDA-authoritative — every returned address
is re-derived client-side from `(owner, vaultId)`, so it can only ADD real
low-id vaults the restricted gPA hid; it never fabricates a vault and returns
`[]` for a genuinely vault-less owner. Rate-limit (429) and network errors
still propagate unchanged.

Also adds an optional `vaultId` to the `provisionVault` devnet test helper so
callers can provision a vault at a deterministic id (used by the
dashboard-integration test to pin a low-id vault that PDA probing reliably
discovers regardless of the RPC's gPA support).
