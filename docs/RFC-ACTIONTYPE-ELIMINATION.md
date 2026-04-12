# RFC: ActionType Elimination

> **Status:** APPROVED (council-reviewed, adversarially validated)
> **Author:** Kaleb Rupe
> **Date:** 2026-04-11
> **Scope:** On-chain program upgrade + SDK + Dashboard
> **Council review:** 3 questions × 7-round debates × 3 perspectives + 3 adversarial researchers
> **Leverage research:** 4 parallel agents — Flash Trade byte layouts, 7-protocol survey, post-execution feasibility, cross-chain patterns

---

## Problem

The `validate_and_authorize` instruction takes `ActionType` as a parameter from the AGENT. The agent declares "I am doing a Swap" or "I am doing a ClosePosition." The program trusts this declaration for:

1. **Permission gating** — 21-bit bitmask per agent, one bit per ActionType
2. **Spending classification** — `is_spending()` determines if token delegation + spending caps apply
3. **Position tracking** — `position_effect()` increments/decrements position counter

This is a trust assumption. The constraint engine already identifies instructions by program_id + discriminator — it knows what the agent is executing without asking. The agent's self-declaration is redundant and bypassable.

---

## Solution

**Derive everything from the constraint engine match, not the agent's declaration.**

Three resolved design decisions from council debate + adversarial validation:

### Decision 1: Tri-State `is_spending` + Version Gate

**Council consensus (7 rounds, unanimous with 1 dissent).**

`is_spending` on `ConstraintEntryZC` uses a tri-state encoding:

| Value | Meaning | Behavior |
|---|---|---|
| 0 | **Unset** (migration pending) | Treated as spending for safety (belt-and-suspenders) |
| 1 | **Spending** | Token delegation + fees + spending cap enforcement |
| 2 | **Non-Spending** | No delegation, no fees, no cap tracking |

Add `constraint_version: u8` to `InstructionConstraints`:
- version=0 (existing): program uses old ActionType model
- version=1 (migrated): program uses new `is_spending` field
- New `validate_and_authorize` (without ActionType) **requires** `constraint_version >= 1`, else `SigilError::ConstraintsMigrationRequired`

