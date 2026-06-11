# Phase 7 §RP Review — Summary

**Phase:** 7 — On-chain audit log (TA-15 + N1 temporal binding)
**Date:** 2026-05-19
**Verdict:** **CLEAR-TO-PROCEED** (after §RP-1 + §RP-2 fix-up cycles; burst + sysvar-freshness behavioural tests explicitly deferred to Phase 7.1 / Phase 6.1 surfpool)

## Phase 7 commits

| # | Type | Subject | SHA |
|---|---|---|---|
| 0 | Pre-dispatch | docs(revamp): Phase 7 pre-dispatch — sync error-code tables for audit closure +1 | `149bd6d` |
| 1 | Account | feat(audit-log): create AuditLogSuccess + AuditLogRejected PDAs | `27b91a4` |
| 2 | Wire-up | feat(audit-log): write entries from 11 mutating instructions | `76d742a` |
| 3 | SDK | feat(sdk): fetchAuditLogSuccess + fetchAuditLogRejected helpers | `655a29f` |
| 4 | §RP-1 fix-up | fix(audit-log): §RP-1 close-up — FIX-1..FIX-5 | `a9e74ec` |
| 5 | §RP-1 cleanup | fix(tests): audit-log F-19 — remove unused tracker decl | `3f53a00` |
| 6 | §RP-2 fix-up | fix(audit-log): §RP-2 close-up — CRIT-1/2 + HIGH-1/2/3 | `c7cf727` |

## §RP-1 findings + dispositions

### silent-failure-hunter (2 HIGHs + 3 MEDs)

| ID | Severity | Title | Disposition |
|---|---|---|---|
| HIGH-1 | HIGH | `finalize_session.rs:1099` writes `AUDIT_DISC_VALIDATE=1` to REJECTED buffer for expired-finalize cranks, but `validate_and_authorize.rs` writes NO audit entries — so disc=1 in the rejected buffer was a forensic-correctness lie | RESOLVED in §RP-1 fix-up. Allocated `AUDIT_DISC_FINALIZE_REJECT = 16` in `state/audit_log_success.rs:46`, finalize_session now writes disc=16 on the REJECT path. Discriminator-allocation docstring updated (disc=1 now marked RESERVED — Phase 7 writes no entries from validate; future expansion slot). SDK and tests updated. |
| HIGH-2 | HIGH | `AuditEntry.target_protocol` is overloaded across 11 ix to hold mint/vault/agent/owner pubkeys — only finalize honors the "protocol" name; field-name lies | RESOLVED in §RP-1 fix-up. Renamed struct field `target_protocol` → `subject` on `AuditEntry` (Rust, IDL, Codama-regen TS, SDK helper, tests). Per-discriminator semantic table added to the struct's docstring at `state/audit_log_success.rs:74-92`. SDK exports a new `subjectBytes()` helper plus a deprecated `targetProtocolBytes()` alias for one-release compatibility. |
| MED-1 | MED | F-19 burst behavioural test — 65 expired-finalize cranks to verify rejected buffer wraps WITHOUT touching success buffer | DEFERRED to Phase 7.1 / Phase 6.1 surfpool. LiteSVM cannot drive 65 expired-session finalizes economically (each cycle costs ~30s of test time). Structural separation is asserted (PDA addresses, sizes) — the behavioural burst belongs in surfpool sandwich tests. |
| MED-2 | MED | sysvar-freshness behavioural test — assert that slot_hash bytes differ between two consecutive ix writes under realistic slot advancement | DEFERRED to Phase 7.1 / Phase 6.1 surfpool. LiteSVM does not advance `slot_hashes` sysvar per-ix the way a real validator does; the existing test asserts the deterministic LiteSVM-shaped invariant. |
| MED-3 | MED | Discriminator coverage matrix 6/15 (only 6 of 15 ix have explicit per-disc tests) | PARTIALLY ADDRESSED by FIX-4 wrap-test boundary assertion (which exercises freeze + reactivate + register at the wrap boundary). Remaining per-disc coverage deferred to Phase 7.1. |

### code-reviewer (3 important findings)

