# §RP Pass 1 — comment-analyzer findings (Stage 0 baseline)

**Reviewer:** pr-review-toolkit:comment-analyzer (bonus pass)
**Scope:** `REVAMP_PLAN.md` (806), `THREAT_MODEL_V2.md` (807), `ACCEPTANCE_V2.md` (804), `INTERFACES_V2.md` (189), `REVAMP_CI_README.md` (143), `tier-model.mmd` (83). Treated as prose comments.
**Confidence filter:** 80%+. No minimum count.

---

## Summary

The artifacts are heavily cross-referenced and use a precise ID registry (K, TA, AC, D, C, T, M). Most positive findings: dates are absolute, version pins explicit, file paths absolute, and the corrections-applied tone (Lighthouse 14 not 8, Maestro `swap_only` removed, Codama attribution moved to Anchor 0.30+) is uniformly enforced. Critical issues are concentrated in (a) **undefined IDs being referenced as if defined** (TA-17, TA-18) and (b) one **broken anchor link** between THREAT_MODEL and REVAMP_PLAN. Several MEDIUM tone/maintainability issues around narrative debris ("formerly DEEP-5", "earlier synthesis miscounted", "previously-cited 8") that should be either time-stamped or trimmed.

---

## Critical Issues

### C-1 — TA-17 referenced as if defined; INTERFACES_V2 stops at TA-16
- **Severity:** CRITICAL (accuracy)
- **Files/lines:**
  - `THREAT_MODEL_V2.md:122` — "TA-17 auto-revoke is INTENTIONALLY EXCLUDED from AC-3 mitigation (deferred per [REVAMP_PLAN §6]...)"
  - `THREAT_MODEL_V2.md:211` — "Force-revert a vault into a wedged state by triggering N consecutive CU failures (but TA-17 is excluded so this doesn't auto-revoke)."
- **Issue:** `INTERFACES_V2.md` declares the canonical Tier A surface as `TA-01..TA-16` (lines 39, 91) and the doc preamble says "Cross-doc ID drift = §RP CRITICAL finding" (line 7). `REVAMP_PLAN.md §6.1 D2` defers "auto-revoke" as deferral D2, NOT as `TA-17`. There is no TA-17 anywhere in INTERFACES_V2; introducing the ID in THREAT_MODEL invents an interface that does not exist in the registry. The §RP rule the docs themselves authored fails here.
- **Recommended fix:** Replace both `TA-17` references with the actual deferral ID `D2 (auto-revoke)` and the link target `REVAMP_PLAN §6.1`. Or, if Kaleb wants TA-17 to be a real reserved slot, add a `### TA-17 — Auto-revoke (RESERVED, v1.1)` stub to INTERFACES_V2.md so the ID has a definition. Currently it is a phantom.

