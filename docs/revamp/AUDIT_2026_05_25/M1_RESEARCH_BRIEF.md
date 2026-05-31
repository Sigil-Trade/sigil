# M-1 Ecosystem Research Brief

**Purpose:** ground the M-1 Council R4 decision in evidence from how mature Solana protocols actually handle close-with-pending-state semantics. The R1-R3 Council debate produced a δ+γ verdict that lost user approval because it weighted cost (effort hours, schema bytes) as a tradeoff against security. The user's explicit rule: **security-first, no cost tradeoffs.** This brief seeds protocol research that will feed an expanded 7-voice Council R4.

---

## The M-1 problem (brief recap)

`close_vault.rs` in the Sigil program has 6 pending-PDA drain blocks. ONE class hard-fails when expected-but-missing (`pending_policy` via `policy.has_pending_policy: bool` flag). FIVE classes silently no-op via `lamports() > 0` guards:

- `pending_agent_perms[N]` (per-agent)
- `pending_close_constraints`
- `pending_owner` (Phase 8 SFH-01)
- `pending_agent_grant` (Phase 8 SFH-01)
- `pending_constraints` (CH-2 audit 2026-05-23)

The asymmetry was flagged by the silent-failure-hunter audit (2026-05-25) as a defense-in-depth gap.

## Threats the asymmetry enables

1. **Orphaned rent** on transient RPC outage during SDK enumeration. F-3 (already shipped) gave off-chain ERROR-level signal.
2. **Stale `pending_owner` / `pending_agent_grant`** at vault re-init seed-collision. Phantom ownership-rotation claim or phantom OPERATOR-class grant against a fresh vault. Could compound as new instructions read `pending_X.exists` as a proxy for "rotation in flight."
3. **Best-effort drain → future invariant trap.** Every "silently no-op" we ship becomes a CRITICAL if a downstream check decides to depend on the drain having succeeded.
4. **Audit-fatigue.** Next auditor sees the asymmetry and re-files M-1.

## Five options the Council R1-R3 considered

- **α — Full per-class lifecycle flags.** Add 4 bools to PolicyConfig + 1 byte per agent. Every queue/apply/cancel handler flips its flag. close_vault hard-fails uniformly. +14 bytes schema, ~15 handler edits.
- **β — On-chain enumeration in close_vault.** Discarded — Solana runtime blocks AccountInfo inspection of unpassed accounts.
- **γ — Caller-attested bitmask.** SDK enumerates + sets bits; close_vault validates. +2 bytes ix args. Pure caller-honesty defense.
- **δ — Hybrid.** Flags for state-protocol PDAs (`pending_owner`, `pending_agent_grant`), events for ephemerals. +2 bytes schema + new event schema.
- **ε — Status quo + structured docstrings.** No on-chain change.

R3 produced δ+γ as the cost-weighted compromise. **The user has rescinded that verdict because cost was a deciding factor.**

## Council R3 → R4 transition

R1-R3 had 5 voices: Jordan (Security), Ava (SDK), Sam (On-chain), Marcus (Architect), Riley (Ops). The R3 conditions for cross-camp acceptance crystallized around:
- Sam's `PendingGuard<T>` RAII helper (or Marcus's `PendingLifecycle` module) to neutralize the cancel-handler race
- Jordan's `PendingPdaClass` trait + CI exhaustiveness test to prevent contributor #7 drift
- Riley's `admin_clear_pending_flag` escape-hatch ix for desync recovery in α
- Marcus's bidirectional γ bitmask validation

R4 will add two voices:
- **SOLANA-VET** — channels mature protocol engineering practice (Squads/Drift/Marginfi/Mango etc.)
- **USER-VOICE** — actual Sigil end user with non-trivial vault, reasons about debug stories and recovery semantics under failure

R4 explicit decision rule (user-directed): **Top-notch security as the standard, no tradeoffs.** Cost/effort/schema-bytes/IDL-churn are documentation items, NEVER deciding factors. End-user experience is part of the security calculus (an unrecoverable footgun is not "more secure").