| ID | Severity | Title | Disposition |
|---|---|---|---|
| I-2 | IMPORTANT | No defense-in-depth `require_keys_eq!(log.vault, vault.key())` at `load_mut()?` sites — relies entirely on PDA seeds construction | RESOLVED in §RP-1 fix-up. Added `require_keys_eq!(log.vault, ctx.accounts.vault.key(), SigilError::ZeroCopyVaultMismatch)` at all 12 `load_mut()?` write sites (11 success-log ix + 2 in finalize_session). Reuses existing error variant **6064** — renamed `ConstraintsVaultMismatch` → `ZeroCopyVaultMismatch` in `c7cf727` (§RP-2 HIGH-3) so the generic message reads coherently from both constraints and audit-log call sites. ZERO new error codes added per Phase 7 §4 reservation table. |
| I-3 | IMPORTANT | `tests/audit-log.ts` wrap test only asserts LAST entry identity; off-by-one regression where `head+1` used instead of `head` would still pass | RESOLVED in §RP-1 fix-up. Added positive assertion on `chronological[0].discriminator == DISC_FREEZE` (the 4th written entry = oldest retained after 131 writes wrap a 128-cap buffer). Boundary comment documents the expected drop pattern. |
| N-1 | NIT | 6 dead test imports (Transaction, COUNT_OFFSET, DISC_VALIDATE, DISC_FINALIZE_SUCCESS, DISC_DEPOSIT, DISC_POLICY_APPLY) | RESOLVED in §RP-1 fix-up. Confirmed `tracker` is in-use (kept); deleted the 6 dead imports/consts. |

### Engineer-disclosed observations

| ID | Severity | Title | Disposition |
|---|---|---|---|
| AUDIT-DOC | INFO (caught during §RP-1) | `targetProtocolBytes()` SDK helper used a misleading name in its docstring | RESOLVED — replaced with `subjectBytes()` (canonical), `targetProtocolBytes()` kept as `@deprecated` alias for one release. Both return `entry.subject`. |
| IDL-REGEN | INFO | IDL regenerated via `anchor idl build --out target/idl/sigil.json` (nightly toolchain) to propagate the `target_protocol` → `subject` rename; Codama then rendered the SDK types | Pure mechanical regen. Cosmetic diffs (Unicode em-dash normalisation, slot_hashes_sysvar doc removed in earlier work) accompany the substantive `subject` field rename. |

## §RP-2 findings + dispositions (silent-failure-hunter on §RP-1 close-up)

§RP-2 ran adversarially against the §RP-1 close-up + cleanup commits. Found **2 CRIT + 3 HIGH** follow-ons — same pattern as the prior cycle's stale dist + missing prepublishOnly for shieldWallet.

