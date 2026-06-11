# M-1 Council — Final Verdict (3-Round Convergence)

**Question:** Should `close_vault.rs` enforce symmetric drain semantics across all 6 pending-PDA classes, and at what cost?

**Result:** Clean convergence. Every voice converged onto **the same two acceptable paths**, with conditions. Majority hard-vote is **δ+γ**.

---

## R3 final hard vote

| Voice | Hard vote | Accepts opposing if conditions met |
|---|---|---|
| **Jordan** (Security) | **α** | δ+γ acceptable if `PendingPdaClass` trait + CI exhaustiveness test ship |
| **Ava** (SDK) | **δ+γ** | α acceptable if helper + batched IDL release with migration doc |
| **Sam** (On-chain) | **δ+γ** | α acceptable if `PendingGuard` + CI grep + LiteSVM drop assertions ship (three locks) |
| **Marcus** (Architect) | **α** | δ+γ acceptable if (a) helper applies to flag+event paths, (b) ADR documents the test, (c) γ bitmask is bidirectional |
| **Riley** (Ops) | **δ+γ** | α acceptable if `PendingGuard` + cosigned `admin_clear_pending_flag` escape-hatch ship |

**Tally:** α = 2, δ+γ = 3. **δ+γ wins the hard vote 3-2.**

**Acceptance graph:** 100% of voices accept the OPPOSING camp's option under specific structural conditions. No voice holds a hard "no." This is genuine convergence, not gridlock.

---

## Why δ+γ (over α) is the recommended path

Three reasons emerge cleanly from the 3-round debate:

### 1. Majority hard-vote (3-2)

Three of five voices — including the on-chain engineer who'd be writing the Rust, the SDK engineer who'd be shipping the IDL changes, and the operations engineer who'd be debugging at 3am — prefer δ+γ. The two α voices (Jordan, Marcus) both explicitly accept δ+γ under structural conditions that the δ+γ camp WANTS to ship anyway.

### 2. Lower implementation surface