---

## Research questions for each protocol/audit/methodology

Each research agent should answer:

### A. Pattern characterization

1. **What pattern does this protocol use** for close-with-pending-state? Name the pattern (e.g. "discriminator state machine", "type-state programming", "lifecycle flags", "event-emit + off-chain reconciliation", "reference-counted close", "Lighthouse-style assertion lists", "account close via burn-discriminator").
2. **Cite the source code** — specific file:line ranges in the protocol's repo where the pattern lives.
3. **What does the close path actually enforce?** Hard-fail on missing pending state, silent skip, conditional based on lifecycle flag, runtime AccountInfo enumeration, refcount check, etc.

### B. Failure-mode catalog

4. **Has this protocol publicly shipped a bug** in this area? Search GitHub issues, audit reports, post-mortems. Specifically: orphaned-rent reports, flag-desync incidents, cancel-handler races, close-while-pending data losses.
5. **What is their on-chain enforcement vs off-chain monitoring split?** Do they rely on indexers/events or hard-fail at the program?
6. **What is the END USER recovery story** if their close path fails unexpectedly? Is there an admin escape, a refund mechanism, an immutable-state lockout?

### C. M-1 fit evaluation

7. **Would this protocol's pattern serve Sigil's M-1?** Yes/No/Partially.
8. **Security-first scoring.** Set aside cost. Rate this pattern on:
   - **Defense-in-depth strength** (1-5): can an attacker subvert the pattern via state corruption, partial-failed ix, monitoring layer failure, future-class-invariant introduction?
   - **End-user recovery** (1-5): is there an on-chain recovery path if state desyncs?
   - **Auditor onboarding** (1-5): how readable is the pattern to a new auditor — does the design self-document?
   - **Long-term consistency** (1-5): does the pattern scale to N pending-PDA classes without judgment-call drift?

### D. Audit report mining (for the audit miner specifically)

9. List every published audit finding on Solana programs related to: pending-state lifecycle, close-while-pending, flag-desync, cancel-races, orphaned-rent. Severity, protocol, year, remediation pattern adopted.
10. Identify systemic patterns across reports — what types of bugs keep recurring?

### E. Pattern catalog (for the synthesizer specifically)

11. Catalog every distinct pattern surfaced by Phases A-D.
12. Per pattern: exemplar protocols, defense-in-depth profile, end-user recovery profile, M-1 fit, security-first ranking.
13. Identify ANY pattern not yet considered in the R1-R3 Council option set. If a sixth (or seventh) option exists in the ecosystem that beats α/δ/γ/ε on pure security, surface it.

---

## Output format

Each research agent produces a structured Markdown report. Length scales with depth (Phase A: 800-1200 words; Phase B: 400-600 words; Phase C audit miner: 600-1000 words; Phase D formal methods: 500-800 words; Phase E synthesizer: 1500-2500 words including pattern catalog).

Path convention: `docs/revamp/AUDIT_2026_05_25/research/M1_<PROTOCOL>.md` for protocol agents.

Each report MUST include:
- "## Pattern" (named pattern + citations)
- "## Failure history" (bugs, audit findings)
- "## End-user recovery story"
- "## M-1 fit verdict" (Yes/No/Partial + reasoning)
- "## Security-first scores" (4 ratings, 1-5 each)
- "## Recommendation for Sigil M-1" (concrete, opinionated)

Use direct citations to GitHub repos, audit PDFs, blog posts. Verify file:line accuracy where possible. Where ambiguity exists, flag as such — speculative claims fail the council's adversarial-verification standard.

---

## What NOT to do

- Do NOT recommend based on engineering cost. Cost is documentation, not a vote.
- Do NOT default to "what would be easiest to implement." The question is "what gives Sigil's end user the strongest on-chain guarantee."
- Do NOT cite training-data hearsay. Every architectural claim about another protocol must come with a source link (GitHub commit, audit report URL, official docs).
- Do NOT pad word count. Direct, evidence-backed observations only.
