# M-1 Research: SPL Token-2022 (close-with-pending-state)

**Repo:** `solana-program/token-2022` (split out of `solana-labs/solana-program-library` in 2025). Canonical Solana stdlib for extension-based state machines.

## Pattern

**TLV (Type-Length-Value) discriminator state machine with per-extension `closable()` predicate gating the close path.** Each extension is a `#[repr(C)] Pod` struct implementing `Extension { const TYPE: ExtensionType }` where `ExtensionType` is `#[repr(u16)]` (29 live variants — `interface/src/extension/mod.rs:584-627`). Extensions are appended to account data after the base struct in a TLV stream `[u16 type][u16 length][value]…[Uninitialized sentinel]`. The walker (`get_extension_indices`, `interface/src/extension/mod.rs:321-360`) returns `Err(TokenError::ExtensionNotFound)` on hitting the `Uninitialized` marker — and the close handler swallows that via `if let Ok(...)`. TLV `Length` is a checked `u16` Pod (`mod.rs:113-124`); `alloc` is append-only and rejects overwrite unless explicit (`mod.rs:431-486`), so half-written rows are impossible.

**What the close path enforces** — `program/src/processor.rs:1124-1195`:

```rust
if let Ok(source_account) = PodStateWithExtensions::<PodAccount>::unpack(&data) {
    if !source_account.base.is_native() && u64::from(source_account.base.amount) != 0 {
        return Err(TokenError::NonNativeHasBalance.into());
    }
    // ... CpiGuard + authority checks ...
    if let Ok(s) = source_account.get_extension::<ConfidentialTransferAccount>()    { s.closable()? }
    if let Ok(s) = source_account.get_extension::<ConfidentialTransferFeeAmount>() { s.closable()? }
    if let Ok(s) = source_account.get_extension::<TransferFeeAmount>()              { s.closable()? }
} else if let Ok(mint) = PodStateWithExtensions::<PodMint>::unpack(&data) {
    let ext = mint.get_extension::<MintCloseAuthority>()?;   // HARD-FAIL — no `if let`
    // ... validate close_authority signer ...
    if u64::from(mint.base.supply) != 0 { return Err(TokenError::MintHasSupply.into()); }
    if let Ok(c) = mint.get_extension::<ConfidentialMintBurn>() { c.closable()? }
}
```

Per-class predicates: `TransferFeeAmount::closable()` → `AccountHasWithheldTransferFees` if `withheld_amount != 0` (`interface/src/extension/transfer_fee/mod.rs:153-159`); `ConfidentialTransferAccount::closable()` → `ConfidentialTransferAccountHasBalance` unless `pending_balance_lo/hi` and `available_balance` are all `EncryptedBalance::zeroed()`. `PermanentDelegate` is NOT consulted by close — it authorizes Transfer/Burn elsewhere; it cannot bypass the zero-balance precondition. `CpiGuard` is defensive (block CPI close when destination ≠ owner), not state-bearing.

## Failure history

`ConfidentialTransferFeeAmount` was added to the close handler as a retrofit — the original close handler only consulted `TransferFeeAmount`. The canonical "we forgot one extension class" miss. No public orphaned-rent reports because TLV append-only + `Uninitialized`-sentinel walker structurally prevents partial writes. Downstream wrappers (Drift, Marginfi, Kamino) accept the upstream close path as a trust boundary.

## End-user recovery story

Every block-condition has a paired unblock-instruction IN THE SAME PROGRAM: `withheld_amount > 0` → `HarvestWithheldTokensToMint`; encrypted balance > 0 → `EmptyAccount` decrypt-and-zero; mint supply > 0 → burn supply. No admin escape needed — user is never locked out. Hard-fail is atomic.

## M-1 fit verdict

**Partial.** Token-2022's silent-skip-on-missing-extension via `if let Ok(...) = get_extension::<X>()` is structurally identical to Sigil's `if pending_X.lamports() > 0 { drain }`. Both treat absence as no-op. The pattern is sound in Token-2022 because (a) absence semantically means "no constraint" (not "drain me"), (b) every blocking class is enumerated at compile-time in ONE handler, scanned by review. The retrofit miss proves it's still drift-prone — same risk class as M-1.

## Security-first scores

- **Defense-in-depth: 4/5.** Append-only TLV + per-class predicate. Silent-skip means a forgotten new class ships unenforced.
- **End-user recovery: 5/5.** Every block has a paired unblock-instruction.
- **Auditor onboarding: 5/5.** One handler, ~70 lines, all blocking classes explicit.
- **Long-term consistency: 3/5.** No compiler enforcement that new extensions are added to close handler. `ConfidentialTransferFeeAmount` retrofit proves drift class.

## Recommendation for Sigil M-1

Adopt the **compile-time-exhaustiveness branch** of Token-2022's pattern, NOT the silent-skip semantics. Define a `PendingPdaClass` trait (matches Jordan's R3 condition) with `fn drain_or_assert(&self, ctx) -> Result<()>`. `close_vault` iterates `const PENDING_CLASSES: &[&dyn PendingPdaClass]`. A CI test asserts the array's length equals the count of pending-PDA structs in `state/` — greppable contributor check, mirrors Token-2022's `ExtensionType` enum as single source of truth. This gives auditor-onboarding strength (one handler, all classes enumerated) while making absence-vs-presence semantics explicit in the trait rather than hidden in `lamports() > 0` guards. **α aligns Sigil with the canonical stdlib pattern.** Reject γ — Token-2022 emphatically does NOT trust the caller to enumerate extensions; it walks the TLV on-chain every time. Sigil should mirror that on-chain authority rather than delegating to SDK honesty.