| Cost dimension | α | δ+γ |
|---|---|---|
| Schema growth | +14 bytes (PolicyConfig +4, AgentVault +10) | +2 bytes (PolicyConfig only) |
| Handler edits | ~15 sites × flag-flip discipline | ~6 sites × flag-flip discipline |
| Per-agent byte tax | +1 byte × 10 agents in AgentEntry | 0 |
| SDK IDL impact | Major version bump (all account decoders) | Minor version bump (close_vault ix args) |
| New event types | 0 | 3 (`PendingPdaDrained` per ephemeral class) |
| Escape-hatch ix needed | YES per Riley (`admin_clear_pending_flag` for desync recovery) | NO (ephemeral classes don't have desync risk; state-protocol classes have only 2 paths to monitor) |

### 3. Riley's recovery argument is asymmetric

Riley flagged α's hard-fail-on-flag-desync as an unrecoverable SEV-1 — if a flag desyncs from PDA existence (state corruption, partial-failed ix, schema-migration miss), close_vault rejects forever with no on-chain recovery path. α would need to ship a cosigned `admin_clear_pending_flag` escape ix to be operationally viable. δ+γ has no equivalent failure mode for the 3 ephemeral classes (events are observed, not enforced — no desync can brick close).

For the 2 state-protocol PDA classes (`pending_owner`, `pending_agent_grant`) under δ+γ, the desync risk is still there but the blast radius is bounded: only those 2 classes need the escape-hatch design, not all 6. That's a smaller surface area for the operational safety net.

---

## The recommended δ+γ build sheet

If we ship δ+γ, the engineering deliverables are:

### On-chain

1. **State changes (PolicyConfig +2 bytes):**
   - `pub has_pending_owner: bool`
   - `pub has_pending_agent_grant: bool`

2. **PendingLifecycle helper module** at `programs/sigil/src/state/pending_lifecycle.rs`:
   - `fn open(flag: &mut bool)` — sets flag, used by queue handlers
   - `fn apply(flag: &mut bool)` — clears flag, used by apply handlers
   - `fn cancel(flag: &mut bool)` — clears flag, used by cancel handlers
   - Plus `PendingGuard<'a>` RAII variant if Sam validates the borrow-checker compatibility (his R3 flagged Anchor borrow-checker friction; mitigation is `#[must_use]` on open() + LiteSVM tests).

3. **`PendingPdaClass` trait** at `programs/sigil/src/state/pending_pda_class.rs`:
   ```rust
   pub trait PendingPdaClass {
       const LIFECYCLE: Lifecycle;
   }
   pub enum Lifecycle {
       HardFail,   // close_vault rejects if missing — for pending_policy/owner/agent_grant
       EventOnly,  // close_vault emits drain event, silent if absent — for pending_close_constraints/constraints/agent_perms
   }
   ```
   Every pending PDA struct must impl this trait. CI exhaustiveness test (Jordan's condition + Marcus's ADR test) fails build if a new pending PDA seed appears without trait impl.

4. **CI grep test** (Marcus's condition): parses `instructions/*.rs`, fails build if any `has_pending_*` mutation occurs outside `pending_lifecycle::*`.

5. **Event schema:**
   ```rust
   #[event]
   pub struct PendingPdaDrained {
       pub vault: Pubkey,
       pub kind: PendingPdaKind,  // enum: CloseConstraints | Constraints | AgentPerms { agent: Pubkey }
       pub drained_at: i64,
   }
   ```
   Emitted from the 3 ephemeral drain blocks in close_vault.rs.

6. **close_vault changes:**
   - Read `policy.has_pending_owner` + `policy.has_pending_agent_grant` — hard-fail if true and PDA missing from remaining_accounts (mirrors current `pending_policy` pattern at line 99-120)
   - For ephemeral PDAs: drain loop emits `PendingPdaDrained` event when found
   - γ bitmask validation: reject if `expected_pending_bitmask` set bits don't match passed accounts (bidirectional, per Marcus's condition c)

7. **Ix arg addition (CloseVault):**
   - `expected_pending_bitmask: u8` (5 bits used: 1=policy, 2=owner, 4=agent_grant, 8=close_constraints, 16=constraints + reserved bits for future)
   - Per-agent bits could overflow u8 if vaults grow past 10 agents — pin to u16 with reserved bits.

### Off-chain (SDK)

8. **SDK closeVault builder updates** (already in F-3 working tree):
   - Set `expected_pending_bitmask` based on enumeration result
   - Existing enumerateExistingPendingPdasForClose helper feeds the bitmask construction
   - Subscribe to `PendingPdaDrained` events for monitoring

9. **Dashboard / observability:**
   - Indexer panel: "drains per close_vault vs expected bitmask count" (Riley's R1 ask)
   - Helius webhook subscription on `PendingPdaDrained`

### Documentation

10. **ADR** at `docs/revamp/ADR/M1-PENDING-PDA-DRAIN-SEMANTICS.md`:
    - Names the explicit test for any new pending PDA: *"Does any handler outside this PDA's queue/apply/cancel triplet read its existence as protocol state? If yes → Lifecycle::HardFail. If no → Lifecycle::EventOnly."*
    - References Marcus's R3 condition (b).

---

## Estimated effort

| Task | Hours |
|---|---|
| State changes + helper module | 2 |
| PendingPdaClass trait + CI exhaustiveness test | 2 |
| CI grep test | 1 |
| close_vault changes (2 flags + 3 events + bitmask) | 3 |
| Ix arg addition + SDK builder update | 2 |
| LiteSVM tests (drop assertions for 2 flag classes, drain events for 3) | 3 |
| ADR + docs | 1 |
| Total | **~14 hours** |

Per Sam's R2: "3hr + 1hr + ~50 LOC test" for the helper alone. The trait + grep + event additions push to ~14h. **Significantly cheaper than α** which Sam estimated at 15 sites × discipline overhead + 6h baseline.

---

## What's left for the user to decide

The Council converged. Two valid paths:

1. **δ+γ (Council-recommended, 3-2 hard vote):** ~14 hours, +2 schema bytes, tiered observability, cosigned escape-hatch only needed for 2 state-protocol classes.

2. **α (Jordan/Marcus's preference, accepted by all if conditions ship):** ~20-25 hours, +14 schema bytes, uniform mental model, requires `admin_clear_pending_flag` escape-hatch ix for desync recovery.

Both paths require: **structural helper**, **CI grep test**, **trait/lifecycle declaration mechanism**, **drop-test discipline**. Both ride the next redeploy (already needed for H-1 + F-4).

**ε (status quo + docs)** was conclusively rejected by R2-R3 convergence — no voice held it.
**γ (caller-attestation alone)** was rejected as security smell unless layered on top of δ events.

---

## Recommendation

**Ship δ+γ with the structural guarantees from the build sheet above.**

The Council voted 3-2, the implementation cost is half of α, the schema growth is 14% of α, and every voice (including the 2 α holdouts) explicitly accepted δ+γ under conditions that match the build sheet. This is the rare case where the cheaper option is ALSO the better-supported option.
