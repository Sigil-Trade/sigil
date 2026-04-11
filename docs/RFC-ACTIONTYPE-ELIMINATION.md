# RFC: ActionType Elimination

> **Status:** DRAFT
> **Author:** Kaleb Rupe
> **Date:** 2026-04-11
> **Scope:** On-chain program upgrade + SDK + Dashboard

---

## Problem

The `validate_and_authorize` instruction currently takes `ActionType` as a parameter from the AGENT. The agent declares "I am doing a Swap" or "I am doing a ClosePosition." The program trusts this declaration for three purposes:

1. **Permission gating** — 21-bit bitmask per agent, one bit per ActionType
2. **Spending classification** — `is_spending()` determines if token delegation + spending caps apply
3. **Position tracking** — `position_effect()` increments/decrements position counter

This is a trust assumption. The agent tells the program what it's doing, and the program believes it. While token delegation (SPL approve) prevents the worst case (spending without delegation), the permission labels and audit trail rely on client honesty.

---

## Solution

**Derive everything from the constraint engine match, not the agent's declaration.**

The constraint engine (`verify_against_entries_zc`) already identifies WHICH instruction matched by program_id + discriminator. When a constraint entry matches, the program knows exactly which instruction the agent is executing — because the discriminator was verified against 8 bytes of the instruction data.

Each `ConstraintEntry` configured by the vault owner carries metadata about enforcement behavior:

```rust
#[zero_copy]
pub struct ConstraintEntryZC {
    pub program_id: [u8; 32],
    pub data_constraints: [DataConstraintZC; 8],
    pub account_constraints: [AccountConstraintZC; 5],
    pub data_count: u8,
    pub account_count: u8,
    // NEW FIELDS (v2):
    pub is_spending: u8,        // 0 = non-spending, 1 = spending
    pub position_effect: u8,    // 0 = none, 1 = increment, 2 = decrement
    pub _padding: [u8; 4],      // reduced from [u8; 6]
}
```

When the constraint engine matches an entry, it returns the entry's `is_spending` and `position_effect` flags. These replace `ActionType.is_spending()` and `ActionType.position_effect()` — same enforcement, but the vault OWNER sets the classification at constraint-creation time, not the AGENT at execution time.

---

## What changes

### On-chain program

**`validate_and_authorize` instruction signature:**

```rust
// BEFORE (v1):
pub fn handler(
    ctx: Context<ValidateAndAuthorize>,
    action_type: ActionType,
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    leverage_bps: Option<u16>,
    expected_policy_version: u64,
) -> Result<()>

// AFTER (v2):
pub fn handler(
    ctx: Context<ValidateAndAuthorize>,
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    expected_policy_version: u64,
) -> Result<()>
```

`action_type` and `leverage_bps` removed. Spending classification derived from the matched constraint entry.

**Spending classification flow:**

```
BEFORE:
  Agent declares ActionType::Swap → is_spending() = true → token delegation + caps

AFTER:
  Constraint engine matches entry → entry.is_spending == 1 → token delegation + caps
```

**Permission model:**

```
BEFORE:
  Agent has 21-bit bitmask → bit 0 = can Swap, bit 1 = can OpenPosition, ...
  Program checks: vault.has_permission(agent, action_type)

AFTER:
  No bitmask. Agent can execute ANY instruction that has a matching constraint
  entry. The constraint entry IS the permission — if the vault owner configured
  a constraint for Jupiter Route, the agent can execute Jupiter Route.
  
  If the vault owner wants to BLOCK an agent from a specific instruction,
  they don't create a constraint entry for it + set strict_mode = true.
```

**Position tracking:**

```
BEFORE:
  ActionType::OpenPosition → PositionEffect::Increment
  
AFTER:
  Matched constraint entry has position_effect = 1 → Increment
```

### ConstraintEntryZC layout change

Current (v1): 560 bytes per entry
```
program_id:          32
data_constraints:    320 (8 × 40)
account_constraints: 200 (5 × 40)
data_count:          1
account_count:       1
_padding:            6
TOTAL:               560
```

Proposed (v2): 560 bytes per entry (same size — steal 2 bytes from padding)
```
program_id:          32
data_constraints:    320 (8 × 40)
account_constraints: 200 (5 × 40)
data_count:          1
account_count:       1
is_spending:         1    ← NEW
position_effect:     1    ← NEW
_padding:            4    ← reduced from 6
TOTAL:               560  ← same
```

**This is the critical insight: the layout stays the same size.** No account reallocation, no rent change, no migration of the PDA data. Existing entries have `is_spending = 0` and `position_effect = 0` (both bytes were padding, initialized to 0). The migration instruction just needs to set these fields on existing entries.

