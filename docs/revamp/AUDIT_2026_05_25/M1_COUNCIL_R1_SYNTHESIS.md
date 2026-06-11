# M-1 Council — Round 1 Synthesis

Five voices, three positions. Read this before Round 2.

---

## Final R1 vote tally

| Voice | Perspective | R1 Vote |
|---|---|---|
| **Jordan** | Security Pentester | **α** (full flags) |
| **Ava** | Off-chain SDK Engineer | **γ** (caller-attested bitmask) |
| **Sam** | On-chain Anchor Engineer | **δ** (hybrid) |
| **Marcus** | Protocol Architect | **α** (full flags) |
| **Riley** | Operational Monitor | **δ** (hybrid) |

α: 2 — γ: 1 — δ: 2 — ε: 0

---

## Verbatim positions

### JORDAN — Security Pentester → α

> "On-chain symmetric drain matters MORE than the brief frames it. F-3's off-chain ERROR signal is a monitoring layer, and monitoring layers fail. The asymmetry isn't bookkeeping; it's a phantom-claim attack surface that compounds as the protocol matures. Pre-mainnet is the only window where the schema cost is free. Pay it now."
>
> Recommendation: **α**. "δ is tempting and almost right, but its 'ephemeral vs state-protocol' split is a judgment call that the NEXT attacker (or auditor) will re-litigate. Uniform hard-fail across all 6 classes removes the judgment call entirely. +14 bytes total schema and ~15 handler edits is rounding error pre-mainnet."
>
> Top concerns: **PDA seed-collision at re-init** (`pending_owner` / `pending_agent_grant` phantom claims on close→reinit), **best-effort drain is a future-class trap** (same pattern that produced TA-12).
>
> Undervalued by others: "Off-chain SDK and Ops voices will argue F-3 already solved this — they are NOT reasoning about the threat model 6 months from now, when some new instruction reads `pending_owner.exists` as a proxy for 'owner-rotation in flight' and an attacker exploits the close-vault skip to forge that state. On-chain enforcement is the cheap insurance against invariants you haven't written yet."

### AVA — Off-chain SDK Engineer → γ

> "The on-chain asymmetry matters less than the council thinks. F-3 already gave us symmetric ERROR-level surfacing across all 6 PDA classes — integrators now have ground truth without paying schema or CU costs. Adding on-chain flags duplicates state that the SDK already enumerates correctly, and creates two sources of truth that will drift."
>
> Recommendation: **γ**. "γ is the only option that respects the F-3 invariant (SDK is the authoritative enumerator) while giving the on-chain layer a check. The bitmask is *derived from* the SDK enumeration we already do — no new schema, no flag-flip ceremony across 15 handlers, no per-agent byte tax. Yes, an attacker controlling the SDK can lie — but an attacker controlling close_vault's caller can already grief themselves; this isn't a security boundary, it's a correctness check."
>
> Top concerns: **α forces an SDK major version bump** (+14 bytes touches every consumer), **δ creates the worst SDK surface** (two drain semantics = protocol-internal knowledge leaking into public API).
>
> Undervalued by others: "F-3's ERROR-level signal already gives ops a 5-second SLA to detect orphaned pending PDAs before any re-init could occur. The window for the attack is the gap between close and re-init — measured in human-scheduled minutes, not adversarial milliseconds. SDK-layer monitoring closes that window cheaper than schema migration."

### SAM — On-chain Anchor Engineer → δ

> "The asymmetry isn't a bug we accidentally shipped — it's the data model honestly reflecting two different lifecycles. `has_pending_policy` exists because `apply_pending_policy.rs` actually reads it. The other 5 PDAs have no off-handler reader. Adding 4 bools to PolicyConfig + 1 byte × 10 agents to AgentVault to fake state that nothing else consults is over-engineering dressed as symmetry."
>
> Recommendation: **δ**. "Flag the two that have real protocol-state collision risk (`pending_owner`, `pending_agent_grant` — both already flagged by SFH-01). Event-emit the three pure-ephemeral classes. PolicyConfig +2 bytes only. ~6 handlers touched, not 15."
>
> Top concerns: **handler-coupling combinatorics under α** (15 handlers × 3 paths = 45 flag-flip sites; each cancel path that forgets to reset the flag permanently bricks close_vault), **schema-growth tax on auditor onboarding** (we just stabilized at 1,290/634 across 361 LiteSVM tests).
>
> Undervalued by others: "The Pentester will fixate on PEN-CROSS-2 PDA-collision residue and push α for 'completeness.' They'll undervalue that the `cancel_*` handler family in α becomes a NEW attack surface — any cancel path that forgets `policy.has_pending_X = false` permanently bricks `close_vault`. I've shipped vaults bricked by exactly this. δ contains the blast radius to two handlers I can audit in an afternoon."

### MARCUS — Protocol Architect → α

