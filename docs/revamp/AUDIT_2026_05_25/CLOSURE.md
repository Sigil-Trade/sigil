# Audit 2026-05-25 — Closure Tracking

**Audit source:** Pentester re-audit at HEAD post-Phase-10 redeploy (verification of CH-* + LM-* + HH-1 closures + fresh-eyes scan).
**Audit date:** 2026-05-25
**Closure branch:** `revamp/v2-2026-05` (this branch)
**Closure cadence:** one finding per session, explain → confirm → implement → verify (per user directive).

---

## Summary

| Severity | Count | Closed | Accepted | Deferred |
|---|---|---|---|---|
| HIGH | 1 | 1 (H-1) | 0 | 0 |
| MED | 4 | 3 (F-1, F-2, F-3) | 0 | 1 (M-1 — pending architectural conversation) |
| LOW | 5 | 0 | 1 (L-2) | 4 (F-4, F-5, L-1, L-3 — pending audit text or scheduling) |

---

## H-1 — apply_agent_grant re-binds cosign at apply (CLOSED)

**Status:** ✅ CLOSED at commit `fc03d47a` (working tree, devnet not yet redeployed)
**Threat closed:** joint-compromise + cosign-rotation bypass
**Fix:** mirrors `reactivate_vault.rs:187-233` NH-1 pattern; when `policy.cosign_required == true` the apply tx must include a signer matching the LIVE `policy.cosign_session_pubkey` in `remaining_accounts`
**Source files:**
- `programs/sigil/src/instructions/apply_agent_grant.rs` (+section "1.25 H-1 close" + docstring expansion)
- `tests/sigil.ts` (per-protocol-spend-caps test extended with cosigner)

**Verification:**
- `anchor build --no-idl` clean
- `cargo test --lib` 244/244
- LiteSVM CI list 516 passing / 12 pre-existing failures
- Pushed to origin/revamp/v2-2026-05

**NOT YET DEPLOYED:** Deployed devnet program at `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` still carries the pre-fix bytecode. Requires a follow-up redeploy to land H-1 on-chain.

---

## F-2 — deploy-devnet.yml stale program ID (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Issue:** `.github/workflows/deploy-devnet.yml` lines 40 + 323 still referenced the OLD program ID `4ZeVCqnj…`. Path-filtered `push:` trigger would have auto-failed on every Rust merge.
**Fix:**
- Updated `PROGRAM_ID` env (line 39) and `solana-verify --program-id` flag (line 322) to `7FtAXUcr…`
- Removed `on.push` block — workflow is now `workflow_dispatch` only
- Added header comment explaining the manual-only rationale (CI keypair is not the upgrade authority for the new program; user wallet deploys manually)

---

## F-3 — closeVault enumeration asymmetry (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Issue:** Two parallel enumeration loops in `sdk/kit/src/dashboard/mutations.ts::closeVault`. The OLD loop (lines 543-595) covered `pending_policy` + N×`pending_agent_perms` + `pending_close_constraints` with WARN-only RPC error handling. The CH-2/HH-1 NEW loop covered the other 3 PDA classes with ERROR-level + flag escalation. A transient RPC outage in the OLD loop would silently omit per-agent rent reclaim with no monitor signal.

**Fix:**
- Moved `derivePendingAgentPermsPDA` from `mutations.ts` to `resolve-accounts.ts` as `getPendingAgentPermsPDA` (with proper `[Address, number]` return type matching siblings)
- Extended `enumerateExistingPendingPdasForClose` in `close-vault.ts` to take a required `agents: ReadonlyArray<Address>` parameter and enumerate all 6 PDA classes (pending_policy first for ordering)
- Deleted the OLD loop in `mutations.ts::closeVault`; single helper call now drives all pending-PDA enumeration
- Updated 3 existing close-vault tests + added 2 new tests (per-agent path; symmetric onRpcError firing for all 5 classes)

**Verification:**
- `pnpm -C sdk/kit run pretest` (tsc) clean
- `pnpm -C sdk/kit test` 1915/1915 passing including 19/19 in close-vault.test.ts (5 new assertions added)
- API surface delta tracked in `sdk/kit/etc/kit.api.txt`

---

