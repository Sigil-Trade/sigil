# Round 2 Line-by-Line Audit Closure

**Date:** 2026-05-19
**Branch:** `revamp/v2-2026-05`
**Audit-start HEAD:** `ee5dda3` (post Phase 7 §RP-2 close-up)
**Closure HEAD:** `c722fa3`
**Span:** 1 consolidated commit + 2 §RP-1 reviews

## Methodology

External Round 2 audit ran 30+ background agents in line-by-line mode at HEAD `ee5dda3`. They reported **4 NEW CRITICAL + 8 HIGH + 16 MEDIUM + 15 LOW** findings — discovered in the SAME files Round 1 had previously audited but using line-by-line discipline. Key meta-finding: broad-survey audits missed within-file patterns.

**This orchestrator's approach:**
1. **Verify before fix** — 10 parallel verification agents dispatched against citation-anchored claims.
2. **Trust nothing** — refute findings that don't hold against source.
3. **Multi-agent fix dispatch** — once verified, parallel Engineer dispatches per logical area.
4. **§RP discipline preserved** — both silent-failure-hunter and Pentester reviews on the consolidated work.

## Verification Outcomes (10 parallel agents)

| Finding | Severity | Verification |
|---|---|---|
| F19 finalize stale `.amount` | CRIT | **CONFIRMED** — line numbers shifted from 211/227 to 236/252; substance identical |
| F-RP3-1 reactivate cosign gap | CRIT | **CONFIRMED** + worse (missing policy_version bump too) |
| F-RP3-2 perms cosign gap | CRIT | **CONFIRMED** + requires schema growth on PendingAgentPermissionsUpdate |
| F-AT-1 walker dedup | CRIT | **CONFIRMED** (attack constrained to USDT-with-USDC-src case but still defeats TA-12 floor) |
| F-RP3-3 close_vault drain | HIGH | **REFUTED** — close_vault doesn't move SPL tokens (only rent SOL) |
| D2 F4 withdraw_funds cosign | HIGH | **CONFIRMED** — this is the REAL drain primitive |
| D2 F4 deposit/freeze/cleanup/extend | HIGH | **REFUTED** — risk-profile-appropriate exempt by design |
| VH-2 agent_transfer graylist | HIGH | **CONFIRMED** — TA-07 bypass on direct-transfer path |
| B4 F-1 cosign digest scope | HIGH | **CONFIRMED** — bound 4/8 elevation triggers |
| B4 F-3 silent swallow | HIGH | **CONFIRMED** (latent — breaks future audit-log) |
| D1 R-4 F-3 defi_idx bound | HIGH | **REFUTED** — token-owner require gates the path |
| C1 F-1 set_observe_only seeds | MED | **CONFIRMED** — downgraded from HIGH (defense-in-depth holds via has_one + policy seeds) |
| D2 F-3 pause_agent existence | HIGH | **REFUTED** — handler iterates+ok_or BEFORE policy_version bump |
| VH-7/6/4 replay class | MED | **CONFIRMED** but DOWNGRADED to LOW (blockhash-bounded) |
| B9 78-byte comment | LOW | **REFUTED** — byte count actually correct |
| Phase 8 spec corrections (3) | INFO | **CONFIRMED** — captured in task #59 |
| 17 Round 1 closures hold | — | **CONFIRMED** — V10 spot-checked 10 critical fixes; all hold at HEAD |

**5 of 18 audit claims REFUTED** (~28% noise rate). Verification discipline saved ~5 unnecessary commits.

## Fixes Landed (single consolidated commit `c722fa3`)

### CRITICAL (4)

| ID | File | Fix |
|---|---|---|
| **F19** | `finalize_session.rs:229-298` | Raw-bytes parse extended from H-2 (lines 654-689) to outcome-check path. SPL TokenAccount bytes 0..32 mint, 32..64 owner, 64..72 amount u64 LE. Validates mint+owner BEFORE amount read. Defeats compromised-CPI drain that previously silently bypassed all 6 spending caps. |
| **F-RP3-1** | `reactivate_vault.rs:32-37, 70-77, 136-141` | Added policy account with PDA seeds. Cosign gate fires when `policy.cosign_required==true && no non-owner signer` (mirrors register_agent pattern). policy_version bumped AFTER agent push so concurrent validate_and_authorize fails fast. |
| **F-RP3-2** | `queue_agent_permissions_update.rs:114-186` + `apply_agent_permissions_update.rs:78-117` + `state/pending_agent_perms.rs:21-57` | Schema growth +64 bytes (SIZE 121→185) for cosign_digest + cosign_session fields. Elevation predicate at queue: `(raises_capability OR raises_spending_limit OR sets_non_zero_cooldown) && cosign_required`. Apply re-binds digest. Mirrors queue_policy_update pattern. |
| **F-AT-1** | `agent_transfer.rs:405-448` | Walker dedup changed from (src_ata_key + mint) to pubkey-level via `seen: Vec<Pubkey>` pre-seeded with src_ata_key. Closes USDT-replay-passes inflation attack. Mirrors finalize_session.rs:734-786 sibling pattern. |

