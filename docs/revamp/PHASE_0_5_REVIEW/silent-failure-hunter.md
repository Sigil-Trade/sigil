# Phase 0.5 §RP — silent-failure-hunter transcript

**Date:** 2026-05-17
**Phase:** 0.5 — Doc consolidation + harvest deltas
**Dispatched from:** main orchestrator thread (Engineer subagent context lacked the Agent tool needed to dispatch pr-review-toolkit subagents directly; main thread invocation pattern adopted from this phase forward)
**Tool:** `pr-review-toolkit:silent-failure-hunter`
**Phase commits at time of review:** `78f0bbe` + `3845c98` + `125fa54` + `630839a`
**Verdict:** FIX-AND-RETEST → 2 HIGH findings, both fixed in `d385bcc`

---

## Scope sent to the agent

The orchestrator dispatched §RP with 7 attack vectors targeting Phase 0.5's specific scope:

1. Memory file tombstones vs active claims
2. Cross-doc broken refs to deleted V1 paths
3. ERROR_CODE_ALLOCATION_V2.md numeric integrity
4. TA-NN naming hygiene completeness (TA-16 deletion + TA-17/18/19 LOCKED)
5. L-6 scope creep
6. Body-level tier language remaining (deferred to Phase 1 per scope amendment in commit `49981cd`)
7. PHASE_0_5_MEMORY_REFRESH.md placement + content

---

## Findings

### HIGH-1 — INTERFACES_V2.md preamble contradicts canonical compaction strategy

**File:** `docs/revamp/INTERFACES_V2.md:244`

**Active claim:** "V2 reservation table (6078-6102 — **assumes deprecation placeholders preserving stable codes**):"

**Contradiction:** `ERROR_CODE_ALLOCATION_V2.md` (canonical) explicitly assumes the **compaction** strategy (§3 + §6). Under compaction, the 6078-6102 reservation is correct. Under deprecation placeholders, the range shifts to 6081-6105 because V1 keeps 6000-6080 with deprecated stubs.

The commit `630839a` had updated ERROR_CODE_ALLOCATION_V2 to declare compaction but did not propagate the strategy label to INTERFACES_V2.

**Disposition:** RESOLVED in commit `d385bcc`. INTERFACES_V2.md:244 preamble rewritten:
> "V2 reservation table (6078-6102 — assumes the *compaction* strategy per [ERROR_CODE_ALLOCATION_V2.md §3](./ERROR_CODE_ALLOCATION_V2.md). If Phase 1 chooses deprecation placeholders instead, this entire range shifts to 6081-6105 per §2 of the canonical doc):"

---

### HIGH-2 — PHASE_0_5_MEMORY_REFRESH.md verification script encodes false-positive alarm

**File:** `docs/revamp/PHASE_0_5_MEMORY_REFRESH.md:42-46`

**Defect:** The verification grep `grep -Ei "21 Tier A constraints|Mainnet 8-12wk post-audit|audit non-negotiable|C23\b|C25\b" "$MEMFILE"` would produce matches because the memory file contains all three phrases as **explicit tombstones** (memory:11, 33, 34, 168 — verified). A future reader running the verification would be told the refresh failed when it actually succeeded.

**Disposition:** RESOLVED in commit `d385bcc`. Verification block rewritten to be context-aware:

```sh
for phrase in "21 Tier A constraints" "Mainnet 8-12wk post-audit" "audit non-negotiable" "Tiers: T1" "three-tier"; do
  echo "=== $phrase ==="
  grep -B 1 -A 2 -E "$phrase" "$MEMFILE" || echo "(no match — also acceptable)"
done
```

Plus explanatory text: "A legacy phrase without a nearby `superseded` / `❌` / `OVERTURNED` / `struck per L-2` / 'see git history' marker indicates a real leftover. A phrase with such a marker is the intended tombstone — no action required."

---

## Attack vector scorecard (PASS/FAIL with evidence)

| # | Vector | Verdict |
|---|---|---|
| 1 | Memory file active claims vs tombstones | **PASS** — all 4 hits at memory:11/33/34/168 are explicit tombstones |
| 2 | Cross-doc broken refs to deleted V1 docs | **PASS** — every reference is a "see git history — deleted" tombstone or audit-trail listing |
| 3 | ERROR_CODE_ALLOCATION_V2.md numeric integrity | **PASS** — 81 variants confirmed; first `VaultNotActive`@6000, last `InvalidDestinationMode`@6080; 5/5 spot-checks match source line numbers |
| 4 | TA-16 deletion / TA-17/18/19 hygiene | **PASS** — TA-16 marked DELETED at INTERFACES_V2.md:100-101; TA-17 has AgentEntry placement + 3-20 threshold + SigilError filter; TA-18 marked OFF-CHAIN ONLY in 4 places; TA-19 specified as SHA-256 canonical-encoded on both PolicyConfig + PendingPolicyUpdate |
| 5 | L-6 scope creep | **PASS** — `git diff --name-only` shows every path inside `agent-middleware/docs/`; memory file at `~/.claude/projects/...` per L-6 narrow exception |
| 6 | Body-level tier language deferral | **PASS (deferred correctly to Phase 1 task 3)** — REVAMP_PLAN (64 hits), THREAT_MODEL (27 hits), ACCEPTANCE (12 hits) explicitly owned by Phase 1 per HARDENED_V2_PROMPT_MAP.md:432-444 |
| 7 | PHASE_0_5_MEMORY_REFRESH.md placement + content | **FAIL** — see HIGH-2 |

---

## Verdict: FIX-AND-RETEST → RESOLVED

Both HIGH findings closed by commit `d385bcc`. Re-verify pass confirmed:
- INTERFACES_V2.md preamble aligned with canonical compaction strategy ✓
- Verification block rewritten with context-aware tombstone detection ✓
- No further §RP findings outstanding for Phase 0.5

**Cleared for Phase 0.6 dispatch.**

---

**END OF Phase 0.5 silent-failure-hunter transcript**