## F-1 — ci.yml devnet-address scan was dead code (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Issue:** `.github/workflows/ci.yml:562-587` scanned `programs/sigil/src/*.rs` for the OLD devnet treasury `ASHie1dFTn…`. Phase 10b swapped to `6wrkKTM2pj…` (state/mod.rs:294). The OLD address now appears only in one doc-comment line at state/mod.rs:289 (inside the cfg block, so vacuously passes). The defense-in-depth scan was no longer protecting against the actual threat (unguarded `6wrkKTM2pj…` in non-cfg-gated code).

**Fix:**
- Updated `DEVNET_TREASURY` env in ci.yml from `ASHie1dFTn…` to `6wrkKTM2pj…`
- Added explanatory comment documenting (a) when the swap happened, (b) what the scan is the defense-in-depth check for, (c) where legitimate usages live (inside cfg(feature="devnet") blocks in state/mod.rs)

**Verification:** Local simulation of the scan logic (5-line look-back heuristic) found 1 GUARDED match at state/mod.rs:287 and 0 unguarded matches — scan PASSES correctly.

---

## M-1 — close_vault silent-skip on 5 pending-PDA classes (DEFERRED — architectural)

**Status:** 🟡 DEFERRED — awaiting deeper architectural conversation per user directive
**Issue:** Of the 6 pending-PDA drain blocks in `close_vault.rs`, only `pending_policy` hard-fails when missing (via `policy.has_pending_policy` flag). The other 5 (`pending_agent_perms`, `pending_close_constraints`, `pending_owner`, `pending_agent_grant`, `pending_constraints`) silently no-op via `lamports() > 0` guard. The asymmetry is rooted in the data model — only `pending_policy` has a lifecycle flag because nothing else in the protocol needs to consult "does pending X exist" outside the queue/apply/cancel pair for that class.

**Option-space considered:**
- A: Documentation-only at each silent-skip block
- B: Emit `PendingPdaDrained` event per class (requires redeploy)
- C: Add opt-in `require_all_pending_drained: bool` ix arg (requires redeploy + schema change)
- D: A + B combined
- E: Accept as-is, defer

**User decision:** Defer until LOWs are addressed, then have a deeper architectural conversation about whether the data model itself should change to support per-class lifecycle flags (which would let close_vault hard-fail symmetrically across all 6 classes). Acknowledged tradeoff is schema-bloat vs symmetric safety.

**Reopens:** After F-4, F-5, L-1, L-3 are closed.

---

## L-2 — Devnet key concentration (ACCEPTED — documented tradeoff)

**Status:** 🟢 ACCEPTED as documented tradeoff
**Issue:** User wallet `6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp` holds five concurrent devnet roles: PROTOCOL_TREASURY const, program upgrade authority, default Solana CLI keypair, ALT authority (planned), test wallet across 14+ test files. Single key compromise → broad devnet impact (upgrade, drain, test corruption).

**Why accepted:**
- Mainnet `PROTOCOL_TREASURY` is the Squads V4 vault PDA (`7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy`), upgrade authority is separately controlled, deploys are multisig-gated. **L-2 is purely devnet operational hygiene with no mainnet exposure.**
- The consolidation was an explicit Phase 10b choice (user-managed devnet treasury). Reverting would add operational friction without changing the mainnet posture.
- Devnet blast radius is bounded: bad bytecode → roll forward with a fresh deploy; drained treasury → negligible value; corrupted tests → re-run in clean environment.

**Documented tradeoff acknowledged.** No code change.

---

## F-4 — saturating_sub vs checked_sub in F-10 freshness (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Audit text:** *"F-10 saturating_sub weakens defense vs checked_sub in sibling timelock check (impossible-in-prod, but worth normalizing). 3 files × 1 line."*

**Issue:** The CH-1 F-10 freshness check at 3 admin-timelocked apply sites used `saturating_sub` for the slot delta. On an impossible-in-prod clock-backward anomaly (`queued_at_slot > clock.slot`), saturating_sub returns 0 → 0 < MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN passes → apply succeeds. Asymmetric with the sibling `unix_timestamp.checked_sub(...).ok_or(Overflow)` pattern 4 lines below.

**Fix (option A+C combined):**
- Replaced `saturating_sub` with `checked_sub(...).ok_or(error!(SigilError::Overflow))?` in 3 files:
  - `programs/sigil/src/instructions/apply_agent_grant.rs:140-148`
  - `programs/sigil/src/instructions/accept_ownership_transfer.rs:153-163`
  - `programs/sigil/src/instructions/accept_ownership_transfer_multisig.rs:189-199`