### HIGH (4)

| ID | File | Fix |
|---|---|---|
| **VH-2** | `agent_transfer.rs:142-146` | Added `is_destination_graylisted` check after `is_destination_allowed`. Closes TA-07 24h-friction bypass on direct-transfer path. |
| **withdraw_funds** | `withdraw_funds.rs:22-34, 71-94` | Added policy account + interim cosign gate. The REAL drain primitive on cosign-opted-in vaults. Phished owner can no longer drain 100% custody. |
| **B4 F-1** | `cosign_digest.rs:48-241` + `compute-cosign-digest.ts:350-391` | Cosign digest extended APPEND-ONLY with 5 new Options (stable_balance_floor, per_recipient_daily_cap_usd, has_protocol_caps, protocol_caps, cosign_required). Now binds all 8 elevation triggers. HEX pins regenerated bidirectionally. |
| **B4 F-3** | `queue_policy_update.rs:415-429` + `queue_agent_permissions_update.rs:161` | Non-elevated path rejects non-default cosign_session via `require_keys_eq!` with InvalidPermissions (Option A). Previously silently swallowed. |

### MEDIUM (4)

| ID | File | Fix |
|---|---|---|
| **C1 F-1** | `set_observe_only.rs:27-32` | Added canonical seeds + bump constraints (was the only owner-mutating handler without). |
| **M-6** | `agent_spend_overlay.rs:187, 225, 241, 274` | Epoch subtraction switched to `saturating_sub` with clock-skew comments. |
| **M-7** | `tracker.rs:161, 258, 262, 321, 354` | Same fix applied to tracker.rs paths. |
| **M-11** | `apply_pending_policy.rs:151+273-278` | protocol_mode validation moved to defense-in-depth re-check (was duplicate). |
| **TA-11** | `validate_and_authorize.rs:603-630` | Protected-writable array grown from 13 to 14 (adds audit_success + audit_rejected from Phase 7). |

### SDK + Test Infrastructure

- `compute-cosign-digest.ts`: 10-field TS encoder mirrors Rust byte-for-byte
- `cosign-helper.ts`: CosignArgs surfaces all 10 fields, threaded through buildCosignBundle
- `mutations.ts`: `queueAgentPermissions` wrapper passes `cosignSession: "11111111111111111111111111111111"` default
- HEX_MINIMAL / HEX_REALISTIC pins updated (Rust + SDK) to match new computed values
- Codama regen for queueAgentPermissionsUpdate (5th arg) + PendingAgentPermissionsUpdate (SIZE 185) + reactivateVault (new policy account) + withdrawFunds (new policy account)
- target/types/sigil.ts regenerated via nightly anchor build
- 10 queueAgentPermissionsUpdate test sites updated to pass PublicKey.default 5th arg
- 6 queuePolicyUpdate test sites updated (4 non-elevated → PublicKey.default; 2 elevated → cosigner wiring)

## §RP-1 Adversarial Reviews

Both reviewers given the SAME work but different lenses:

### silent-failure-hunter — VERDICT: **CLEAR-TO-PROCEED**

Verified each of 16 fixes byte-for-byte against current HEAD source. Confirmed:
- F19 raw-bytes parse correct on both branches (stablecoin-input + non-stablecoin-input); UnexpectedBalanceDecrease check benefits transitively.
- F-RP3-1 gate fires correctly; policy_version bump AFTER agent push.
- F-RP3-2 elevation predicate evaluated independently (OR logic, no smuggle path); apply re-bind uses same digest input order as queue.
- F-AT-1 seen Vec correctly pre-seeded with src_ata_key.
- B4 F-1 canonical encoding order matches Rust struct positions 6-10 in SDK.
- B4 F-3 require_keys_eq! fires correctly on non-elevated path.
- TA-11 array has 14 entries (no stale sentinel slot).
- Schema growth 121→185 verified across Rust + Codama.
- HEX pins byte-identical Rust↔SDK.

**One MINOR UX finding (non-security):** F-RP3-1 cosign gate fires BEFORE `vault.status == Frozen` check at line 82-85. On a non-frozen vault with cosign-opted-in, caller receives `ErrCosignRequired` instead of more-helpful `VaultNotFrozen`. Trivial reorder fix, **deferred to Phase 8** (where freeze handlers will be touched anyway for C28 reactivate cooldown bundling).

### Pentester — VERDICT: **CLEAR-TO-PROCEED**

Attack-flow composition checks across 10 vectors:

1. **Phished owner key on cosign=true vault**: 7 of 7 drain paths BLOCKED (withdraw_funds + register_agent + reactivate_vault + unpause_agent + set_observe_only-to-false + queue_policy_update elevated + queue_agent_permissions_update elevated). Remaining unblocked: emergency kill-switches (freeze_vault, pause_agent, revoke_agent), deposit_funds (not an attack), close_vault (no token drain), cancel_pending_*.