> "This is not incidental. The brief admits it plainly — 'close_vault picked up the silent-skip pattern incrementally as new pending PDA classes were added.' That is the definition of drift: two PDA classes became five without anyone re-examining the original pattern. In V3 it becomes ten. By V4 we have a pending-PDA factory and no contributor remembers why one class hard-fails and the others don't."
>
> Recommendation: **α**. "Not γ (security smell — we don't let callers attest to protocol state when the protocol can track it itself). Not δ (the 'right-sized hybrid' is exactly the trap: the NEXT contributor adding pending-PDA class #7 has to make a judgment call between 'state-protocol' vs 'ephemeral' — they will get it wrong, and we get M-2 in 2027). Not ε (codifying inconsistency as doctrine guarantees it propagates). α gives ONE rule: every pending PDA has a flag, every queue/apply/cancel flips it, close_vault hard-fails uniformly."
>
> Top concerns: **mental-model entropy** (two patterns in one handler today means four patterns in two handlers tomorrow), **pre-mainnet is the ONLY window** (after mainnet, adding `has_pending_close_constraints` is a versioned-account-migration project).
>
> Undervalued by others: "Stale `pending_owner` after vault re-init is a class of bug that re-emerges with every new pending PDA we add silently. The SDK engineer will frame F-3 off-chain remediation as 'sufficient' — but off-chain logs don't enforce protocol invariants, they observe violations after the fact. PolicyConfig is already 1,290 bytes — +4 bytes is rounding error compared to the architectural debt of asymmetric drain semantics living forever in the protocol's foundational close path."

### RILEY — Operational Monitor → δ

> "The asymmetry costs me observability, not correctness. F-3 gave me symmetric ERROR logs in CloudWatch — fine, I'll wire PagerDuty to them. But CloudWatch logs are observable only to people who pay for the log group. On-chain events are observable to every indexer on the planet — Helius webhooks, our own Geyser, the auditor running their own RPC, the customer's SOC team."
>
> Recommendation: **δ**. "Flags for `pending_owner` and `pending_agent_grant` because those PDAs enable collision-on-reinit threats — I want hard-fail, not 'noticed eventually.' Events (`PendingPdaDrained`) for the three ephemeral classes because I don't need to *block* the close, I need to *see* the drain. An emitted event is indexable, queryable, alertable, and survives forever in the ledger. A silent `break` in a Rust loop is invisible to every dashboard I own."
>
> Top concerns: **indexer cost & alert wiring** (events need Geyser filter update + Grafana panel; one-time cost), **caller-attestation in γ is a trap** (SDK is owned by the same team that ships bugs; if the SDK lies or has a bug setting bitmask, close_vault accepts the lie, pager stays quiet, orphan rent accumulates silently).
>
> Undervalued by others: "The Architect will frame δ as 'inconsistent' (flags for some, events for others). I'm telling you inconsistency in the design is fine if it produces consistent observability in production. The SDK engineer will love γ because it's clean code. Clean code that depends on the SDK being honest is exactly the failure mode F-3 just fixed. The Pentester will focus on collision threats and may push α for uniformity — but α adds 14 bytes and 15 handler edits for ephemeral classes where the threat is '$0.0008 orphan rent.' Wrong cost/benefit."

---

## Cross-position tensions (for R2 to resolve)

**T1. Is F-3 sufficient?**
- Ava: yes, on-chain change is duplicative
- Riley: no, CloudWatch ≠ on-chain ledger events; events are observable to all indexers
- Jordan: no, monitoring layers fail; need on-chain enforcement
- Sam: implicit yes for ephemerals (events are sufficient observability)
- Marcus: no, off-chain logs don't enforce protocol invariants

**T2. Drift vs honest data model**
- Marcus: silent-skip is structural drift residue of incremental adoption; will compound
- Sam: silent-skip is honest reflection of two lifecycles (`pending_policy` has off-handler reader, others don't); fake protocol state is over-engineering

**T3. α's cancel-handler race**
- Sam: 45 flag-flip sites = 45 chances to forget cancel-reset = bricked close_vault. He has shipped this exact bug.
- Marcus: architectural consistency is worth the audit cost of those 45 sites
- Jordan: didn't address — would he accept this risk for uniformity?

**T4. Caller-attestation (γ)**
- Ava: bitmask is correctness check, not security boundary; SDK is the authoritative enumerator post-F-3
- Marcus + Jordan: callers must not attest to protocol state when the protocol can track it
- Riley: SDK ships bugs; bitmask depends on honesty the SDK doesn't deserve
- Sam: silent on γ

**T5. δ's split = future judgment trap**
- Marcus: NEXT contributor adding pending-PDA class #7 has to make a judgment call; they will get it wrong
- Sam: the split reflects REAL semantic differences (protocol-state vs pure-rent), audit-resilient with clear docstring
- Riley: the split is fine if the production observability is consistent

---

## Round 2 task

Each voice must:
1. **Rebut** the strongest counter-argument to their R1 position. Name the voice + their argument.
2. **Concede** one point from another position that has merit they minimized in R1.
3. **Refine or hold** their recommendation. If you're shifting, say so explicitly.
4. **Address Tension T3 (cancel-handler race)** — this is the load-bearing technical objection to α. Every voice must take a position on whether it kills α or not.

Format: ~250 words, same named-voice style.
