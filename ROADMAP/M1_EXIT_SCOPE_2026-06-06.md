# M1-EXIT Gate + Merge/CI Path — Scope (step ① of `UNIFIED_PLAN_2026-06-06.md`)

**Status: SCOPE — ground-truth-verified 2026-06-06** (live git/CI/devnet output, not docs). Branch `revamp/onchain-m1` @ HEAD `06568db8`. Repo `github.com/Sigil-Trade/sigil` (agent-middleware is its own repo). EXIT criteria are `00_ROADMAP.md §4`.

## A. Verified current state

### The 7 EXIT criteria
| # | Criterion | State | Evidence / gap |
|---|---|---|---|
| 1 | Code-complete (all M1 merged) | **on branch, NOT merged** | 290 commits ahead of `main`; merge = §C below |
| 2 | `anchor build --no-idl` clean + IDL restored | **needs fresh confirm** | CI enforces IDL-drift + Codama freshness — a real fail risk if committed `target/idl`,`target/types`,`sdk/.../generated` drift from source |
| 3 | Full suite green, 0 failing | **LIKELY green; not CI-gated; not freshly re-run** | The "503/5/0" baseline (`STATUS.md:8`) is current; **cu-budget Scenario 6 is FIXED** (`e58da32f`, 28→16 pad) — the "still failing" prose (`STATUS.md:33,39,90-96`) is STALE. BUT "full suite" = all **24** LiteSVM files, and the branch's CI (`revamp-ci.yml`) runs only `pnpm test` = **4 files**; **5 M1 files run in NO workflow** (`f10-timelocked-admin`, `fq6-operator-grant-tiers`, `intent-digest-parity`, `m1-03-frozen-gate`, `pen-cross-1-absorption`). So "green" is a local claim, not CI-backed. |
| 4 | Adversarial review of the **full M1 diff** (0 unresolved CRIT/HIGH) | **NOT DONE** | Per-item reviews all passed (`STATUS.md:32-37`); no whole-diff review on record. Mandatory per CLAUDE.md pipeline. |
| 5 | Upgrade authority = local keypair | **✅ MET** | on-chain authority `6wrkKTM2pjkc…` == `~/.config/solana/id.json`; can upgrade-in-place. Mainnet authority is a separate Squads PDA (out of scope). |
| 6 | Devnet redeploy of M1 + IDL published | **NOT DONE — keystone** | Deployed devnet binary is the **2026-05-25 pre-M1 build** (bytecode hash + git-DAG proof: deploy commit `b58a6678` is an ancestor of every M1 fix). **Devnet currently runs UNHARDENED code.** #7 is unsatisfiable until this lands. |
| 7 | Devnet exploit suite passes (rejects every attack) | **PARTIAL / BLOCKED** | LiteSVM exploit suite is comprehensive (`tests/security-exploits.ts`, 165 tests, all 6 §4.7 categories incl. drain/brick/frozen-accept). Devnet suite exists (`tests/devnet-*.ts`) but: targets the stale binary, CI job **disabled** (since 2026-04-03; raw SPL transfers trip `UnauthorizedTokenTransfer 6038`), references a **missing** `tests/devnet-positions.ts`, and lacks devnet drain/brick tests. |

### The merge/CI reality (CONFIRMED)
- **Divergence:** 290 ahead / **2 behind** `origin/main`; `origin/main` is NOT an ancestor → **must rebase/merge the 2 newer commits in** (the `main-protection` ruleset is **strict**: branch must be up-to-date before merge).
- **Diff size:** **522 files, +94,921 / −40,533** (programs 84, sdk 247, tests 53). **Never pushed; never CI'd.**
- **Branch protection:** ruleset `main-protection` (active) — one required check **`Security Gate`**, strict status policy, linear history, **0 human approvals required**, no bypass.
- **PR CI gates (all run — path filters all true):** `build-lint-test` (~1936 TS), `rust-checks` (cargo fmt + clippy `-D warnings`), `on-chain-tests` (anchor build + ~673 LiteSVM + IDL-drift), `build-verification`, `surfpool` (~53), **Sec3 X-Ray (blocking, always)**, **Certora (blocking; needs `CERTORAKEY`; must be 16/16 — runs against the changed program even though `certora/` specs are unchanged)**, **Trident fuzz (blocking, 1K iters)**. PR CI is LiteSVM+Surfpool only — **no devnet job** in the PR gate.
- **Working tree:** dirty with this session's `ROADMAP/` planning docs only (no code).

