# M-1 Architectural Council Brief

**Context for Council members.** Every member should read this brief in full before forming a position.

---

## The finding

Audit 2026-05-25 (silent-failure-hunter): **`close_vault.rs` has asymmetric drain semantics across 6 pending-PDA classes.** One class hard-fails when expected-but-missing; five silently no-op.

## The exact code

```rust
// programs/sigil/src/instructions/close_vault.rs

// === Class 1: pending_policy (lines 99-120) ===
// FLAG-GUARDED. Handler KNOWS via policy.has_pending_policy whether work is in flight.
if ctx.accounts.policy.has_pending_policy {
    let pending_info = ctx.remaining_accounts.first()
        .ok_or(error!(SigilError::PendingPolicyExists))?;     // HARD FAIL
    let (expected_pda, _) = Pubkey::find_program_address(...);
    require!(
        pending_info.key() == expected_pda && pending_info.lamports() > 0,
        SigilError::PendingPolicyExists,                         // HARD FAIL
    );
    // drain (lamports → owner, assign to System, resize 0)
}

// === Classes 2-6: silent-skip pattern (lines 130-260) ===
// pending_agent_perms (per-agent, in vault.agents loop)
// pending_close_constraints
// pending_owner                    (Phase 8 SFH-01)
// pending_agent_grant              (Phase 8 SFH-01)
// pending_constraints              (CH-2 audit 2026-05-23)
let (expected_pda, _) = Pubkey::find_program_address(...);
for pending_info in ctx.remaining_accounts.iter().skip(start_idx) {
    if pending_info.key() == expected_pda && pending_info.lamports() > 0 {
        // drain — but only if caller passed the account!
        // If caller doesn't pass it, the loop falls through SILENTLY.
        break;
    }
}
```

## Why the asymmetry exists (data model)

- `pending_policy` has a lifecycle flag (`PolicyConfig.has_pending_policy: bool`) **because the protocol consults it outside close_vault** (e.g. `apply_pending_policy.rs` decrements it). The flag is protocol-state, not bookkeeping.
- The other 5 pending PDAs are **per-ix-pair ephemeral** — only their own queue/apply/cancel handlers read them. The protocol elsewhere has no need to ask "does pending X exist?" → no flag was needed.
- close_vault picked up the silent-skip pattern incrementally as new pending PDA classes were added (Phase 8 SFH-01, CH-2 audit 2026-05-23). The asymmetry is a **side-effect of the design pattern**, not a deliberate choice.

## What's already remediated (off-chain)

F-3 audit close (2026-05-25, already in working tree) refactored `sdk/kit/src/dashboard/closeVault` to:
- Enumerate ALL 6 pending-PDA classes via a single helper
- Emit ERROR-level log + flag on EACH RPC failure (was previously WARN-only for 3 classes)
- The off-chain monitoring layer now has symmetric error surfacing.

**So the question for the Council is purely on-chain.** The off-chain ground truth is now correct.

## What "symmetric" on-chain would mean

A genuinely symmetric `close_vault` would:
1. Know which pending PDAs exist for this vault (without consulting RPC/syscalls)
2. Reject if caller doesn't pass an expected-existing PDA
3. Emit a structured event per drain so monitoring can reconcile

Constraint: Solana's runtime does NOT let a program inspect accounts not passed in its `AccountInfo[]`. So on-chain enumeration of existence is impossible — the protocol MUST track pending-PDA existence in account state if it wants to enforce symmetric drain.

## The five architectural options

### Option α — Full per-class lifecycle flags
- Add 4 bools to `PolicyConfig` (`has_pending_close_constraints`, `has_pending_constraints`, `has_pending_owner`, `has_pending_agent_grant`)
- Add 1 bool per agent in `AgentEntry` (10 agents × 1 byte = 10 bytes)
- Every queue/apply/cancel handler flips its flag (~15 handlers)
- close_vault hard-fails uniformly across all 6 PDAs (matches pending_policy pattern)
- **Schema impact:** PolicyConfig +4 bytes, AgentVault +10 bytes
- **Symmetry:** Full ✓
- **CU impact:** +1 flag write per affected ix; +5 flag reads in close_vault
- **Migration:** None (pre-mainnet; redeploy reinitializes accounts)

