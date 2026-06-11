# M1-05 — Decouple + Promote Existing Agnostic Primitives to First-Class

**Milestone:** M1 · **Depends on:** M1-04 · **Status:** PLAN

## Why
With the parsing engine gone, the agnostic core (~80% already built) becomes Sigil's *sole* enforcement story. This item elevates the existing, shipping primitives to first-class, clearly-named, independently-tested units — and decouples anything that was entangled with the removed engine. No new capability here (that's M2); this is consolidation so the base is clean and auditable.

## The existing agnostic primitives to formalize (CONFIRMED in code, this session)
- **Balance-delta sandwich** (`finalize_session.rs:240-498`) — the engine; measures real spend from raw post-CPI token deltas, caps on the measured number. This IS the production-proven pattern (Kamino/Raydium-CLMM/Drift confirmed). Formalize + document as the core.
- **MintDeltaCap** (`post_assertion_helpers.rs:31-65`), **AtaAuthorityPin** (`:69-102`), **OutputBalanceFloor** (`:116-161`) — already fixed-offset, agnostic.
- **Stable-balance floor TA-12** (`finalize_session.rs:665-720+`), **per-recipient cap TA-14** (`:526-663`).
- **Stablecoin value-proxy** (`state/mod.rs:537-544`).

## Scope (this item)
1. **Decouple from removed engine:** ensure no post-assertion primitive still imports from a deleted constraints file (the relocated `ct_eq_32`/`ConstraintOperator`/`bytes_match` from M1-04 should already cover this — verify).
2. **Promote `DeclarationConsistency` (§7 Q2 — LOCKED repurpose):** keep the agnostic (recipient, mint) owner-match; DROP the protocol-coupled account-meta-index dependency (its own docstring admits ix-data-routed protocols bypass it). Re-verify in `post_assertions.rs` / `post_assertion_helpers.rs` at build start.
3. **Confirm program-ID allowlist (§7 Q3 — LOCKED keep):** `is_recognized_defi` + protocol allowlist stay as the call-graph-control layer (research confirmed: load-bearing compromised-agent backstop; covers Layer-2's blind spot). No change beyond confirming it survived the teardown intact.
4. **First-class destination-assertion** (ties to M1-01's fix B): make the destination check an always-on part of finalize, not optional.
5. **Naming/structure pass:** group the agnostic primitives so an auditor reads the enforcement model in one place. No behavior change.

## Decision to lock at design-review
Whether to physically reorganize files (e.g., a `state/assertions.rs` / `utils/assertions/` module) or just rename/document in place. Recommendation: minimal reorg — relocate the M1-04 shared helpers there and co-locate the assertion primitives, but don't churn the sandwich itself.

## Tests
- Re-run all existing post-assertion + sandwich + cap + allowlist tests; all green (behavior unchanged except DeclarationConsistency repurpose + destination always-on).
- NEW: DeclarationConsistency with an ix-data-routed destination → now still enforced via owner/mint match (the old bypass closed).
- NEW: destination-assertion is enforced even when not explicitly configured (always-on).

## DoD
Agnostic primitives consolidated + documented as the sole enforcement model; DeclarationConsistency repurposed; allowlist confirmed intact; destination-assertion always-on; full suite green; adversarial review; pipeline complete.

## Risks
- "Promotion" tempts scope creep into M2. Hard line: NO new assertion types here — only formalize/decouple/repurpose what exists.
- DeclarationConsistency repurpose changes a check's semantics → cover with the ix-data-routed test.

## Anti-criteria
- No new primitive added (M2 scope).
- No caller-supplied offsets introduced.
- No behavior change to the balance-delta sandwich itself.
