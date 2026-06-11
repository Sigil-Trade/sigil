# Round 1 Synthesis — Sigil V2 Phases 1-5 Audit (2026-05-18)

10 characters delivered independent first-takes. This synthesis is the input for Round 2.

## Convergence Patterns (3+ characters agree)

### C1: T-21 (Owner Policy Underspecification) is load-bearing AND unaddressed on-chain
**Flagged by:** Remy, Johannes, Decomposer, Designer, Skeptic
- Decomposer: "F (Operability) defeats A (Threat Coverage) via T-21. Improve F by 1 grade → market fit jumps 2."
- Johannes: "The whole bet is good UX. The 19 TA primitives are the consolation prize if the bet fails."
- Designer: "Owner wants a sentence, not a struct. 30% of error messages actionable, 70% diagnostic."
- Skeptic: "Sigil's primitive doesn't work unless the owner runs a different product (Squads) on top."
- Remy: "Shipping engine before steering wheel. M-T21-3 onboarding wizard is the actual blocker."

### C2: TA-19 canonical encoding needs codegen, not hand-mirrored encoders
**Flagged by:** Remy, Architect, Engineer
- Engineer: "20th-field test = 15 atomic touch points across 4 hand-written encoders. 6-8 hours per field. Drift risk."
- Architect: "ADOPT: codegen canonical-form module — Rust authoritative, TypeScript derived from one schema DSL."
- Remy: "Codama already taught you this for IDL-to-client; apply one layer up."

### C3: §RP review pipeline is the undermarketed durable artifact substituting for L-2 deleted audit
**Flagged by:** Johannes, Architect, Engineer, Ava
- Johannes: "Persisted transcripts are the only credible substitute for an audit firm's letter. Nobody is marketing this. They should be."
- Architect: "§RP is *compensating* for an EoM (Economy of Mechanism) violation, not equivalent to it."
- Ava: "Phase 1 §RP caught 75 silently-broken tests the engineer missed. Phase 2 caught a CRITICAL the engineer missed. The rate at which §RP finds CRITICALs is the strongest possible signal that an external auditor would find more."

### C4: TA-09 cosign workflow is implemented but unexercisable in V2
**Flagged by:** Ava, Pentester, code-reviewer (A2), test-coverage (A5)
- Ava: "Feature shipped with no client-side path to exercise it correctly. `grep cosignHelper sdk/kit/src/` returns nothing."
- Pentester: "TA-09 explicitly excludes TA-12 floor LOWERING and TA-14 cap RAISING from elevated; docstring acknowledges 'deferred to Phase 9' but Phase 5 shipped both fields as queueable."
- code-reviewer: "Wire TA-12/TA-14 into TA-09 now, single line each. Don't defer to Phase 9."

### C5: PEN-CROSS-1 (register_agent no-TA-19, no-timelock) open at HEAD
**Flagged by:** Pentester, VulnHunter, code-recon, Ava
- Trust-boundary impact: owner key compromise → instant operator grant
- Memory says Phase 8 absorption; **THREAT_MODEL_V2 doesn't list it as open critical** (Ava finding)

### C6: PolicyConfig schema bloat / Economy of Mechanism violation
**Flagged by:** Architect, Decomposer, Skeptic, Engineer
- Architect: "TCB has crossed the 'one head' gate. Most-at-risk principle Phases 6-11: Economy of Mechanism."
- Decomposer: "WEAK on B (Operational Complexity) and F (Operability) — 36 ix, 13 PDAs, 19 canonical fields owners must specify."
- Skeptic: "97 errors, 13 PDAs, 35,888-byte InstructionConstraints. Solo + no audit + production = inevitable post-launch incident."

## Divergence Patterns (Strong Disagreement)

### D1: Is TA-19 valuable or pure ceremony?
- **Remy + Engineer + Johannes:** Genuine durable win (content-OCC, will outlive everything)
- **Skeptic:** "What attack does this stop that the second owner signature doesn't already stop? KILL it."
- **Pentester (sort of):** Generates §RP findings (4 in Phase 2 alone) because it exists, but blocks discriminator-collision class

### D2: Is the architecture innovation real or coping with Solana limits?
- **Architect + Academic + Market Analyst:** Triple-instruction sandwich is the right call given 4-CPI limit
- **Skeptic:** "4-CPI-depth limit isn't a forcing function, it's an excuse for an architecture that can't enforce against non-cooperating agents"

### D3: Should auto-revoke (TA-17) stay on-chain?
- **Architect:** "REMOVE TA-17 record_agent_violation entirely. Move auto-revoke off-chain; on-chain remains freeze_vault. Save 1 byte + cross-impl obligation + 1 ix."
- **Johannes:** "TA-17 is overhyped — 'auto' implies in-band but it's actually monitored-revoke with extra steps."
- **VulnHunter + code-recon:** Verified working, no security gap, but acknowledge off-chain monitor dependency

## CRITICAL/HIGH Technical Findings (must address before Phase 6)