- Added new LiteSVM test `F-4 fires Overflow when clock.slot < queued_at_slot (impossible-in-prod underflow)` in `tests/f10-timelocked-admin.ts:368-441` — warps clock backward via `svm.setClock`, queues then applies, asserts `Overflow` error.

**Verification:**
- `anchor build --no-idl` clean (6.95s)
- `cargo test --lib` 244/244
- `npx ts-mocha tests/f10-timelocked-admin.ts` 4/4 passing (3 pre-existing + 1 new)

**Redeploy needed:** Source change → bytecode change → currently-deployed devnet program at `7FtAXUcr…` does NOT yet carry F-4 fix. Lands at next redeploy.

---

## F-5 — 8 SDK test files used old program ID as placeholder (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Audit text:** *"8 SDK test files have placeholder constants OWNER = "4ZeVCqnj…" — not security, but creates audit-fatigue when grepping. Effort: mechanical sed."*

**Issue:** 8 sdk/kit/tests/* files used the OLD program ID `4ZeVCqnj…` as a stand-in for arbitrary 32-byte base58 test constants. After Phase 10 the address is doubly misleading — semantically wrong (SDK no longer targets it) and lexically confusing (greppers find test fixtures when looking for real refs).

**Fix (option C — variable-by-variable judgment):**
- **6 placeholder vars** swapped to synthetic `"11111111111111111111111111111112"` (matches the close-vault test's `VALID_VAULT` pattern):
  - `create-vault.test.ts:32` `OWNER`
  - `transaction-executor.test.ts:14` `MOCK_PAYER`
  - `resolve-accounts.test.ts:16` `OWNER`
  - `alt-integration.test.ts:20` `MOCK_PAYER`
  - `composer.test.ts:14` `MOCK_PAYER`
  - `logger.test.ts:182` inline `vaultPubkey`
- **2 program-address vars** refactored to import real `SIGIL_PROGRAM_ADDRESS` from `generated/programs/sigil.js` (auto-tracks future redeploys):
  - `shield.test.ts:1046` `SIGIL_PROG`
  - `experimental/simd-0296.test.ts:95,149` `SIGIL_PROGRAM` (×2 sites)
- **logger.test.ts:188** truncation assertion updated from `"4ZeV...wrHL"` to `"1111...1112"` to match the new placeholder.

**Verification:**
- `pnpm -C sdk/kit run pretest` (tsc + codegen) clean
- `pnpm -C sdk/kit test` 1915/1915 passing
- `grep -rn 4ZeVCqnj sdk/kit/tests/` returns 0 (zero stale refs)

---

## L-1 — Codama deep-import bypass for AL2 gate (CLOSED)

**Status:** ✅ CLOSED (working tree, not yet committed)
**Audit text:** *"Codama builder deep-import bypass for AL2 gate (theoretical via @usesigil/kit/dist/generated/instructions/…). Effort: document or runtime-warn."*

**Issue:** The AL2 mainnet-confirmation gate is enforced at `seal.executeSeal` and `mutations.createPostAssertions` / `closePostAssertions`. A determined consumer could deep-import the raw Codama instruction builder (`@usesigil/kit/dist/generated/instructions/createPostAssertions`) and skip the client-side warning. The gate is a UX safety net (not a security boundary — on-chain enforces every invariant) but the audit flagged the theoretical bypass as worth structural enforcement.

**Fix (option D — document + CI guard):**
- **Documentation**: added "Public API surface vs internals (L-1 audit close 2026-05-25)" section to `sdk/kit/README.md` right after the Subpath imports table. Explicitly lists: subpath exports are the complete public API; `dist/generated/*` is internal; deep-importing forfeits AL2; codama regen churn breaks deep-imports between minor versions.
- **MIGRATION.md banner**: added a top-of-file note pointing to the README section, ensuring upgraders see the policy.
- **CI guard**: new script `sdk/kit/scripts/verify-public-exports.ts` parses `package.json` `"exports"` field and fails CI if any declared path includes `generated/`. Wired as `pnpm verify-public-exports` script + a new step in `.github/workflows/ci.yml` (after the existing `verify-lockfile-pins` step, gated on `sdk-kit` changes).

**Verification:**
- `pnpm -C sdk/kit run verify-public-exports` returns `OK — 9 exports declared, 0 forbidden internal paths.`
- YAML lint clean on the modified ci.yml
- README + MIGRATION renders correctly (Markdown structure preserved).

---

## L-3 — Old program coexistence (PARTIALLY CLOSED — Squads action deferred)

**Status:** 🟡 PARTIALLY CLOSED — doc sweep done, Squads V4 set-upgrade-authority --final OR close action requires multisig signer coordination
**Audit text:** *"Old program at 4ZeVCqnj… still deployed under Squads V4 authority → SDK confusion if env-override targets it. Effort: Squads tx: set-upgrade-authority --final or close"*

**Issue (audit framing):** The old program account at `4ZeVCqnj…` is still deployed on devnet. Its upgrade authority is the Squads V4 multisig vault PDA (per Phase 10b closure: "owned by the Squads V4 vault PDA authority — user wallet cannot upgrade or close it"). If a consumer overrides the SDK's program ID env to target `4ZeVCqnj…`, they'd be running against bytecode that pre-dates Phase 1-10 (CH-* / D-* / M-* invariants absent). The audit's recommended action is a Squads V4 transaction to either render the old program immutable (`set-upgrade-authority --final`) or close it (`solana program close` reclaiming rent).

**Issue (doc framing that was also in scope):** 20+ files referenced `4ZeVCqnj…` post-Phase-10. Mix of stale live-ops docs (misleading) and historical audit/closure docs (intentional, must NOT change). The "SDK confusion if env-override targets it" risk is amplified by docs that present the old program as current.

**Fix (option C):**
- **Swept 6 live-ops files** — replaced `4ZeVCqnj…` with `7FtAXUcr…` in `README.md`, `SECURITY.md`, `docs/SECURITY.md`, `docs/PROJECT.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`.
- **Annotated 3 planning docs** — added a "Phase 10 redeploy supersession" banner near the top of `docs/revamp/REVAMP_PLAN.md`, `docs/revamp/HARDENED_V2_PROMPT_MAP.md`, `docs/revamp/ACCEPTANCE_V2.md` so readers know the embedded `4ZeVCqnj…` references are pre-Phase-10 history, not current state.
- **Left untouched** — all historical audit transcripts under `docs/revamp/AUDIT_*/`, Phase 10 closure docs (`PHASE_10_REDEPLOY_DONE.md`, `PHASE_10_TEST_CLEANUP.md`), the changeset `.changeset/sigil-delete-session-is-spending.md`, and `docs/revamp/STAGE_1_REMOVED.md`. These docs are PINNED to their HEAD at write time and preserving the program ID is part of the audit trail.
- **SDK test fixtures** — the 8 SDK test files using `4ZeVCqnj…` as `OWNER`/`MOCK_PAYER`/`SIGIL_PROG` test constants are tracked under F-5 separately (pending audit excerpt).

**Verification:** `grep -c 4ZeVCqnj` on the 6 swept files returns 0 across all of them.

**Pending Squads action (operational, multisig-gated):**

The audit's secondary recommendation — `solana program set-upgrade-authority 4ZeVCqnj… --final` (renders the program immutable, preserves rent) OR `solana program close 4ZeVCqnj…` (reclaims rent, deletes the program account) — requires the Squads V4 multisig vault PDA (the current upgrade authority) to sign. The user wallet `6wrkKTM2pj…` cannot execute this directly. Tracked as a follow-up operational task:

- **Coordinate with Squads V4 signers** to propose + execute one of the two reclamation paths.
- **Decision:** prefer `set-upgrade-authority --final` over `close` so existing on-chain history (any vault state at the old program) remains observable. Devnet rent reclamation is negligible vs the observability cost of deleting a documented program account.
- **Out-of-scope for this code branch.** This is a multisig signer coordination + on-chain operation, not a code change.

---

## Closure procedure (per user directive 2026-05-25)

1. Explain the issue with concrete evidence (file/line citations).
2. Lay out 3-5 fix options with tradeoffs.
3. Ask the user via `AskUserQuestion` before implementing.
4. After user picks, implement + run verification gates.
5. Update this CLOSURE.md with status + commit reference.
6. Mark the corresponding task complete in TaskList.
7. Move to next finding.

**No batch commits.** Each finding closure is its own commit when the user authorizes. Working tree accumulates changes until the user says "commit and push."
