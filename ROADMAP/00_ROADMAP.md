# Sigil On-Chain Roadmap — Master Plan

> **▶ SUPERSEDED-IN-PART by `UNIFIED_PLAN_2026-06-06.md` (current forward plan).** M1 (this plan's base) is **functionally DONE** and preserved as the foundation. The governing rule below — *"nothing outward until the base is 100%"* (line 6 / §5) — is **RETIRED**: validated demand + the vault-conservation reset moved the priority to the outward product layer (audit-export wedge, activity, positions, control-UX), and M1 already satisfies the control demand. M2/M3's remaining items are reconciled (mostly superseded) in the unified plan §2. Read it first; treat the milestones below as the (largely shipped) M1 record + a parked M2/M3 design archive.

**Status:** PLAN (no code written by these docs — approval artifact)
**Created:** 2026-05-30
**Mode:** Plan-everything-first (full design approved before any code)
**Horizon:** ON-CHAIN ONLY. Nothing outward (SDK/MCP/dashboard) until the base is 100%.
**Source of truth:** the Rust at `programs/sigil/src/`. Every file:line here is re-verified at build time.

---

## 0. Why this exists

Sigil is a non-custodial Solana guardrail for AI-agent vaults: a human or an AI agent stands up a vault in seconds, grants an agent execute-only spend power, and the program **guarantees the agent cannot do anything the owner didn't allow** — verified by asserting on the vault's observable on-chain STATE before/after each transaction, oracle-free, without parsing any protocol's instructions. The user always signs last.

This roadmap takes the program from its current state to a **clean, trustworthy, agnostic-by-outcome base** (M1), then layers the **production-proven primitives** confirmed by the 10-protocol study (M2). It is grounded in three artifacts produced this session:
- `docs/AGNOSTIC_ASSERTION_MODEL.md` (the design north-star + §3.2 production evidence)
- The on-chain audit (2 HIGH + MEDIUMs, this session)
- The constraints-engine teardown map (memory + AGNOSTIC_ASSERTION_MODEL §4)

## 1. Governing rules (apply to every item)

- **Definition of Done (per CLAUDE.md mandatory pipeline):** build (`anchor build --no-idl`) → restore IDL (`git checkout -- target/idl/ target/types/`) → full test suite green → adversarial code-review agent (reads real code, attacks it) → all CRITICAL/HIGH fixed → PR → CI green. No `--no-verify`, no self-certification.
- **Ground truth before acting:** every file:line in these PRDs is re-grepped at the start of its item; if drifted, the PRD is corrected before code.
- **No parsing-engine resurrection (ISC-A):** no item may read protocol-specific instruction data or caller-supplied byte offsets. Offsets are baked-in + auditor-verifiable only.
- **Non-custodial invariant (frozen):** only the vault owner can freeze/pause/transfer-ownership. No protocol/founder/admin power over user vaults. No admin kill-switch.
- **No oracles** now or near-future. Volatile assets = quantity caps; value-denominated caps = stablecoins only.
- **Dependency ordering, never calendar.** Items are sequenced by what breaks the build if reordered.

## 2. Milestones

### Milestone 1 — Clean trustworthy base (independently shippable)
Goal: a program that is correct, minimal, and agnostic-by-outcome, with the dead parsing engine gone and the two confirmed HIGHs closed. Lockable/auditable on its own.

| # | Item | PRD | Depends on |
|---|---|---|---|
| M1-00 | Establish clean baseline (build/test green, commit F-4 WIP, triage 5 stashes, fresh branch, archive fractured docs) | `01_M1-00_baseline.md` | — |
| M1-01 | HIGH-1: destination-allowlist swap bypass | `02_M1-01_high-destination-allowlist.md` | M1-00 |
| M1-02 | HIGH-2: frozen-accept kill-switch bypass | `03_M1-02_high-frozen-accept.md` | M1-00 |
| M1-03 | Systemic frozen-status gate sweep (apply_pending_policy + siblings) | `04_M1-03_systemic-frozen-gate.md` | M1-02 |
| M1-04 | Constraints-engine teardown (move shared helpers FIRST, unwind has_constraints, delete) | `05_M1-04_constraints-teardown.md` | M1-00 |
| M1-05 | Decouple + promote existing agnostic primitives to first-class | `06_M1-05_promote-agnostic-primitives.md` | M1-04 |
| M1-06 | MEDIUM fixes (non-stablecoin input bound; per-protocol rolling window) | `07_M1-06_mediums.md` | M1-01 |
| M1-XX | M1 EXIT: devnet upgrade-in-place + adversarial exploit suite | (gate in this doc §4) | all M1 |

### Milestone 2 — Production-proven new primitives (design-level PRDs)
Goal: add the agnostic primitives the 10-protocol study confirmed as production-proven AND bakeable. Each is its own PRD; priority order below.

| # | Item | PRD | Rationale (research) |
|---|---|---|---|
| M2-01 | Universal-offset typed assertion catalog (baked-in SPL/Token-2022 fields) | `08_M2_new-primitives.md §M2-01` | SPL base layout = the confirmed 100% universal; owner-pin pre-req |
| M2-02 | Token-2022 extension gating | `08_M2_new-primitives.md §M2-02` | Unanimous among Orca/Kamino/Drift |
| M2-03 | Delegate/freeze/owner integrity assertions (zero-balance-change defense) | `08_M2_new-primitives.md §M2-03` | Closes the deferred-drain blind spot |
| M2-04 | ProgramScope-style balance-delta metering | `08_M2_new-primitives.md §M2-04` | Swig-proven; purest golden-goose primitive |
| M2-05 | Universal slippage (stable/round-trip scope only) | `08_M2_new-primitives.md §M2-05` | Narrow valid scope per slippage research |

## 3. Resolved content-forks (decided here; reject any before code)

1. **2 HIGHs are the first M1 work after baseline** (security-first), not deferred. [M1-01, M1-02]
2. **M2 primitive priority** = catalog → Token-2022 gating → integrity assertions → metering → slippage. Rationale: each builds on the prior (the catalog + owner-pin is the substrate everything else reads through).
3. **Token-2022 gating policy** = adopt the audited Orca/Kamino posture: **reject `NonTransferable`; badge/allowlist-gate `PermanentDelegate` + `TransferHook` + `DefaultAccountState`; treat `TransferFeeConfig` as delta-affecting (bound conservatively).** This OVERRIDES the dead blueprint's "allow NonTransferable" (which was unaudited and contradicted by Orca). [M2-02]
4. **`has_constraints` unwind** = the largest mechanical risk (~28 handler refs). Strategy: it is a `policy` field; unwind by (a) making every read site treat "no constraints" as the only state, (b) removing the field last, after the constraints account/handlers are gone, in a single sweep PR with a grep-gate proving zero residual refs. [M1-04]
5. **5-stash disposition:** `stash@{0}` (post-assertions R-1 MintDeltaCap, on-chain) → **evaluate for M2-01/M2-03, do not auto-apply**; `stash@{1}` (CI/SDK/tests) → out of on-chain scope, defer; `stash@{2}` (empty) → drop; `stash@{3}` (sdk/seal.ts) → out of scope; `stash@{4}` (sdk errors module) → out of scope. Only `stash@{0}` is on-chain-relevant. [M1-00]

## 4. M1 EXIT GATE — "Devnet + adversarial"

The on-chain base is "done" when ALL hold (each tool-verified, evidence captured):
1. Code-complete: all M1 items merged.
2. `anchor build --no-idl` clean; IDL restored.
3. Full LiteSVM/unit suite green (current ~`pnpm test`), zero failures.
4. Adversarial code-review agent pass on the full M1 diff — zero unresolved CRITICAL/HIGH.
5. **On-chain upgrade authority verified** = local keypair (`solana program show 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`); if so, **upgrade-in-place to the SAME program ID** (no new deployment).
6. Devnet redeploy succeeds; IDL published.
7. The adversarial devnet exploit suite passes = program **rejects every attack** (access-control, spending-cap-bypass, drain, kill-switch-brick, frozen-accept, destination-bypass).

**Baseline measured 2026-05-30:** `anchor test` = 148 passing / 2 pending / 0 failing. Note (per M1-04): after the constraints teardown the passing count DROPS by the removed engine-only tests — that is correct; the gate is "all surviving non-constraint tests pass + drop fully accounted for," not "same count."

Program ID stays `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` (devnet, upgrade-in-place, single-keypair authority for speed).

**Mainnet authority (correction 2026-05-30):** mainnet upgrade authority is ALREADY a configured Squads multisig (a real, set address) — NOT undecided/later. Per the non-custodial invariant, that Squads multisig governs **program-CODE upgrades only**; it has ZERO power over user vaults (no freeze/pause/withdraw). M1 touches devnet only; mainnet promotion (deploy through the existing Squads multisig) is a post-M1+M2 step, but the multisig itself is not a design decision — it exists. Confirm the exact Squads address against `06_OPERATIONS` / deploy records at promotion time; do NOT re-design it.

## 5. Out of scope (explicit)

- SDK / MCP / dashboard / landing — nothing outward until M1+M2 exit.
- Oracles (any kind) — except a possible future stablecoin-depeg tripwire, NOT in this roadmap.
- Mainnet deployment + multisig governance — separate effort after the base is audit-clean.
- The 4 §B parallel-track items (STRIDE application, free security tools, etc.) — admin/ops, not on-chain code.

## 6. Index of PRDs

- `01_M1-00_baseline.md`
- `02_M1-01_high-destination-allowlist.md`
- `03_M1-02_high-frozen-accept.md`
- `04_M1-03_systemic-frozen-gate.md`
- `05_M1-04_constraints-teardown.md`
- `06_M1-05_promote-agnostic-primitives.md`
- `07_M1-06_mediums.md`
- `08_M2_new-primitives.md`