| Sev | Source | Finding | File |
|---|---|---|---|
| **CRITICAL** | A3 silent-failure | SDK `initializeVault.ts` + `queuePolicyUpdate.ts` MISSING Phase 5 args (stableBalanceFloor, perRecipientDailyCapUsd). 16-byte short wire payload. ORCHESTRATOR VERIFIED at HEAD `1dcc92d` — InstructionData type has 14 args, IDL has 17. | sdk/kit/src/generated/instructions/{initializeVault,queuePolicyUpdate}.ts |
| HIGH | A1 Pentester | TA-09 cosign excludes TA-12 floor-lower + TA-14 cap-raise from elevated detection | queue_policy_update.rs:241-273 |
| HIGH | A1 Pentester | destination_check `take(16)` silently skips metas 17+ — Jupiter v6 has 22-25 | utils/destination_check.rs:120 |
| HIGH | A1 Pentester | InstructionConstraints entries carry NO digest binding — only has_constraints bool at TA-19 position 12 | queue_constraints_update.rs |
| HIGH | A2 code-reviewer | finalize_session.rs:952-958 AC-10 nonce increment is dead code (init+close cycle) but 26-line comment buries that fact | finalize_session.rs |
| HIGH | A3 silent-failure | finalize_session.rs:524 TA-14 cap bypassed by omitting recipient ATA from remaining_accounts | finalize_session.rs |
| HIGH | A3 silent-failure | register_agent.rs:91-104 swallows `load_mut()` Err arm — agent registered without overlay slot | register_agent.rs |
| HIGH | A3 silent-failure | Rust 6047 #[msg] says "rolling 24h" but SDK says "slot exhausted" — on-chain log misclassifies | errors.rs:166 vs sdk/kit |
| HIGH | A6 comment-analyzer | INTERFACES_V2.md says PROTECTED set is 4 keys (real is 16). ErrAutoRevoked code 6088 (real 6090). ErrPolicyPreviewMismatch 6081 (real 6080). HARDENED §6 Phase 2 still reverses 6080/6081. | INTERFACES_V2 + HARDENED |
| HIGH | Ava | THREAT_MODEL_V2 still claims AC-10 nonce "increments per seal" but code uses `init`. Threat model lags HARDENED clarification. | THREAT_MODEL_V2.md:257-264 |
| HIGH (open) | Pentester+VulnHunter+code-recon+Ava | PEN-CROSS-1 register_agent no-TA-19, no-timelock, no-cosign | register_agent.rs |

## STRONGEST PRAISE (3+ characters agree)
- TA-19 conceptual primitive (Remy, Engineer, Academic, Johannes)
- Session `init` not `init_if_needed` (Remy, Architect, Academic, A8)
- §RP review pipeline (Johannes, Architect, Engineer, Ava)
- Phase 1 demolition (Decomposer C-axis "cleanest")
- Generic-not-protocol-specific (Decomposer, Architect, Market Analyst)

## STRONGEST ATTACK (multiple characters)
- T-21 / UX / operability (5 characters: Remy, Johannes, Decomposer, Designer, Skeptic)
- Solo-founder bus factor + no audit budget (Architect, Skeptic, Johannes)
- Maestro "Agent Mode" SDK threat in 12-18 months (Market Analyst, Johannes implicit)
- USDC/USDT hardcoded as universe of stablecoins (Johannes, with 24-month rot prediction)

## KEY ONE-LINERS (capture for Part C)
- Remy: "The code is better than the plan, the plan is better than the doc, the doc is better than the threat model — that order means you're doing it right."
- Johannes: "In 24 months, the part I'll be proven right about: the hardcoded USDC/USDT pair will need a 'third stablecoin' emergency upgrade by 2027."
- Decomposer: "Strongest axis (A Threat Coverage) is undone by weakest axis (F Operability) via cleanest axis (D Trust Boundaries)."
- Academic: "Reference monitor over delegated, attenuated, online-revalidated object capabilities. Closest to KeyKOS/EROS extended with Kung-Robinson OCC."
- Architect: "Bus factor 1 is structural risk. The system passed 'one head' at Phase 2."
- Engineer: "Would NOT ship: ProtocolCapExceeded (6047) Rust/SDK message divergence. Silent error-text drift turns 5-min 2am page into 90-min incident."
- Designer: "Owners get the contract; they need a draft mode."
- Skeptic: "Short bet: founder accepts audit recommendation in Q3, can't afford it, project pivots/shutters."
- Market Analyst: "Maestro's $24B-volume guardrail playbook, retargeted from Telegram-bot users to AI agents, enforced on-chain."
- Ava (headline): "Solo founder ships universal guardrails in 90 days — but cosign has no client and docs disagree with code."

## Round 2 Tasks for Each Character

Read this synthesis. Then:

**Cross-pollination (200 words):**
- Which 2 other characters' arguments resonated most strongly with yours?
- Where do you DISAGREE with another character and why? Pick a fight.
- One concrete change you'd advocate after seeing all 10 takes.

**Strategic synthesis (250 words):**
- Verdict: should we proceed with Phases 6-11 as planned, or pivot? (CLEAR / FIX-FIRST / PIVOT)
- What ONE change would make the biggest difference?
- 30-second VC pitch one-liner
- The moat against a Maestro "Agent Mode" SDK in 12-18mo
- The SINGLE biggest risk we are not currently mitigating

Cap output at 450 words combined. Be specific. Quote files. No prose mush.