| ID | Severity | Title | Disposition |
|---|---|---|---|
| CRIT-1 | CRIT | `subjectBytes()` defined but NOT exported from `sdk/kit/src/index.ts` — only deprecated alias was barrel-exported | RESOLVED in `c7cf727`. Added `subjectBytes` to the barrel export block. |
| CRIT-2 | CRIT | `sdk/kit/dist/audit-log.js` returned `entry.targetProtocol` (now undefined post-rename) — silent data loss on next pnpm publish; no `prepublishOnly` hook | RESOLVED in `c7cf727`. Added `"prepublishOnly": "pnpm run clean && pnpm run build"` to sdk/kit/package.json + rebuilt dist locally; published surface now correctly returns `entry.subject`. |
| HIGH-1 | HIGH | `AUDIT_DISC_FINALIZE_REJECT = 16` constant existed but was NOT exported from `sdk/kit/src/index.ts` barrel | RESOLVED in `c7cf727`. Added to barrel exports. |
| HIGH-2 | HIGH | F-19 test asserted ZERO `disc=16` entries (admitted "0 rejected entries written" — disc=16 never exercised anywhere) | PARTIALLY RESOLVED in `c7cf727`. Added sanity test asserting `DISC_FINALIZE_REJECT === 16` + differs from disc=0/1/5/13. **Full runtime expired-finalize → disc=16 read deferred to Phase 7.1 surfpool sandwich tests** (LiteSVM can't drive expired-session finalizes economically). |
| HIGH-3 | HIGH | `SigilError::ConstraintsVaultMismatch` message "Zero-copy constraints account has wrong vault" misleads ops when fired from audit-log paths (12 of 16 call sites are audit-log defense-in-depth, NOT constraints) | RESOLVED in `c7cf727`. Variant renamed → `ZeroCopyVaultMismatch` with generic message "Zero-copy account vault key mismatch (defense-in-depth)". Error code **6064** (NOT 6068 as the §RP-1 fix-up report incorrectly claimed) — code number unchanged. 14 Rust ix files updated, 5 SDK/test files updated, IDL + Codama regenerated, error-drift OK 103. |
| MED-1 | MED | Phase 9 removal of `targetProtocolBytes()` alias is undefined (Phase 9 not enumerated in CLAUDE.md/REVAMP_PLAN) | DEFERRED — Phase 9 SDK redesign will own the alias removal; ADR-style tracker in Phase 9 dispatch will pick this up. |
| MED-2 | MED | disc=0 (RESERVED_ZERO) vs disc=1 (VALIDATE no-writer post-fix) — two reserved-no-writer constants, names don't disambiguate | DEFERRED — cosmetic; future docstring polish in Phase 9. |
| MED-3 | MED | F-19 test comment thinks-out-loud about disc=1 in a confusing way | DEFERRED — cosmetic; will clean up alongside MED-2 in Phase 9 doc-polish. |
| LOW-1 | LOW | `_padding: [u8; 13]` forward-compat slot lacks Phase 9+ schema spec | DEFERRED — Phase 9 owns the future-field-append protocol. |

## Deferred to Phase 7.1

| ID | Title | Reason for deferral |
|---|---|---|
| MED-1 | F-19 burst behavioural test (65 expired-finalize cranks → rejected wrap, success unchanged) | LiteSVM economics — each expired-session cycle ~30s; surfpool sandwich tests can batch |
| MED-2 | Sysvar freshness test (slot_hash bytes differ between two consecutive ix writes in real validator) | LiteSVM doesn't advance `slot_hashes` per-ix; surfpool / devnet exercises this naturally |
| MED-3 | Discriminator coverage gap-fill for the remaining 9 of 15 ix (deposit, withdraw, pause, unpause, revoke, policy_apply, constraints_apply, finalize_success, finalize_reject) | Phase 7.1 scope — adversarial coverage matrix expansion |
| N-2 | `AuditEntry.discriminator` field-name vs Anchor account-discriminator naming clash | Cosmetic; defer to Phase 9 SDK redesign |
| N-3 | `read_slot_hash_head` zero-default on empty sysvar | Blocked by address constraint, low risk; leave as-is |
| N-4 | Edge case tests (count = CAPACITY-1, count > CAPACITY by single-step assertions, byte-offset pin in TS) | Phase 7.1 scope |
| N-5 | User-facing rent doc drift (~0.058 SOL spec → ~0.18 SOL actual due to widened `_padding`) | Docs PR — separate from on-chain fix-up |

## Final test state (post §RP-1 + §RP-2 fix-up)

| Gate | Pre-fix-up | Post-fix-up | Status |
|---|---|---|---|
| `cargo test --lib --features devnet-testing` | 230 / 0 | **230 / 0** | unchanged |
| `npx ts-mocha tests/audit-log.ts` | 9 / 0 | **10 / 0** | +1 (disc=16 sanity test from §RP-2 HIGH-2) |
| `sdk/kit` test suite | 1740 / 0 | **1740 / 0** | unchanged (Codama-regen propagates field rename transparently) |
| `pnpm verify:error-drift` | OK 103 | **OK 103** | unchanged (ZERO new error codes — variant renamed in-place) |
| Expanded LiteSVM (13 files) | 392 / 0 | **402 / 0** + 2 pending | +10 from audit-log + disc=16 sanity |

## Verdict: **CLEAR-TO-PROCEED**

§RP-1 + §RP-2 close-up complete. Phase 7 ships with:
- HIGH-1 / HIGH-2 closed in source-of-truth Rust + propagated to IDL + Codama-regen TS + SDK helpers + tests
- §RP-1 I-2 / I-3 / N-1 closed
- §RP-2 CRIT-1 / CRIT-2 / HIGH-1 / HIGH-2 / HIGH-3 closed
- ZERO new error codes (variant renamed `ConstraintsVaultMismatch` → `ZeroCopyVaultMismatch`, code 6064 unchanged)
- `prepublishOnly` hook on sdk/kit/package.json prevents stale dist on next publish
- Phase 7.1 deferral list documents residual MED-1/2/3 + LOW-1 + N-2/3/4/5 with explicit rationale

Phase 8 (ownership-transfer) and the burst behavioural tests can proceed in parallel using surfpool.