### SDK changes

**`SigilClient.executeAndConfirm()`:**

```typescript
// BEFORE:
await agent.executeAndConfirm(jupiterIxs, {
  tokenMint, amount, actionType: "Swap", targetProtocol,
});

// AFTER:
await agent.executeAndConfirm(jupiterIxs, {
  tokenMint, amount, targetProtocol,
});
```

`actionType` parameter removed.

**`OwnerClient.registerAgent()`:**

```typescript
// BEFORE:
await owner.addAgent(agent, permissions: 0b111n, spendingLimit);
// permissions is a 21-bit bitmask: bit 0 = Swap, bit 1 = OpenPosition, ...

// AFTER:
await owner.addAgent(agent, spendingLimit);
// No permission bitmask. Agent can execute any instruction that has
// a constraint entry. Strict mode + constraint presence IS the permission.
```

**`OwnerClient.createConstraints()`:**

```typescript
// BEFORE:
await owner.createConstraints([
  { programId, dataConstraints, accountConstraints }
]);

// AFTER:
await owner.createConstraints([
  { programId, dataConstraints, accountConstraints, isSpending: true, positionEffect: "none" }
]);
```

### Dashboard UI

The agent permissions page changes from a checkbox grid:

```
BEFORE:
  ☑ Swap  ☑ OpenPosition  ☐ ClosePosition  ☑ Deposit  ...
  
AFTER:
  Agent can execute any instruction with a constraint entry.
  To restrict: use strict mode + only create entries for allowed instructions.
```

The constraint builder adds two fields per entry:
- "Is this a spending instruction?" toggle (default: yes for safety)
- "Position effect" dropdown: None / Opens position / Closes position

---

## Migration path

### Phase 1: Add fields, support both models (backward compatible)

1. Add `is_spending` and `position_effect` to `ConstraintEntryZC` (steal from padding)
2. `validate_and_authorize` accepts BOTH:
   - Old signature with `ActionType` → uses `action_type.is_spending()` as before
   - New signature without `ActionType` → uses matched entry's `is_spending`
3. New instruction `migrate_constraint_metadata` sets `is_spending` + `position_effect` on existing entries
4. SDK ships both old and new `executeAndConfirm` signatures

### Phase 2: Deprecate ActionType (after migration window)

1. `validate_and_authorize` with `ActionType` parameter emits a deprecation event
2. Dashboard shows "upgrade your agent SDK" banner for vaults using old path
3. Set a sunset date (e.g., 90 days after Phase 1 deploy)

### Phase 3: Remove ActionType (breaking change)

1. Remove old `validate_and_authorize` signature
2. Remove `ActionType` enum from program
3. Remove `permission_bits` from `AgentEntry`
4. SDK removes `actionType` parameter from all methods

---

## Risks

1. **Existing vaults without constraints** — A vault that uses ActionType permissions but has no `InstructionConstraints` PDA cannot migrate to the new model until constraint entries are created. The migration instruction must handle this.

2. **MCP server translation** — The MCP server currently passes `actionType` to `seal()`. After Phase 3, it just passes instructions and lets the constraint engine determine spending classification.

3. **Audit trail** — The current `SessionFinalized` event includes `action_type`. After elimination, the event includes the matched constraint entry index instead. Existing analytics/indexers need updating.

4. **Agent SDK backward compatibility** — Old agent SDKs that pass `ActionType` break after Phase 3. Phase 2's deprecation window gives time to upgrade.

---

## Why now

The constraint builder is shipping. The first users will configure constraints through the dashboard UI. If we ship with the ActionType model and then change it later, those users see a "permissions" UI that gets ripped out and replaced. Building the clean model from day one means users never see the transition.

The layout change is zero-cost (same 560 bytes, steal from padding). The migration is low-risk (additive fields, backward-compatible Phase 1). The only question is whether to do it before or after the first dashboard deploy.

**Recommendation:** Ship Phase 1 (both models supported) before the dashboard deploys. Users see the clean model from day one. Phase 2-3 happen over 90 days as agents upgrade.

---

## Open questions

1. **Should `is_spending` default to 1 (spending) or 0 (non-spending) for existing entries?** Defaulting to 1 is safer (spending caps apply), but existing entries with padding=0 would be non-spending. A migration instruction must explicitly set each entry.

2. **Should the permission bitmask be removed entirely or kept as a secondary check?** Removing it simplifies the model. Keeping it provides defense-in-depth during the transition. Recommend: keep in Phase 1, remove in Phase 3.

3. **What replaces `leverage_bps` in the instruction signature?** Currently used only for position-effect tracking. If position effect comes from the constraint entry metadata, `leverage_bps` is no longer needed in the instruction args.