**Why tri-state, not binary:**
- 0 genuinely means "not yet classified" — physically accurate (padding was zero)
- No bytemuck semantic inversion (0 doesn't secretly mean 1)
- Per-entry migration visibility — owner sees which entries need classification
- Belt-and-suspenders: even if version gate fails, Unset defaults to spending (safe direction)

**Adversarial validation:** Thesis holds. 6 attack vectors tested, all failed. SPL delegation prevents unauthorized spending regardless of `is_spending` flag. Outcome-based verification in finalize_session is the real safety net. Cross-chain precedent (Gnosis Safe, Cosmos authz) supports config-time classification.

**Dissent (Protocol Engineer):** The belt-and-suspenders fallback (treating Unset as spending) is dead code if the version gate works correctly. Accepted as a minor cost for defense-in-depth.

### Decision 2: Replace 21-Bit Bitmask with 2-Bit Capability Field

**Council consensus (7 rounds, unanimous).**

Replace `permissions: u64` on `AgentEntry` with `capability: u8`:

| Value | Role | What agent can do |
|---|---|---|
| 0 | **Disabled** | Nothing — registered but blocked |
| 1 | **Observer** | Execute non-spending constraint entries only |
| 2 | **Operator** | Execute all matched constraint entries including spending |
| 3 | **Reserved** | Future use |

**Enforcement:** After constraint engine matches entry N, if `entry.is_spending == 1` (or Unset/0 which defaults to spending) and `agent.capability < 2`, reject with `InsufficientPermissions`.

**Why not keep the 21-bit bitmask:**
- Adversarial researcher DISPROVED full removal but VALIDATED the 2-bit replacement
- The bitmask checks agent-declared ActionType — the same trust assumption we're eliminating
- 21 abstract categories don't map cleanly to instruction-level constraints
- Escrow + agent_transfer instructions check the bitmask directly — the 2-bit capability field replaces this check at those callsites too

**Dashboard UX:** Agent registration becomes a dropdown: "Observer" or "Operator" + spending limit. No 21-checkbox grid.

**Phase 2 addition:** Per-agent deny-list PDA (~120 bytes) for multi-agent vaults where different agents need different instruction scopes. Not blocking for Phase 1.

### Decision 3: Remove `leverage_bps`, Enforce via Post-Execution Assertions

**Council consensus (7 rounds, unanimous). Adversarial research CORRECTED the RFC.**

The original RFC claimed DataConstraints would "enforce leverage limits at the byte level." This is **wrong**. No DeFi protocol encodes leverage as an explicit instruction field:

| Protocol | Leverage encoding | Explicit field? |
|---|---|---|
| Flash Trade | `sizeAmount / collateralAmount` | NO — derived ratio |
| Drift | `totalNotional / totalCollateral` | NO — account-level |
| Jupiter Perps | `sizeUsd / collateralUsd` | NO — derived ratio |
| Mango V4 | health-based margin system | NO |
| Zeta | margin fraction | NO |

**The correction:** Leverage enforcement requires **post-execution account assertions** — reading the Position account AFTER the DeFi instruction executes, within the same atomic transaction.

**Current `leverage_bps` is already advisory-only** (code comment at validate_and_authorize.rs:449): agent passes `Option<u16>`, can pass `None` to skip. Not real enforcement.

**Resolution — Option B-Prime:**
1. Remove `leverage_bps` from instruction signature
2. Keep `max_leverage_bps` on PolicyConfig as deprecated fallback for vaults without strict-mode constraints
3. Real leverage enforcement via Phase B post-execution assertions (see below)
4. Three-phase deprecation matching ActionType timeline

---

## Phase B: Post-Execution Account Assertions (Leverage Enforcement)

**This is novel. No other Solana middleware does this.**

### The mechanism

```
TX = [validate_and_authorize, DeFi_instruction, finalize_session]
                                     ↓
                              Position account updated:
                                sizeUsd at offset 140 (u64)
                                collateralUsd at offset 172 (u64)
                                     ↓
                              finalize_session reads Position account
                              asserts: sizeUsd ≤ maxLeverage × collateralUsd
                              if fails → revert entire atomic transaction
```

### Existing scaffolding in codebase

| Component | Location | Status |
|---|---|---|
| `PostAssertionFailed` error (6076) | errors.rs:250 | EXISTS |
| `InvalidPostAssertionIndex` error (6077) | errors.rs:253 | EXISTS |
| `has_post_assertions: u8` on PolicyConfig | policy.rs:92 | EXISTS |
| `bytes_match()` helper | generic_constraints.rs:165 | EXISTS, labeled "for Phase B reuse" |
| Full design spec | FUTURE.md:355 | EXISTS (StateAssertions PDA, 229 bytes) |

### No technical blockers

- **CPI depth:** finalize_session reads accounts directly (AccountInfo::try_borrow_data), no CPI
- **Account ownership:** any instruction can READ any account's data regardless of owner
- **Deserialization:** NOT NEEDED — same raw-bytes-at-offset pattern as DataConstraints
- **Compute cost:** trivial (~200-500 CU per assertion, well within 1.4M budget)

### The cross-multiplication trick

Every perp DEX uses this (GMX, dYdX, Flash Trade's own `check_leverage()`):

```
Instead of:   sizeUsd / collateralUsd ≤ maxLeverage    (division, expensive)
Cross-multiply: sizeUsd ≤ maxLeverage × collateralUsd  (multiplication, cheap)
```

### Implementation phases

**Phase B1 (~3-5 days):** Absolute value assertions.
"Position sizeUsd at offset 140 must be ≤ X." Covers position size caps. Reuses `bytes_match()` directly.

**Phase B2 (~3-5 days):** Delta assertions.
MaxDecrease, MaxIncrease, NoChange. Requires SessionAuthority snapshot storage (+65 bytes). Covers balance protection.

**Phase B3 (~5-7 days):** Cross-field ratio assertions.
New `CrossFieldLte` operator: reads two offsets from the same account, checks `field_A ≤ constant × field_B`. This IS leverage enforcement. Protocol-agnostic — just bytes at configured offsets.

### What the vault owner sees in the dashboard

```
Protocol: Flash Trade
Instruction: Open Position
Post-Execution Assert:
  Account: Position PDA
  Leverage limit: 10x
  (translates to: sizeUsd[offset 140] ≤ 10 × collateralUsd[offset 172])
```

---

## Layout Changes (zero-cost, same sizes)

### ConstraintEntryZC (560 bytes, unchanged)

```
program_id:          32
data_constraints:    320 (8 × 40)
account_constraints: 200 (5 × 40)
data_count:          1
account_count:       1
is_spending:         1    ← NEW (0=Unset, 1=Spending, 2=NonSpending)
position_effect:     1    ← NEW (0=None, 1=Increment, 2=Decrement)
_padding:            4    ← reduced from 6
TOTAL:               560  ← same
```

### InstructionConstraints (35,880 bytes, unchanged)

```
vault:               32
entries:             35,840 (64 × 560)
entry_count:         1
strict_mode:         1
bump:                1
constraint_version:  1    ← NEW (0=legacy, 1=v2)
_padding:            4    ← reduced from 5
TOTAL:               35,880 ← same
```

### AgentEntry (saves 7 bytes per entry)

```
// BEFORE:
agent:       32
permissions: 8    (u64, 21-bit bitmask)
paused:      1
spending_limit_usd: 8
bump:        1
TOTAL:       50

// AFTER:
agent:       32
capability:  1    (u8: 0=Disabled, 1=Observer, 2=Operator, 3=Reserved)
paused:      1
spending_limit_usd: 8
bump:        1
_reserved:   7    (maintain layout size for backward compat)
TOTAL:       50   (same size, 7 bytes freed as reserved)
```

### PostExecutionAssertions PDA (NEW, ~236 bytes)

```
discriminator:   8
vault:           32
entries:         192 (4 × 48)
entry_count:     1
bump:            1
_padding:        2
TOTAL:           236
```

---

## Migration Path

### Phase 1: Add fields, support both models (backward compatible)

1. Add `is_spending` (tri-state) and `position_effect` to `ConstraintEntryZC`
2. Add `constraint_version` to `InstructionConstraints`
3. Replace `permissions: u64` with `capability: u8` in `AgentEntry` (maintain layout size)
4. New `validate_and_authorize_v2` instruction (without ActionType):
   - Requires `constraint_version >= 1`
   - Reads `is_spending` from matched entry
   - Checks `capability >= 2` for spending entries
5. Old `validate_and_authorize` (with ActionType) continues to work unchanged
6. `migrate_constraints_v2()` instruction:
   - Owner classifies each entry's `is_spending` (1 or 2)
   - Sets `position_effect` per entry
   - Bumps `constraint_version` to 1
   - Atomic — all entries updated in one TX
7. Agent migration: existing `permissions != 0` → `capability=2`, `permissions == 0` → `capability=0`
8. SDK ships both old and new instruction builders

### Phase 2: Deprecate ActionType (90-day window)

1. Old `validate_and_authorize` emits deprecation event
2. Dashboard shows "upgrade your agent SDK" banner
3. `max_leverage_bps` on PolicyConfig emits deprecation event when checked
4. New entries created with `constraint_version >= 1` MUST have `is_spending != 0`

### Phase 3: Remove ActionType (breaking change)

1. Remove old `validate_and_authorize` instruction
2. Remove `ActionType` enum from program
3. Remove old `permissions: u64` interpretation (capability field is sole check)
4. Zero `max_leverage_bps` field (inert)
5. SDK removes `actionType` and `leverage_bps` parameters

### Phase B: Post-execution assertions (parallel track)

Can ship independently of Phases 1-3. Depends on `finalize_session` changes only.

1. B1: Create `PostExecutionAssertions` PDA + absolute value assertions
2. B2: SessionAuthority snapshot storage + delta assertions
3. B3: `CrossFieldLte` operator for leverage ratio enforcement

---

## Risks

1. **Existing vaults without constraints** — Must create constraints before using new model. Version gate prevents accidental activation. Old model continues working.

2. **Partial migration** — Version gate is per-account, not per-entry. Migration instruction sets ALL entries and bumps version atomically. No partial state.

3. **Multi-agent specialization lost temporarily** — 2-bit capability only distinguishes spending/non-spending, not per-instruction. Phase 2 deny-list PDA addresses this.

4. **Protocol layout changes** — Post-execution assertions depend on known byte offsets. Protocol upgrades that change Position account layout silently invalidate assertions. Dashboard must track protocol versions and alert vault owners. Annotation registry needs version metadata.

5. **Cross-field compute cost** — `CrossFieldLte` operator requires u64 multiplication on-chain. Checked_mul prevents overflow. ~100 CU per assertion — negligible against 1.4M budget.

---

## Resolved Questions

### Q1: `is_spending` default → Tri-state + version gate
Council consensus. Adversarially validated (6/6 attack vectors failed). Belt-and-suspenders: Unset (0) defaults to spending in all code paths. Version gate prevents unmigrated data from reaching new code path.

### Q2: Permission bitmask → 2-bit capability field
Council consensus. Adversarial researcher disproved full removal (vaults without constraints, standalone instructions) but validated the 2-bit replacement. 21 abstract categories replaced by Disabled/Observer/Operator roles.

### Q3: `leverage_bps` → Post-execution account assertions
Council consensus (Option B-Prime). Adversarial researcher corrected the RFC: no DeFi protocol has an explicit leverage field. Leverage research confirmed post-execution assertions are feasible with existing scaffolding. `CrossFieldLte` operator is the novel contribution.

---

## Competitive Advantage

Post-execution account assertions are **novel on Solana**. No other middleware:
- Reads another program's Position account state after execution
- Enforces vault-owner-defined leverage limits within atomic transactions
- Does this protocol-agnostically (raw bytes at offsets, no imports)

This is the same bytes-at-offset pattern Sigil uses for instruction data constraints, extended to account data. The scaffolding (error codes, PolicyConfig flag, bytes_match helper) already exists.

Combined with the constraint builder's 99.87% IDL coverage and the 3-tier enforcement model, this creates a moat that is:
- **Technically deep** (zero-copy layouts, cross-field operators, atomic assertions)
- **IP-protected** (constraint encoding in private repo)
- **Protocol-agnostic** (works with any DeFi program that has readable account state)
