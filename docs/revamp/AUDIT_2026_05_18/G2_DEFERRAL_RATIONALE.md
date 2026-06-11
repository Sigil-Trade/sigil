# G2 — PEN-CROSS-1 register_agent Deferral Rationale

**Status:** DEFERRED to Phase 8 (with explicit acknowledgment + mitigation)
**Audit severity:** HIGH (downgraded from cross-phase audit memory's CRITICAL because owner signature is still required)
**Decision date:** 2026-05-18

## The finding

`programs/sigil/src/instructions/register_agent.rs` has:
- No timelock (`MIN_TIMELOCK_DURATION` not enforced)
- No TA-19-style digest binding (no `expected_digest: [u8; 32]` arg)
- Not in TA-09 elevated set (no cosign requirement)

An attacker who phishes the owner key for ~30 seconds can register their own pubkey as a full-permission agent with `capability=FULL` + `spending_limit_usd=u64::MAX`, then immediately drain the vault through the normal agent path.

Independently confirmed by 6 audit agents:
- Pentester (A1)
- VulnHunter (A9)
- code-recon (A10)
- Ava (B1-3) — flagged that THREAT_MODEL_V2 doesn't list it as open
- Remy (B1-1)
- Architect (B1-6)

## Why we're deferring

### The fix is structurally large

The proper fix is to add `expected_agent_digest: [u8; 32]` as an arg to `register_agent`, mirroring the PEN-CROSS-3 sibling-handler pattern. The handler recomputes a digest over `(agent, capability, spending_limit_usd)` and asserts equality with what the owner signed.

This is fundamentally correct. But:

- **121 callsites** of `registerAgent` across `tests/` and `sdk/kit/`
- Every test fixture must compute the digest and pass it
- Every SDK helper that calls registerAgent must derive the digest
- Every dashboard mutation that constructs a registerAgent call must wire it through
- The TA-19 cross-impl byte-equality pattern (Rust + TS + LiteSVM-helper TS) extends to a new agent-digest encoder, currently hand-mirrored

This is roughly 1 week of focused work for a solo founder — equivalent to a full phase's effort.

### The threat is narrowly bounded

The exploit requires phishing the owner key. Once the owner key is compromised, the attacker has many paths:
- `queue_policy_update` (timelock + TA-09 cosign — slow, requires session compromise too)
- `freeze_vault` (instant, but locks rather than drains)
- `withdraw_funds` (instant, drains via owner authority directly)
- `register_agent` ← the current gap, instant + creates persistent backdoor

So while register_agent is the only INSTANT drain path that doesn't already have cosign or timelock, the OVERALL threat class (compromised owner key) has multiple paths to loss. Sigil's V2 design explicitly notes this — see THREAT_MODEL_V2 AC-2.

### The structural mitigation already exists

**Squads V4 3-of-5 multisig as vault owner** is the locked V2 design recommendation per D-05 + REVAMP_PLAN §4.4. If owners deploy with Squads as the vault owner (not a solo key), then "owner-key compromise" requires compromising 3 of the 5 multisig members — at which point the entire vault is already lost and register_agent is the least of the concerns.

Single-key owners deploying Sigil today are EXPLICITLY out of the supported V2 deployment shape. G5 audit fix (2026-05-18) just updated THREAT_MODEL_V2 AC-2 to state this explicitly with PEN-CROSS-1 listed as the residual catastrophic path for non-multisig owners.

### Phase 8 will fix this natively

The HARDENED roadmap Phase 8 (Ownership Transfer + C26-C28) reuses the AC-10 session nonce field for replay protection on ownership-transfer (M-5). The natural extension of that work is to add timelock + digest binding to `register_agent` in the same phase — both are "owner-state-mutation paths that need PEN-CROSS-3 pattern."

Doing register_agent in Phase 8 is cleaner because:
- The Phase 8 SDK migration for ownership transfer will already touch all owner-mutation paths
- The cross-impl digest pattern will extend uniformly to all such ix
- The 121 callsite migration happens once across multiple primitives, not twice

## What's happening RIGHT NOW to mitigate

1. **G5 doc fix landed** (commit `607c662`): THREAT_MODEL_V2 AC-2 now explicitly lists PEN-CROSS-1 as an OPEN known issue with Squads mitigation pointer. Readers cannot miss it.

2. **G0 user-action recommendation** (`G0_MULTISIG_HARDENING.md`): Program upgrade authority moved to Squads. Closes the bus factor 1 structural risk — separate but adjacent concern.

3. **HARDENED §6 Phase 8** dispatch will explicitly include register_agent timelock + digest binding as a Phase 8 task. (To be added when Phase 8 is dispatched.)

4. **README on the audit folder** will mark PEN-CROSS-1 as "tracked, deferred to Phase 8" rather than "closed."

## What this looks like for design partners

If a partner asks "what about register_agent without timelock?", the honest answer is:

> "Confirmed open. Documented in THREAT_MODEL_V2 AC-2. Mitigation in V2 is Squads multisig as vault owner (3-of-5). Single-key owners SHOULD NOT deploy until Phase 8 ships register_agent timelock + digest binding. Phase 8 ETA: TBD post-V1-mainnet."

No hiding. This is the only catastrophic-class issue from the audit that is being deferred rather than closed, and it has explicit mitigation guidance and a future-fix commitment.

## Audit gate status post-deferral

| Gate | Status | Notes |
|---|---|---|
| G0 (multisig) | PENDING USER CLI | $0, 5min, user must run command |
| G1 (CRIT-1 SDK regen) | ✅ CLOSED | commit chain via codama regen |
| G2 (PEN-CROSS-1) | ⚠️ DEFERRED | THIS DOC. Phase 8 absorption. Mitigation: Squads owner. |
| G3 (TA-09 elevation) | ✅ CLOSED | cc5d336 |
| G4 (cosignHelper) | 🟡 IN FLIGHT | Engineer subagent dispatched |
| G5 (doc drift) | ✅ CLOSED | 607c662 |

4 of 5 gates closing on-chain. G2 deferred with mitigation + roadmap. G0 pending CLI action.