## B. Decisions needed (Kaleb) — some block execution
1. **#7 gate-definition:** does the comprehensive **LiteSVM** exploit suite satisfy #7, or is a **true devnet** suite mandatory? (Devnet *spend* simulation is structurally blocked by err 6038 without a real DeFi CPI — this is why the devnet CI job was disabled.) This decides how much of §D-2 is in scope.
2. **`CERTORAKEY` configured in repo secrets?** Certora is a blocking gate on a same-repo PR and must hit 16/16. If the key isn't set, Phase C stalls at the gate. (I can't read secrets — you'd know.)
3. **Confirm M1-EXIT is the hard prerequisite before the product layer** (the unified plan asserts "foundation passes its own gate first"). If yes, ① is the active step; if you'd rather ship the W5 wedge in parallel, say so.
4. **#4 review scope:** the full program diff `main(b58a6678)..HEAD -- programs/sigil/src/` — confirm that's the target.

## C. Ordered plan to close ①

**Phase A — Local verify (safe; no main/devnet; produces the tool-backed evidence the gate requires)**
- A1. Commit this session's `ROADMAP/` planning docs (authorized doc commits).
- A2. `anchor build --no-idl` → restore IDL → run the **full 24-file LiteSVM** suite + `cargo test` + kit tests → capture green inline (criteria #2, #3). Fix any real failure. Scrub the stale "cu-budget still failing" prose in `STATUS.md`.
- A3. **Full-diff adversarial review** (criterion #4) over `programs/sigil/src/` aggregate diff → fix every CRITICAL/HIGH.

**Phase B — Make "full green" CI-backed (close the self-certification gap)**
- B1. Extend `ci.yml`'s LiteSVM job to run all 24 files (add the 5 ungated M1 files + confirm cu-budget is included), so the PR actually gates the full suite rather than relying on a local claim.

**Phase C — Merge/CI path (the wildcard)**
- C1. Rebase/merge `origin/main`'s 2 commits in; resolve conflicts; re-confirm build+suite.
- C2. First push of `revamp/onchain-m1`; open PR → `main`.
- C3. Triage CI cold-start failures iteratively: Certora 16/16 (needs `CERTORAKEY`), Sec3 X-Ray (allowlist new findings or fix), Trident (0 violations), clippy `-D warnings`, IDL-drift/Codama freshness, ~1936 TS + ~673 LiteSVM + ~53 surfpool. **This is the real unknown** — 522 files, never CI'd.
- C4. Green → `Security Gate` passes → merge (0 approvals required).

**Phase D — Devnet EXIT (criteria #6, #7)**
- D1. Upgrade-in-place deploy the M1 binary to devnet (authority already local, #5) + publish IDL (#6).
- D2. Run the exploit suite against the fresh binary (#7). If devnet is mandatory (decision 1): re-enable the devnet CI job, fix/remove the missing `tests/devnet-positions.ts`, and resolve the 6038 spend-sim blocker (real DeFi CPI on devnet); else record the gate-def sign-off that the LiteSVM suite + the devnet access-control subset satisfies #7.

## D. Definition of done (①)
All 7 §4 criteria met with **tool-backed evidence pasted inline**; PR merged to `main` with green `Security Gate`; devnet running the **M1** binary with the exploit suite passing (or the explicit #7 gate-def sign-off). Then ② (security hardening fold-ins) and ③ (W5 wedge) build on a merged, CI-gated, devnet-validated base.

## Risk register
- **R1 (high):** the 522-file never-CI'd diff fails one+ blocking gate on first push (Certora/Sec3/Trident/clippy/IDL-drift). Mitigation: Phase A local verify + the adversarial review surface most of it before the push.
- **R2 (info):** devnet is currently the pre-M1 unhardened binary — low stakes (devnet), but no M1 guarantee holds on-chain until D1.
- **R3:** `CERTORAKEY` / Certora 16/16 is a hard merge gate outside local control (decision 2).
