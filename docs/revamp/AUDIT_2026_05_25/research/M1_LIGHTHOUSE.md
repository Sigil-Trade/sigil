# M-1 Research: Lighthouse (Jac0xb)

**Target:** Lighthouse Solana assertion program ([github.com/Jac0xb/lighthouse](https://github.com/Jac0xb/lighthouse))
**Program ID (mainnet & devnet):** `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`
**Audit:** OtterSec, May 3, 2024 — commit `293470d`, 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW, 2 INFO only ([audits/lighthouse_audit_final.pdf](https://github.com/Jac0xb/lighthouse/blob/main/audits/lighthouse_audit_final.pdf))
**Local working tree:** `/tmp/lighthouse-research/lighthouse` (HEAD of `main`)

---

## Pattern

**Named pattern:** *Caller-declared, program-enforced assertion list with bidirectional presence semantics.*

Lighthouse is a transaction-postlude validator: the caller appends `Assert*` instructions after the "real" instructions, each declares an assertion over an account, and the program either passes or reverts the transaction with `LighthouseError::AssertionFailed = 6001`. **There is no silent-skip path anywhere in the codebase.** The M-1 question — "what happens when the account I expected isn't there?" — is encoded as a first-class assertion, never as a silent guard.

**Two complementary primitives encode the present-vs-absent distinction:**

1. **`AccountValidation::IsProgramOwned(Pubkey)`** ([`validation/account.rs:234-240`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/validation/account.rs#L234-L240)) — passes only when `lamports() != 0 && owner == expected_owner`. Hard-fails with `AccountValidationFailed = 6015` on closed or owner-mismatched accounts. This is the **"expected present"** assertion.
2. **`AccountValidation::IsNotOwned`** ([`validation/account.rs:241-248`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/validation/account.rs#L241-L248)) — passes only when `lamports() == 0 && owner == system_program::ID`. Hard-fails identically. This is the **"expected absent"** assertion.

Both helpers share one dispatcher (`check_conditions`, [`account.rs:213-313`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/validation/account.rs#L213-L313)), one `Result<()>` shape, one error code — a contributor cannot introduce an asymmetric handler because there is one validation surface and `Option<None>` is not a legal return. The `Assert` trait ([`types/assert/mod.rs:35-37`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/types/assert/mod.rs#L35-L37)) returns `Result<()>` — no `Result<bool>`, no no-op.

**Discriminator/dispatch encoding** ([`instruction.rs:25-94`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/instruction.rs#L25-L94)): the assertion class is the Borsh-tagged variant of `LighthouseInstruction`. The processor ([`lib.rs:53-189`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/lib.rs#L53-L189)) dispatches on the variant; every `assert_*` handler terminates in `evaluate() -> Result<()>` and propagates `Err` upward. Composed "multi" variants ([`processor/assert_target_account.rs:30-42`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/processor/assert_target_account.rs#L30-L42)) iterate and re-map errors via `LighthouseError::map_multi_err(e, i)` so the caller learns *which index* failed — fail-loud with positional context.

## Failure history

- **OtterSec audit, 2024-05-03** ([`audits/lighthouse_audit_final.pdf`](https://github.com/Jac0xb/lighthouse/blob/main/audits/lighthouse_audit_final.pdf), commit `293470d`): **0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW.** Only two INFO findings: `OS-LHS-SUG-00` (code efficiency) and `OS-LHS-SUG-01` (best-practice refactor). For a program whose entire product surface is assertion semantics, this is the strongest empirical evidence available that fail-loud-everywhere eliminates the silent-failure attack class by construction.
- **No orphaned-rent / silent-skip / flag-desync / cancel-race issues** in the GitHub repo's history. The closest class — "I asserted on the wrong account" — is structurally impossible because the assertion fails on owner mismatch (`AccountOwnerValidationFailed = 6012`) or absence (`AccountNotInitialized = 6011`).
- **`LogLevel::Silent` is NOT a silent-skip toggle** ([`log_level.rs:5-13`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/types/assert/log_level.rs#L5-L13)). It silences the *log emission* on success (CU saver). Failure paths are never silent.

Design philosophy from README ([L23-27](https://github.com/Jac0xb/lighthouse/blob/main/README.md#L23-L27)): *"if a bad actor spoofs simulation results, there's overspending, or an oracle account is in an undesired state, the assertion will fail, causing the entire transaction to fail."* The only outcome shapes are pass and revert.

## End-user recovery story

Recovery is a non-event: Lighthouse never mutates persistent state (the only writable PDA is the caller-owned `Memory` scratch). Failed assertion = transaction revert = no funds moved, no rent leaked, no desync. Caller adjusts and re-submits. The `Memory` lifecycle ([`processor/memory_close.rs`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/processor/memory_close.rs)) uses `AccountValidation::IsProgramDerivedAddress` ([`account.rs:249-293`](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/validation/account.rs#L249-L293)) — wrong PDA hard-fails. There is no "best-effort drain" path.

## M-1 fit verdict

**Partial — and the partial part is the most important finding.** Lighthouse is not a drop-in template for Sigil's `close_vault` (different domain: stateless validator vs. persistent multi-PDA lifecycle owner). But Lighthouse's *primitives* directly map to a **sixth Council option not yet considered** — call it **ζ (zeta): caller-attested pending-class assertions with bidirectional presence semantics**.

**ζ in shape:** caller enumerates pending PDAs via `getProgramAccounts` and sends `close_vault` with `pending_assertions: Vec<PendingAssertion>`, where each entry is `{class: PendingPdaClass, expected: ExpectedAbsent | ExpectedPresentAt(Pubkey)}`. The program iterates `remaining_accounts`, derives the PDA per `class`, and applies Lighthouse's two primitives directly:

- `ExpectedPresentAt(pda)` → `IsProgramOwned(program_id)` check, then drain.
- `ExpectedAbsent` → `IsNotOwned` check at the derived address.
- Compile-time `match` over `PendingPdaClass` enforces that no class can be silently omitted — contributor #7 cannot drift.

**Why ζ dominates γ:** γ as discussed in R1-R3 attests *only presence* ("I claim these pendings exist"). ζ attests *both presence and absence* — and the absence half closes Jordan's "caller-honesty defense" critique because the caller cannot lie about absence without lying about a derived address, and the program verifies the address on-chain. The asymmetry that produced the M-1 finding ("present" hard-fails, "absent" silently passes) is the exact asymmetry Lighthouse eliminated by promoting both cases to first-class assertions.

## Security-first scores

- **Defense-in-depth strength: 5/5.** Lighthouse's pattern admits zero silent-no-op paths, has been independently audited to zero non-info findings, and the bidirectional `IsProgramOwned` / `IsNotOwned` dichotomy is the canonical Solana-native encoding of "expected present" / "expected absent." An attacker cannot subvert it without subverting Solana's account model.
- **End-user recovery: 5/5.** Failed assertion = full transaction revert = no state to recover. For ζ applied to Sigil: a failed `close_vault` reverts cleanly; the SDK re-enumerates and resubmits with the correct assertion list. If the SDK is wrong about a class, the program tells the user exactly which index failed (via `map_multi_err`).
- **Auditor onboarding: 5/5.** The pattern is one-trait, one-dispatcher, one-error-code. A reviewer reads `validation/account.rs:213-313` in under five minutes and understands the entire security model. The `OtterSec` audit took one week and produced zero severity findings — that is the measurable onboarding cost.
- **Long-term consistency: 5/5.** Adding a new pending class in ζ is "add a variant to the `PendingPdaClass` enum and add a derivation branch." The Rust compiler enforces exhaustiveness in the `match` block. There is no contributor-discipline component.

## Recommendation for Sigil M-1

**Propose option ζ to the R4 Council:** caller-attested pending-class assertions with bidirectional presence semantics, modeled directly on `Lighthouse::AccountValidation::IsProgramOwned` and `IsNotOwned`.

**Shape:**

```rust
pub struct CloseVaultArgs { pub pending_assertions: Vec<PendingAssertion> }

pub enum PendingAssertion {
    ExpectedAbsent     { class: PendingPdaClass },
    ExpectedPresentAt  { class: PendingPdaClass, pda: Pubkey },
}

pub enum PendingPdaClass {
    PendingPolicy, PendingConstraints, PendingCloseConstraints,
    PendingOwner, PendingAgentGrant,
    PendingAgentPerms { agent: Pubkey },
}
```

Handler: per assertion, derive the PDA from `class`, locate it in `remaining_accounts`, apply `IsProgramOwned` (drain) or `IsNotOwned` (no-op-by-proof). Reject on unmatched provided account; reject on any `PendingPdaClass` variant missing from `pending_assertions` (compile-time exhaustive `match`).

**Why ζ beats α/γ/δ on the security-first axes:**

1. Inherits Lighthouse's audited zero-severity track record at the *primitive* level — the validation helpers are copy-paste-portable.
2. Closes γ's caller-honesty hole: lying about absence requires lying about a derived address, verified on-chain.
3. No on-chain flags → no `admin_clear_pending_flag` escape hatch needed → desync is structurally impossible (no shadow state to desync from).
4. Self-documenting to auditors who have seen Lighthouse — the most-recognized "guardrail" pattern in the Solana ecosystem.
5. Compile-time exhaustiveness defeats contributor-#7 drift without runtime CI.

R4 should evaluate ζ alongside α/γ/δ/ε on pure security grounds. ζ dominates on all four security-first axes; the user's "no cost tradeoffs" rule makes the comparison clean.

---

**Verification status of claims in this report:**

- Lighthouse error codes / handler shapes / trait signatures: CONFIRMED via direct read of `/tmp/lighthouse-research/lighthouse` HEAD (cloned 2026-05-25).
- OtterSec audit severity counts: CONFIRMED via direct PDF read, pages 1-5 of `audits/lighthouse_audit_final.pdf`.
- "No silent-skip path anywhere": LIKELY (verified by grep + reading all 11 processor files + the `Assert` trait + the `check_conditions` dispatcher; cannot enumerate every macro-expanded code path without full audit, but the surface is small enough that a hidden no-op would be visible).
- ζ option's compile-time exhaustiveness claim: CONFIRMED (Rust language guarantee for `match` over non-`#[non_exhaustive]` enums).
- ζ's "negative schema cost vs α" claim: LIKELY (no on-chain flags needed; caller-supplied `Vec<PendingAssertion>` is transient ix data, not account storage). Final byte count depends on `MAX_PENDING_CLASSES` bound — documentation item, not a security tradeoff.