### Option β — On-chain enumeration in close_vault
**Discarded.** Solana runtime blocks AccountInfo inspection of unpassed accounts. The protocol cannot verify on-chain existence of a PDA the caller didn't include. This option doesn't actually work.

### Option γ — Caller-attested bitmask
- Add `expected_pending_bitmask: u16` to `CloseVault` ix args
- SDK enumerates (F-3 already does) and sets bits
- close_vault validates: every bit set → corresponding PDA must be in remaining_accounts
- **Schema impact:** +2 bytes ix args
- **Symmetry:** Caller-honesty dependent (attacker controlling SDK call can lie)
- **CU impact:** Negligible (bitmask check is bitwise ops)
- **Migration:** SDK closeVault builder updates

### Option δ — Hybrid: flags for state-protocol PDAs + events for ephemeral PDAs
- Split the 5 silent-skip classes by **semantic impact**:
  - **State-protocol** (their state outlives the ix-pair, can collide on re-init): `pending_owner`, `pending_agent_grant` → add flags (`has_pending_owner`, `has_pending_agent_grant`), close_vault hard-fails
  - **Pure-ephemeral** (just hold rent): `pending_close_constraints`, `pending_constraints`, `pending_agent_perms[N]` → emit `PendingPdaDrained` event on drain
- **Schema impact:** PolicyConfig +2 bytes; new event schema
- **Symmetry:** Tiered (full for high-impact, observable for low-impact)
- **CU impact:** +1 flag write × 2 classes; events ~negligible

### Option ε — Status quo + structured documentation
- Acknowledge the asymmetry as designed
- Add docstrings at each silent-skip site explaining protocol-state vs ephemeral distinction
- F-3 already gave off-chain monitors symmetric ERROR signal — accept that as the remediation
- **Schema impact:** 0
- **Symmetry:** None on-chain; off-chain only via F-3
- **CU impact:** 0

## Constraints

- **Pre-mainnet posture.** Schema migrations are free (redeploy reinitializes accounts). This calculus changes once we ship mainnet.
- **One redeploy already needed** to land H-1 + F-4 source-level fixes. M-1 fixes can ride that redeploy.
- **CU budget on close_vault**: currently well within 1.4M ceiling; +5-15K CU is acceptable.
- **CLAUDE.md principle:** "Don't add features beyond what the task requires." But the task IS to evaluate whether we should architect for symmetry.

## Threats the asymmetry enables

1. **Orphaned rent on transient RPC outage** during SDK enumeration. Currently low-value (~80-500 bytes per orphan). F-3 surfaces ERROR-level signal; ops can investigate.
2. **Stale `pending_owner` after close** — if close_vault skips draining and the vault is re-initialized at the same seed (PEN-CROSS-2 absorbed this for digest replay, but the PDA-collision avenue persists at the SFH-01 layer).
3. **Stale `pending_agent_grant` after close** — phantom OPERATOR-class grant claims that could land if the vault re-init seed collides.
4. **Audit fatigue** — next auditor sees the asymmetry and re-files M-1.

## The question for the Council

**Should the on-chain `close_vault.rs` enforce symmetric drain semantics across all 6 pending-PDA classes, and if so, at what cost?**

Each Council member should:
1. Read the brief above.
2. Take the assigned perspective.
3. State an initial position + recommended option (α / γ / δ / ε).
4. Identify the top 2 concerns from their perspective.
5. Identify 1 thing another perspective is likely to undervalue.

Format your response as a Council member would: **terse, direct, named-perspective voice**, ~300 words.
