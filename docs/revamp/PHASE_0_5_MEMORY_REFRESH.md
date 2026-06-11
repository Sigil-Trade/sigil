# Phase 0.5 — Memory Refresh Audit Trail

**Status:** Audit-trail-only doc. Not load-bearing for any phase decision.
**Created:** 2026-05-17
**Purpose:** Track the off-repo memory refresh that landed under Phase 0.5 Task 7.

> Memory files live outside this repo at `~/.claude/projects/-Users-kalebrupe/memory/` (per the L-6 narrow exception). Git cannot record those edits directly; this file records that the refresh happened, what it stripped, and how to verify.

---

## File refreshed

`~/.claude/projects/-Users-kalebrupe/memory/project_sigil_v2_revamp_briefing.md`

## What was stripped (per Phase 0.5 Task 7)

The pre-Phase-0.5 briefing was the 2026-05-16 strategic-pivot draft and contained claims now invalidated by Option A locks (L-1..L-15). The refresh removes:

| Stripped claim | Reason |
|---|---|
| "21 Tier A constraints" framing | Under Option A there is no fixed TA count. Final allocation = 18 active TA + 1 deleted (TA-16) + TA-18 categorized as off-chain. |
| "Mainnet 8-12wk post-audit" / "audit non-negotiable" | Per L-2: no audit, bug bounty, or funding gate in V1 scope. No mainnet timing in V2 scope. |
| C23 entries (T1 parser version fail-closed → TA-16) | Per L-1: tier model deleted; parser_version dropped. |
| C25 entries (TierRegistry signed config) | TierRegistry presupposed the tier model. |
| T1 / T2 / T3 references throughout | Per L-1: tier model fully removed. |
| Proposal status table tier annotations | Same; tier columns removed from the proposal-status entries. |

## What was added

- Option A direction header at top of file summarizing L-1..L-15.
- Locked anti-patterns expanded to include "tier model + parser_version" and "audit-gate / funding-gate language".
- Active TA primitives list (TA-01..TA-19 with TA-16 explicitly DELETED, TA-17/18/19 finalized).
- Pointer to canonical numeric error allocation at `docs/revamp/ERROR_CODE_ALLOCATION_V2.md`.
- Schema-math table (canonical per `HARDENED_V2_PROMPT_MAP.md §5`).
- Phase 0.5 completion log section.

## Verification

The refresh strips legacy claims by **converting them to explicit tombstones**, not by erasing the strings. Tombstones are required (they document the supersession). A naive grep for legacy-claim strings will therefore match tombstones and produce false positives.

Correct verification is contextual: search for legacy strings, then confirm each occurrence is wrapped in a supersession marker (`superseded`, `❌`, `OVERTURNED`, `struck per L-2`, or "see git history").

```sh
MEMFILE="$HOME/.claude/projects/-Users-kalebrupe/memory/project_sigil_v2_revamp_briefing.md"

# For each legacy phrase, show context and confirm a tombstone marker is present:
for phrase in "21 Tier A constraints" "Mainnet 8-12wk post-audit" "audit non-negotiable" "Tiers: T1" "three-tier"; do
  echo "=== $phrase ==="
  grep -B 1 -A 2 -E "$phrase" "$MEMFILE" || echo "(no match — also acceptable)"
done

# Required: Option A header markers MUST be present:
grep -E "Option A locks|L-1|L-15" "$MEMFILE"
```

A legacy phrase without a nearby `superseded` / `❌` / `OVERTURNED` / `struck per L-2` / "see git history" marker indicates a real leftover. A phrase with such a marker is the intended tombstone — no action required.

---

**END OF PHASE_0_5_MEMORY_REFRESH.md**
