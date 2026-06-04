# Docs Cleanup Map — Step 1 (report-only, 2026-05-30)

Principle: **ARCHIVE, don't hard-delete** (move to `docs/_archive/<date>/` or a `git tag` + `git rm`), so nothing is lost and the working tree is clean. Verify "canonical" docs against the Rust before trusting them — several predate recent code.

## A. KEEP — canonical reference (verify vs code, then this is the source of truth)
| File | Size | Action |
|---|---|---|
| `docs/ARCHITECTURE.md` | 30KB | KEEP — verify PDA/handler counts vs current code (was stale-ish: 116 errors, 44 handlers, 16 state) |
| `docs/PROJECT.md` | 13KB | KEEP — fold into the ONE canonical mission doc (Step 2) |
| `docs/SECURITY.md` | 67KB | KEEP but TRIM — too big; extract threat model + invariants, archive the rest |
| `docs/DEPLOYMENT.md` | 20KB | KEEP |
| `docs/ERROR-CODES.md` | 12KB | KEEP — header says 6000-6114; code has 116 → reconcile |
| `docs/COMMANDS-REFERENCE.md` | 8KB | KEEP |
| `docs/ONCHAIN-FEATURE-INVENTORY.md` | 18KB | KEEP — but re-derive from code post-constraints-removal |
| `docs/INSTRUCTIONS.md` | 36KB | KEEP — coding guardrails (overlaps root CLAUDE.md → dedup) |
| `docs/revamp/THREAT_MODEL_V2.md` | 66KB | KEEP as threat-model source (verify; trim) |
| `docs/revamp/INTERFACES_V2.md` | 28KB | KEEP — ID/program-ID registry (reconcile 7FtAXU vs 7FtAXUcr) |
| `docs/revamp/ERROR_CODE_ALLOCATION_V2.md` | 17KB | KEEP — error allocation source |
| `docs/revamp/AUDIT_2026_05_25/research/*` | ~140KB | **KEEP — feeds golden goose** (M1_LIGHTHOUSE, Squads, Kamino, Drift, formal-methods, audit-mining) |

## B. ARCHIVE — historical process detritus (move to `docs/_archive/`, out of the way)
- **All phase reviews:** `docs/revamp/PHASE_0_5_REVIEW` … `PHASE_8_REVIEW`, `docs/review/PHASE_9_REVIEW` (silent-failure-hunter transcripts, READMEs) — process history, not reference.
- **All audit closures:** `docs/revamp/AUDIT_2026_05_18`, `_19`, `_19_DC`, `_19_ROUND_2`, and `AUDIT_2026_05_25/*` (closure/council/verdict — but KEEP the `research/` subdir per A).
- **`docs/revamp/STAGE_0_REVIEW/`** (~160KB of reviewer/hunter transcripts) + `STAGE_1_REMOVED.md`.
- **`docs/revamp/REVAMP_PLAN.md` (70KB)** + `HARDENED_V2_PROMPT_MAP.md` (101KB) + `ACCEPTANCE_V2.md` + `REVAMP_CI_README.md` + `PHASE_0_5_MEMORY_REFRESH.md` — the v2-revamp execution scaffolding; superseded by the code-first reset.
- **`docs/PHASE_10_REDEPLOY_DONE.md`, `docs/PHASE_10_TEST_CLEANUP.md`, `docs/AUDIT_SNAPSHOT_CADENCE.md`** — historical.
- **`docs/FUTURE.md` (71KB)** — post-launch idea dump; archive, mine later.

## C. ARCHIVE WHOLESALE — session detritus (not docs)
- **`Plans/` (~55 files)** — auto-named past-session plans (Phalnx→Sigil rebrand DONE, old SDK/Kamino/MCP plans). Tar to `docs/_archive/Plans/`. Spot-keep candidates to re-read first: `playful-floating-hummingbird` (automated protocol onboarding), `DX-CONVENIENCE-LAYER-PLAN` (v2), `twinkly-launching-finch` (agent-first SDK+MCP).
- **`MEMORY/WORK/` (~380 PRDs, 20260307–20260503)** — PAI session history. Tar to `docs/_archive/MEMORY-WORK.tar` (or drop — it's in git history). Keep `MEMORY/custody-architecture.md` if still relevant.

## D. MINE-BEFORE-ARCHIVE — prior art on the golden goose (read these to ground Step 2)
- `docs/revamp/AUDIT_2026_05_25/research/M1_LIGHTHOUSE.md`
- `MEMORY/WORK/20260319-160000_state-assertions-v5-integration/PRD.md`
- `MEMORY/WORK/20260320-140000_outcome-based-spending-detection/PRD.md`
- `MEMORY/WORK/20260316-120000_protocol-agnostic-architecture-research/ARCHITECTURE-RECOMMENDATION.md`
- `MEMORY/WORK/20260316-120000_protocol-agnostic-defi-security-research/RESEARCH-REPORT.md`
- `MEMORY/WORK/20260312-190000_generic-constraints-deep-dive/PRD.md` (why granular was hard)

## Target end-state
```
agent-middleware/
  README.md                  ← what Sigil is + quickstart
  docs/
    MISSION.md               ← NEW canonical: mission + agnostic-assertion model (Step 2)
    ARCHITECTURE.md          ← verified vs code
    SECURITY.md / THREAT_MODEL.md  ← trimmed
    ERROR-CODES.md, DEPLOYMENT.md, COMMANDS-REFERENCE.md, ONCHAIN-FEATURE-INVENTORY.md
    research/                ← Lighthouse + ecosystem (golden-goose grounding)
    _archive/<date>/         ← everything in B/C
```