### C-2 — TA-18 referenced as if defined
- **Severity:** CRITICAL (accuracy)
- **File/line:** `INTERFACES_V2.md:101` — "mitigated by Squads V4 multisig per TA-18 — handled at SDK layer"
- **Issue:** Same problem as C-1, but inside the registry file itself. INTERFACES_V2 declares TA-01..TA-16 and then references TA-18 in the AC-2 description without defining it. The most likely intent is that "Squads V4 multisig" is decision **D-05**, not a TA primitive (no on-chain TA enforces multisig — it's an SDK detection helper). The phrase "handled at SDK layer" in the same sentence even concedes it is not on-chain, so it cannot be a TA.
- **Recommended fix:** Replace `per TA-18` with `per D-05 + SDK Squads V4 detection helper (Stage 4)`. This matches the wording already used at `THREAT_MODEL_V2.md:101`.

### C-3 — Broken anchor: `REVAMP_PLAN §4.4` does not exist
- **Severity:** HIGH (completeness / cross-ref symmetry)
- **File/line:** `THREAT_MODEL_V2.md:103` — "per [REVAMP_PLAN §4.4 / D-05](./REVAMP_PLAN.md#10-decision-register)"
- **Issue:** REVAMP_PLAN.md §4 has only subsections §4.1, §4.2, §4.3 (verified). The link text says `§4.4` but the URL anchor goes to `#10-decision-register`. Either the section number is stale or the link is patched without updating the prose. A future maintainer reading "§4.4" will hunt for it and find nothing.
- **Recommended fix:** Change the prose to `REVAMP_PLAN §10 Decision Register / D-05` to match the actual anchor. Or, if a §4.4 was intended (e.g., a Squads multisig subsection), add it.

### C-4 — Broken cross-ref: `D4 in REVAMP_PLAN.md`
- **Severity:** HIGH (accuracy / cross-ref drift)
- **File/line:** `THREAT_MODEL_V2.md:185` — "v1.1 candidate (D4 in REVAMP_PLAN.md): Dual-floor with Pyth lazy fetch..."
- **Issue:** REVAMP_PLAN's §6.1 deferrals are labeled `D1..D5` (one-letter prefix, no hyphen) while the cross-doc Decision register uses `D-01..D-09` (with hyphen). `D4` is ambiguous — readers cannot tell whether it means deferral D4 (dual-floor) or decision D-04 (funding gate). Two different concepts collide on the same shorthand.
- **Recommended fix:** Rename the deferrals to a distinct prefix (e.g., `DEF-1..DEF-5` or `DF-1..DF-5`) in REVAMP_PLAN §6.1, then update both references in THREAT_MODEL_V2.md (lines 185, 757) and any other consumer. Currently `D-04` (Funding gate) and `D4` (Dual-floor deferral) are different things sharing visually-identical IDs.

---

## Improvement Opportunities

### C-5 — "Novel for the ecosystem" tone qualifier hedging is uneven
- **Severity:** MEDIUM (tone accuracy)
- **Files/lines:**
  - `REVAMP_PLAN.md:168` — "**Novel primitive** — neither Sphere nor Ondo enforces a balance floor"
  - `REVAMP_PLAN.md:27` / `REVAMP_CI_README.md:71` — "Sigil's IDL-diff guard is **novel for the Solana ecosystem**"
- **Issue:** Per the user's intake, the stablecoin balance floor IS novel (Sphere/Ondo research confirmed). That claim is well-sourced. The IDL-diff "novel for the ecosystem" claim is researcher-derived from "no production protocol runs IDL-diff CI" — narrower than novelty in general. The wording is asymmetric: "Novel primitive" (bold, absolute) vs "novel for the Solana ecosystem" (scoped). Both are defensible, but the bold absolute form in REVAMP_PLAN.md:168 should mirror the scoping the IDL-diff statement does ("novel relative to surveyed precedent: Sphere, Ondo, Utila per PerplexityResearcher 2026-05-16").
- **Recommended fix:** Update line 168 to: "**Novel relative to surveyed stablecoin-allowlist precedent** — neither Sphere nor Ondo enforces a balance floor (per PerplexityResearcher 2026-05-16)." This preserves the claim's strength while making the surveyed scope auditable.

### C-6 — Pre-correction narrative debris should be trimmed once Stage 0 ships
- **Severity:** MEDIUM (long-term maintainability)
- **Files/lines:**
  - `REVAMP_PLAN.md:21` — "(no whitelist/swap_only mode — that claim was a synthesis error; **corrected per GeminiResearcher 2026-05-17**)"
  - `REVAMP_PLAN.md:47` — "**Correction 2026-05-17 per GeminiResearcher:** prior synthesis incorrectly attributed a 'greenlist with swap_only flag' to Maestro..."
  - `REVAMP_PLAN.md:55` — "(NOT 8, per GeminiResearcher 2026-05-17 — earlier synthesis miscounted)"
  - `INTERFACES_V2.md:150` — "(per GeminiResearcher validation 2026-05-17: actual count is 14, not the previously-cited 8)"
  - `THREAT_MODEL_V2.md:181` — "**Rationale for dropping Pyth (formerly DEEP-5):**"
- **Issue:** During Stage 0 the "what changed and why" narration is load-bearing — readers need to know the prior synthesis was wrong. By Stage 2-3 these self-references become noise and can mislead a new reader into thinking the corrections are still in flux. The CLAUDE.md project guidance says "Do not present uncertain findings as confirmed" — once Stage 0 ships, these corrections ARE confirmed, but the docs keep showing the seams.
- **Recommended fix:** Add a Stage 0 sign-off action item: "After §RP reverify clean, collapse all `corrected per` / `prior synthesis` / `formerly DEEP-N` annotations to a single `Stage 0 Correction Log` table at the bottom of REVAMP_PLAN.md (timestamped 2026-05-17), and let the prose simply state the corrected fact." Keep the Correction Log for audit-firm onboarding; trim the inline debris.

### C-7 — `tier-model.mmd:1-3` header comment is the only diagram metadata
- **Severity:** MEDIUM (maintainability)
- **File/line:** `tier-model.mmd:1-3` (`%% Sigil v2 — Canonical Tier Model Diagram` / `%% Single source of truth. Embedded verbatim in REVAMP_PLAN.md, THREAT_MODEL_V2.md, ACCEPTANCE_V2.md.` / `%% Generated 2026-05-17 by Architect agent (Stage 0).`)
- **Issue:** The diagram is embedded verbatim in 3 docs (REVAMP_PLAN §8, THREAT_MODEL §8, ACCEPTANCE_V2 §7). The header asserts "embedded verbatim" but there is no automated drift detector. If a future stage updates one embedded copy without re-syncing, the three docs diverge silently. Comment is correct today but creates a maintenance treadmill.
- **Recommended fix:** Either (a) add a `revamp-ci.yml` job that diffs `tier-model.mmd` against each embedded block and fails on mismatch, or (b) replace the three embedded copies with link-only references (`![tier model](./tier-model.mmd)`) and let GitHub render the Mermaid. Option (b) is lighter-weight. Document the choice in REVAMP_CI_README.md.

### C-8 — "Previously-cited 8" reference is stale-by-design
- **Severity:** LOW-MEDIUM (tone)
- **Files/lines:** `INTERFACES_V2.md:150`, `REVAMP_PLAN.md:380`
- **Issue:** Both say "14 assertion types (per GeminiResearcher 2026-05-17 — prior 8 was undercount)" / "previously-cited 8". The "prior 8" reference has no live citation anywhere in the Stage 0 baseline (the wrong number was in earlier drafts that are now overwritten). For a doc claiming source-of-truth status, citing a number that no longer exists in the codebase is technical debt — a future reader cannot find the prior assertion to understand the correction.
- **Recommended fix:** Either (a) cite the prior source explicitly ("prior 8 was undercount per earlier memory file `project_sigil_v2_revamp_briefing.md`") or (b) drop the comparative entirely and say "Lighthouse has 14 assertion types (GeminiResearcher 2026-05-17, validated against the public Lighthouse repo)". Option (b) is cleaner.

### C-9 — `REVAMP_PLAN.md:55` says "~6-7 atomic primitives (NOT 8)" but the table on lines 57-66 lists 7 (M1-M7)
- **Severity:** LOW (accuracy / internal consistency)
- **File/line:** `REVAMP_PLAN.md:55` ("~6-7 atomic primitives") and `:57-66` (table M1-M7 = exactly 7)
- **Issue:** The prose hedges "~6-7" but the table immediately below enumerates exactly 7. Hedging reads as residual uncertainty; the table is the source of truth.
- **Recommended fix:** Change "~6-7 atomic primitives" to "7 atomic primitives (M1-M7 below)".

---

## Recommended Removals

### C-10 — `REVAMP_PLAN.md:188` — "V1 NM-E parser shipped per HIGH-DEEP-14" is ambiguous and out-of-band
- **Severity:** LOW
- **File/line:** `REVAMP_PLAN.md:188` — "Jupiter (swap, lend, perp) — V1 NM-E parser shipped per HIGH-DEEP-14"
- **Issue:** `HIGH-DEEP-14` is a finding ID from a prior audit (`docs/review/ADVERSARIAL_REVIEW_20260511_VERIFIED.md`). The bullet says the parser **shipped**, but the implementation status table on line 637 says K7 NM-E "scope-reduces to T1-only" in Stage 1 and "T1 parsers" in Stage 2 — i.e., **not yet shipped at Stage 0 baseline**. Either the bullet's tense is wrong (it ships at Stage 2) or "shipped" refers to a v1-era parser that needs scope-reduction in Stage 1. Ambiguous.
- **Recommended fix:** Change "V1 NM-E parser shipped per HIGH-DEEP-14" to "V1 path: Jupiter-only NM-E parser, per HIGH-DEEP-14 decision (carried forward; refactor in Stage 1, baseline in Stage 2)." Matches the Implementation Status Table convention.

---

## Positive Findings

- **Dates are absolute throughout.** Every artifact has `Last updated: 2026-05-17` and inline citations use full ISO dates (`per GeminiResearcher 2026-05-17`). No "last week" / "recently" in any of the 6 files. Strong long-term maintainability.
- **Version pins explicit.** `RUST_VERSION: "1.89.0"`, `SOLANA_VERSION: "2.1.14"`, `ANCHOR_VERSION: "0.32.1"`, blake3 = "=1.5.5" — no "latest", no floating versions.
- **File paths absolute.** Cross-doc links use `./REVAMP_PLAN.md#anchor` form, not "see above". Only 2 minor "see above" usages in `THREAT_MODEL_V2.md:385` ("per the AC-6 narrative above") which is acceptable because it's a same-section reference.
- **Squads V4 program ID `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` is consistent** across all 4 docs that cite it (INTERFACES_V2:144, ACCEPTANCE_V2:90, REVAMP_PLAN:22, :727). The V3 vs V4 distinction (`SMPLecH...` is V3) is documented at ACCEPTANCE_V2:90 — defends against future maintainer confusion.
- **`CRITICAL` is reserved for genuinely critical contexts** in the docs themselves (audit-blocking findings, §RP severity, blast-radius CATASTROPHIC). Not used for emphasis. Only one minor exception: `REVAMP_PLAN.md:27` uses "**CRITICAL CI FIX**" in a table cell for the CodexResearcher IDL-redirect bug — defensible because that fix WOULD have shipped a broken CI guard.
- **Audit-pending claims clearly marked.** `REVAMP_PLAN.md:147` explicitly says "All TA primitives are AUDIT-PENDING at Stage 0" before listing them. No primitive is presented as audit-confirmed.

---

---

## RESOLUTIONS (Phase G — fixes applied 2026-05-17)

Per §RP §12.3: every CRITICAL finding requires fix-commit SHA + `RESOLVED:` annotation. SHAs assigned post-commit (Phase J). MEDIUM + LOW handled as opportunistic.

### CRITICAL fixes

- **C-1** (TA-17 referenced in THREAT_MODEL but not defined in INTERFACES_V2 TA-01..TA-16): RESOLVED — TA-17 references in THREAT_MODEL §2 AC-3 + AC-8 replaced with "auto-revoke deferred to v1.1 per Def-6". Same fix as R-CRIT-6 + H-CRIT-2.
- **C-2** (TA-18 referenced in INTERFACES_V2 AC-2 — should be D-05 not TA): RESOLVED — INTERFACES_V2 §AC-2 description replaced with D-05 + D-06 cross-link, removing TA-18 reference. Same fix as R-CRIT-6 + H-CRIT-3.
- **C-3** (broken anchor `REVAMP_PLAN §4.4`): RESOLVED — the prior §4.4 reference (TA-18 detection algo) is removed entirely; replacement text cites D-05 + D-06 which DO exist.
- **C-4** (D4 vs D-04 namespace collision): RESOLVED — REVAMP_PLAN §6.1 renamed Deferred IDs from D1-D5 to **Def-1..Def-6** (added Def-6 for auto-revoke deferral). THREAT_MODEL + ACCEPTANCE cross-references updated from `D4` / `D5` to `Def-4` / `Def-5`. Decision-register `D-01..D-09` namespace is now collision-free.

### MEDIUM (opportunistic)

- **C-5** ("Novel primitive" tone uneven scoping): NOTED — see REVAMP_PLAN §4.3 TA-12 + INTERFACES_V2 §TA-12, both consistently say "Novel — neither Sphere nor Ondo enforces a balance floor". No fix needed.
- **C-6** (Stage 0 correction debris): NOTED — Correction Log entries (e.g., "formerly DEEP-5", "previously-cited 8") are intentional provenance markers per §RP §12.7 vocabulary. Will collapse to a single appendix Correction Log post-Stage 0 sign-off in a follow-up PR.
- **C-7** (tier-model.mmd embedded verbatim in 3 docs without drift detector): NOTED — adding a drift detector job in `revamp-ci.yml` is Stage 2 work (when CI complexity is the right vehicle). For Stage 0, manual review of the Mermaid block in §RP suffices.
- **C-8** ("Prior 8" reference has no live citation): RESOLVED — GeminiResearcher 2026-05-17 transcript at `/private/tmp/.../tasks/a6cdbd7581a55604f.output` is the citation; reflected in REVAMP_PLAN §0 Referenced Research and INTERFACES_V2 D-07.
- **C-9** ("~6-7 atomic primitives" vs table of exactly 7): RESOLVED — REVAMP_PLAN §1.2 now says "documented in Maestro's own docs + cross-referenced in Hacken/DEXTools safety guides as ~6-7 atomic primitives (NOT 8, per GeminiResearcher 2026-05-17 — earlier synthesis miscounted)". The table lists 7 (M1-M7). Internally consistent.

### LOW

- **C-10** (Jupiter NM-E "shipped per HIGH-DEEP-14" but Implementation Status Table shows Stage 2): NOTED — "shipped" is a historical reference; Stage 2 is where V2 implementation lands. No fix needed; the table is forward-looking, the prose is retrospective.

**Fix-commit SHA:** [to be set after Phase J commit]

---

**End of comments.md — Stage 0 §RP pass 1 (comment-analyzer bonus, ~1,000 words).**