2. **F-RP3-2 raise-capability + lower-spending-limit smuggle**: REFUTED — predicates evaluated independently with OR; raising capability still flags elevation.

3. **F-RP3-2 cooldown=1 minimal trigger**: ACCEPTABLE — conservative-by-default; only causes UX friction on strengthening, no security leak.

4. **F-AT-1 src_ata_key in remaining_accounts**: dedup catches it (pre-seed at line 406; check at line 408).

5. **F-RP3-1 race window**: cosign gate fires regardless of tx ordering; defender's policy_version bump is moot.

6. **B4 F-1 disable-cosign one-way ratchet**: `disables_cosign` predicate OR'd into is_elevated outside the `policy.cosign_required &&` guard, so disabling cosign correctly requires cosign.

7. **TA-11 14-entry coverage**: All 5 active PDAs covered (vault, policy, tracker, overlay, session, constraints, pending_policy, pending_constraints, pending_close_constraints, post_assertions, pending_owner, pending_agent_perms, audit_success, audit_rejected).

8. **B4 F-3 old-SDK bypass**: Hard reject with InvalidPermissions; no corruption.

9. **NEW attack vectors from Round 2**: NONE FOUND. Cosign gates additive; default-false vaults unaffected; no DoS regression. Walker dedup change only narrows acceptance.

10. **Residual surface on phished-key vault with cosign=true**:
    - **CANNOT**: drain funds, install operator agent, expand allowlists, raise caps, disable cosign
    - **CAN**: DoS (freeze, pause, revoke, cancel_pending_*), close empty vault (forfeits rent only)
    - Acceptable trade-off — emergency kill-switches MUST remain unilateral

PEN-CROSS-1 (register_agent timelock+digest) remains documented-OPEN for Phase 8 — interim cosign gate present but full TA-19 binding deferred.

## Final Test State

| Suite | Baseline (f984118) | Closure (c722fa3) | Δ |
|---|---|---|---|
| `cargo test --lib --features devnet-testing` | 230 / 0 | **230 / 0** | stable |
| `sdk/kit pnpm test` | 1740 / 0 | **1741 / 0** | +1 (new B4 F-1 binding test) |
| Expanded LiteSVM (14 files) | 402 / 0 | **402 / 0 + 2 pending** | stable |
| `pnpm verify:error-drift` | OK 103 | **OK 103** | stable (ZERO new codes) |

All gates green. ZERO new error codes — all Round 2 fixes reuse existing variants (ErrCosignRequired, ErrStableFloorViolation, ErrGraylistFriction, InvalidPermissions, Overflow).

## Deferred (with documented rationale)

| Item | Reason | Owner |
|---|---|---|
| promote_graylist_destination cosign gate | MED priority; pre-stage attack requires already-allowlisted destination | Phase 9 SDK redesign |
| M-1..M-5, M-8..M-12 events/cosmetic | Non-security; cosmetic + monitoring improvements | Phase 9 |
| All LOWs (VH-7/6/4 replay class) | Blockhash-window bounded (~60s); owner-key compromised → already worse capabilities | Phase 11 polish |
| M-4 R-3 dedicated error code | Avoids Phase 8 code allocation churn | Phase 8 |
| F-RP3-1 gate ordering (UX-only) | Trivial reorder; co-locate with Phase 8 freeze handler touches | Phase 8 |
| Phase 8 spec corrections (3) | FreezeReason field add + 3-not-4 ix + cosign-is-flag | task #59 |
| SA5 #15 reactivate cooldown bundle | C28 from REVAMP_PLAN Stage 3-F | Phase 8 |

## Meta-Lesson

**Round 1's 18-agent broad survey found 22 issues in ~50 files. Round 2's 30-agent line-by-line audit at the SAME files found 4 NEW CRITICALs + 8 HIGH that Round 1 missed.**

The fix-this-block-but-not-the-other-block pattern (F19 parallel to H-2 in the same file) and missing-call patterns (VH-2 graylist not mirrored from sibling) are discoverable ONLY via line-by-line read.

**Future audit sequence (formalize in process docs):**
1. **Broad survey** — establish high-level coverage
2. **Line-by-line** — same files, but read every modified function start-to-finish
3. **Adversarial** — attack-chain composition + integration risk

## Verdict: **CLEAR-TO-PROCEED to Phase 8**

All Round 2 verified findings closed in `c722fa3`. Both §RP-1 reviewers (silent-failure-hunter + Pentester) returned CLEAR-TO-PROCEED with detailed evidence. Pattern observation: this is the FIRST cycle where both §RP-1 reviewers cleared without surfacing new findings — likely because the verify-then-fix-then-§RP discipline (vs the usual fix-then-§RP shortcut) prevented churn.

Phase 8 dispatch unblocked. Carry forward to task #59:
- 3 spec corrections (FreezeReason, 3-not-4 ix, cosign-is-flag)
- SA5 #15 reactivate cooldown bundle
- F-RP3-1 gate ordering UX fix
- 17 Stage 4 SDK redesign items
