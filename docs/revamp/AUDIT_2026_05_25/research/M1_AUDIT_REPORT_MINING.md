# M-1 Audit-Report Mining: Solana Close-with-Pending-State Findings

**Researcher:** Ava Chen (Perplexity Researcher)
**Date:** 2026-05-25
**Scope:** Public audit reports on Solana programs covering close-with-pending-state lifecycle bugs, flag-desync, cancel-handler races, orphaned-rent, phantom-claim-on-reinit.

---

## Catalog of relevant findings

| Protocol | Finding | Severity | Year | Remediation pattern | Source |
|---|---|---|---|---|---|
| SPL Token | `close_account` does not reject frozen accounts → frozen→close→reinit-as-thawed bypass | Documented bug (closed "not planned" on archived repo) | 2022 | Add frozen-state check at close-handler entry. State-machine-aware close. | [solana-program-library #3190](https://github.com/solana-labs/solana-program-library/issues/3190) |
| Jupiter Lend | "There is currently no way to close a position PDA to claim the rent back" | Low / Known-issue (ineligible for awards) | 2026 | Acknowledged architectural limitation; rent intentionally orphaned for V1 | [Code4rena Jupiter Lend audit](https://code4rena.com/audits/2026-02-jupiter-lend) (Certora FV exhibit L03) |
| Jupiter Perpetuals | `ClosePositionRequestEvent` may capture inconsistent state — validate/freeze associated accounts before event capture | Low/Info | 2024 | Snapshot state before emit, not after partial close | [OtterSec Jupiter Perp audit](https://developers.jup.ag/resources/audits) |
| Jupiter Perpetuals | Owner of position request incorrectly typed as `SystemAccount` (rejected PDA owners); blocked closing for PDA-owned positions | Medium | 2024 | Change to `UncheckedAccount` (manual validation) to allow PDA + system owners | [Offside Labs Jupiter Perp audit, Feb 2024](https://developers.jup.ag/resources/audits) |
| Squads V4 (Multisig) | State-machine close handler exists by design: `transaction_accounts_close` rejects close when `Proposal` is in non-terminal state (`Draft`/`Active`/`Approved`-not-stale for `VaultTransaction`+`Batch`) | Architectural — closing logic codified, not a "finding" | 2023-2024 | Explicit `ProposalStatus` enum {Draft, Active, Approved, Rejected, Executing, Executed, Cancelled} + per-tx-class gating rules in close handler. Stale-after-N-seconds heuristic for Draft/Active orphans. | [v4/programs/squads_multisig_program/src/instructions/transaction_accounts_close.rs](https://github.com/Squads-Protocol/v4/tree/main/programs/squads_multisig_program/src/instructions); [Squads docs](https://docs.squads.so/main/security/security-audits/squads-protocol-v4) |
| Squads V4 | Rent reclaim is **permissionless** for Cancelled/Rejected/Executed; automatic on execute. Pending transactions cannot be closed. | Architectural (operationalized as "Rent Reclaim" feature) | 2024 | Any squad member can reclaim rent (force-defund pattern, no multisig approval); deters orphaned rent buildup | [Squads Rent Reclaim docs](https://docs.squads.so/main/navigating-your-squad/transactions/rent-reclaim); [Squads Rent Reclaim blog](https://squads.xyz/blog/update-rent-reclaim) |
| Drift Protocol V2 | `delete_user` requires: no open positions, no open borrows, no unsettled PnL, no Insurance Vault stake; 7-day waiting period for excess-fee recovery | Architectural — protocol-enforced preconditions on close | 2023-2024 | Hard-fail at close if any pending state remains; off-chain UI shows reclaimable amount post-cooldown | [Drift withdraw and close docs](https://docs.drift.trade/protocol/getting-started/withdraw-and-close-account) |
| Orderly Network Solana Vault | `deposit_nonce` incremented after token transfer → race condition double-deposit (canonical example of "pending state increment after the fact") | High (sponsor-disputed) | 2024 | Increment nonce before side-effect (CEI-equivalent ordering) | [Sherlock Orderly judging #34](https://github.com/sherlock-audit/2024-09-orderly-network-solana-contract-judging/issues/34) |
| Solana Audit Arena Week 4 (stake_v2/yield_generator) | Multiple findings tied to close-handler/CPI mismatches: `close_position` constraint requires writable operator metadata which conflicted with `readonly_signer` flag → `MissingRequiredSignature`; vault PDA pre-funding blocks initialization | Critical / Medium | 2025 | Match CPI metadata to close-constraint expectations; validate `data_len()==0` AND `lamports()==0` before CreateAccount, OR support reinit-of-existing | [Andrea, Audit Arena Wk 4 writeup](https://andrea8787.medium.com/learning-solana-bug-from-solana-audit-arena-week-4-46d257d9db36) |
| OptiFi (operational, not audit) | `solana program close` on mainnet permanently bricked program; $661K USDC locked in PDAs bound to the closed program ID. No on-chain recovery. | Critical (operational, $661K loss) | 2022 | Multi-person sign-off; separate capital pools from upgradable program | [OptiFi incident report](https://medium.com/@OptiFi/optifi-program-incident-report-08-29-22-d8fe6d229bad); [Decrypt coverage](https://decrypt.co/108585/solana-defi-exchange-optifi-bricks-itself-loses-661k) |

Speculative / unverified (flagged): the existence of a specific Neodyme Squads V4 finding on "pending_owner two-step handoff race" was not retrievable via PDF text extraction (PDF returned as binary). The Neodyme audit summary at [neodyme.io/reports/Squads-Multisig-v4.pdf](https://neodyme.io/reports/Squads-Multisig-v4.pdf) is confirmed to exist; specific findings inside it require manual PDF inspection. Treat any "Neodyme found X in Squads V4" claim downstream as unverified until the PDF is read.

---

## Systemic patterns observed

**Pattern 1 — Generic account-closure (revival/reinit) class is the foundational bug.** Every Solana audit checklist surfaced ([Zealynx 45-check guide](https://www.zealynx.io/blogs/solana-security-checklist); [Helius hitchhiker's guide](https://www.helius.dev/blog/a-hitchhikers-guide-to-solana-program-security); [Ackee Blockchain attack vectors](https://github.com/Ackee-Blockchain/solana-common-attack-vectors); [Solana Foundation closing-accounts course](https://github.com/solana-foundation/developer-content)) treats unsafe close as the #1 lifecycle bug. The three-part remediation is canonical: (1) transfer lamports, (2) zero data, (3) write `CLOSED_ACCOUNT_DISCRIMINATOR`. Anchor's `#[account(close = …)]` constraint encodes this. **Anchor 0.30+ no longer writes the discriminator by default — manual remediation is required if revival-resistance is critical.** ([Solana revival attack explainer, fuzzinglabs](https://fuzzinglabs.com/revival-attacks-solana-programs/)).

**Pattern 2 — Mature protocols converge on an explicit state-machine enum at the parent account.** Squads V4's `ProposalStatus` and Drift's user-state preconditions are concrete examples. **Neither protocol relies on per-PDA bool flags or `lamports() > 0` heuristics for terminal-state detection.** They use a typed enum (Squads) or a set of computed predicates over the live state (Drift). When auditors saw the asymmetric handling in Squads (stale-Approved is closable for ConfigTransaction but NOT VaultTransaction), the difference was deliberate and *documented in the source code itself* — preserving the safe path was higher-priority than uniformity.

**Pattern 3 — Permissionless rent reclaim is the recurring recovery pattern.** Squads V4's "any member can reclaim" model and the Solana Foundation's recommendation of a "force-defund" instruction ([closing-accounts course](https://solana.com/developers/courses/program-security/closing-accounts)) are convergent. The reasoning: orphaned-rent is a *liveness/UX* issue, not a *security* issue — but it becomes a security issue when downstream invariants come to depend on close having succeeded. Permissionless reclaim limits the blast radius.

**Pattern 4 — Race conditions in nonce/flag updates are the most-disputed-but-most-recurring class.** Orderly Network (deposit nonce), Wormhole gateway (emitter sequence pubkey derivation), and Aurory ($830K race-condition exploit per [Helius hacks history](https://www.helius.dev/blog/solana-hacks)) all map to the same root: a mutable counter or pending-flag is incremented *after* the side-effect that depends on it. **For M-1 specifically, this means any "set has_pending = true → external side-effect → unset has_pending" sequence in queue/apply/cancel handlers is a known footgun.**

**Pattern 5 — Acknowledged "we cannot close this PDA" is a publicly-shipped pattern.** Jupiter Lend explicitly documents "no way to close a position PDA to claim rent" as a *known issue* in their Code4rena scope. This is an interesting datapoint: **orphaned-rent can be a documented architectural choice**, not a finding, *provided* (a) it is documented, (b) the rent is bounded per user, and (c) no downstream invariant depends on close having succeeded.

---

## Implications for Sigil M-1

1. **Asymmetric drain handling (5 silent no-op + 1 hard-fail) is unusual against the mature-protocol baseline.** Squads V4's close handler has consistent enum-based gating across all transaction classes. Drift's `delete_user` consistently hard-fails on any open state. Sigil's mixed `lamports() > 0` guards + `has_pending_policy: bool` flag would be flagged by an auditor reading Squads V4's source as the comparison standard.

2. **The "phantom-claim-on-reinit" vector at vault re-init (Brief threat #2) has direct historical precedent.** SPL Token #3190 (frozen→close→reinit-as-thawed) is the exact pattern: a state flag (frozen) survives the close handler and is then implicitly reset by reinit. For Sigil, `pending_owner` / `pending_agent_grant` at re-init seed-collision is the analog.

3. **The "future invariant trap" (Brief threat #3) is the recurring class.** Every silently-skipped close becomes a CRITICAL the moment a new instruction reads `pending_X.exists` as a proxy for "rotation in flight." This is exactly Pattern 4 above — a flag/state being depended on by downstream code without it being a hard precondition at every close-touching path.

4. **End-user recovery story is non-trivial in mature protocols.** Drift has 7-day cooldown + UI surfacing of reclaimable rent. Squads has permissionless multi-member rent reclaim. Jupiter Lend documents the orphan. **A "best-effort silent skip" with no surfaced recovery path fails this benchmark.**

---

## Security-first scoring of common remediations

| Remediation pattern | Defense-in-depth | End-user recovery | Auditor onboarding | Long-term consistency |
|---|---|---|---|---|
| Status-quo `lamports() > 0` silent skip (Sigil current) | 1/5 | 1/5 (no surfaced path) | 2/5 (asymmetry reads as oversight) | 1/5 (drift inevitable as PDA classes added) |
| Explicit `ProposalStatus` enum + per-class gating (Squads V4) | 5/5 | 4/5 (off-chain index can surface stuck txns) | 5/5 (state machine is self-documenting in source) | 5/5 (compiler enforces exhaustive match) |
| Permissionless rent-reclaim instruction (Squads V4 / Foundation course) | 4/5 (DoS-resistant) | 5/5 (anyone can clear) | 4/5 | 4/5 |
| Hard precondition gates at close (Drift `delete_user`) | 5/5 | 3/5 (user must clear state manually before close) | 4/5 | 4/5 |
| Documented "cannot close this PDA" (Jupiter Lend) | 2/5 (relies on no downstream invariant) | 1/5 (rent is sunk) | 3/5 (provided documented) | 3/5 |
| Caller-attested bitmask (Sigil γ option) | 3/5 (caller-honesty defense) | 3/5 | 3/5 (requires SDK enumeration logic to be auditable) | 3/5 |
| Per-class lifecycle flag at the parent account (Sigil α option) | 4/5 | 4/5 (if paired with `admin_clear_pending` recovery) | 4/5 (if flag invariants tested) | 4/5 (if `PendingPdaClass` trait + CI test prevents drift) |

---

## Recommendation for Sigil M-1

Adopt the **Squads V4 pattern adapted to Sigil's account model**: a typed enum on `PolicyConfig` (and per-agent overlay) tracking pending-PDA lifecycle, exhaustively matched at every `close_vault.rs` drain site. Pair with a **Drift-style hard-fail precondition** (close cannot succeed while any pending-class flag is non-terminal) and a **Squads-style permissionless rent reclaim** (`reclaim_orphaned_pending_pda` ix any wallet can call, gated by the same enum). This is the α option from the Council R3 set, hardened by Sam's `PendingGuard<T>` RAII and Jordan's `PendingPdaClass` trait + CI exhaustiveness test, with Riley's `admin_clear_pending` retained as the recovery escape-hatch.

This pattern is **directly precedented** in mainnet-tested protocols (Squads V4 multisig — manages hundreds of millions in TVL; Drift V2 perps — pre-exploit ran a year on this exact close-handler discipline). The defense-in-depth, end-user recovery, auditor onboarding, and long-term consistency scores all land at 4–5/5. The γ caller-attested bitmask and δ hybrid both score 3/5 on defense-in-depth because they retain caller-honesty assumptions or asymmetric semantics — the security-first standard set by the user does not permit either as the deciding choice.

**One forward-looking warning surfaced by this mining exercise:** the Drift V2 protocol passed audits and ran on this discipline for ~12 months before suffering a $270M exploit in April 2026 ([Coindesk coverage](https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift); [Elliptic analysis](https://www.elliptic.co/blog/drift-protocol-exploited-for-286-million-in-suspected-dprk-linked-attack)) — root cause was social engineering + durable nonces, *not* close-handler logic. The lesson is that **on-chain close-handler discipline is necessary but not sufficient** — Sigil's M-1 must coexist with off-chain operational security, but M-1 itself should still be solved at the strongest available on-chain tier.
