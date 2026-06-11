# M-1 Council — Round 2 Synthesis

Major shifts. Two engineering abstractions emerged that change the math.

---

## R2 vote tally

| Voice | R1 vote | R2 vote | Shift? |
|---|---|---|---|
| **Jordan** | α | **α (holds)** — conditional on LiteSVM cancel-race invariant test gate | No |
| **Ava** | γ | **δ (shifts γ → δ)** — concedes Marcus's drift framing, bitmask was oversold | YES |
| **Sam** | δ | **α (shifts δ → α)** — conditional on building `PendingGuard<T>` RAII abstraction first | YES |
| **Marcus** | α | **α (holds)** — conditional on `PendingLifecycle` helper module + CI grep test + LiteSVM drop tests | No |
| **Riley** | δ | **δ (holds + refined)** — mechanized trait split + optional γ bitmask overlay; cancel-race kills α from ops lens | No |

**R2 raw count:** α = 3 (conditional), δ = 2

---

## Two engineering abstractions emerged

Both Sam and Marcus, independently, proposed the same structural solution to T3 (cancel-handler race) — make flag-flip impossible-to-forget at the language level:

### Sam's proposal: `PendingGuard<T>` (RAII)

```rust
// state/pending_lifecycle.rs (sketch)
pub struct PendingGuard<'a> {
    flag: &'a mut bool,
    committed: bool,
}

impl<'a> PendingGuard<'a> {
    pub fn open(flag: &'a mut bool) -> Self {
        *flag = true;
        Self { flag, committed: false }
    }
    pub fn commit(mut self) { self.committed = true; /* keep flag=true */ }
}

impl<'a> Drop for PendingGuard<'a> {
    fn drop(&mut self) {
        if !self.committed { *self.flag = false; }  // cancel-reset on Drop
    }
}
```

Queue handler creates guard. Apply handler calls `.commit()`. Cancel handler does nothing → Drop fires → flag auto-resets. **Forgetting cancel-reset becomes a compile error pattern, not a runtime ghost.**

### Marcus's proposal: `PendingLifecycle` helper + CI grep

```rust
// state/pending_lifecycle.rs (sketch)
pub fn open(flag: &mut bool)   { *flag = true; }
pub fn apply(flag: &mut bool)  { /* no-op or assertion */ }
pub fn cancel(flag: &mut bool) { *flag = false; }
```

Every queue/apply/cancel handler funnels through these 3 functions. CI parses `instructions/*.rs` and fails build if any `has_pending_*` mutation happens outside `pending_lifecycle::*`.

**Both abstractions solve the cancel-race problem.** They're complementary — could combine RAII (Sam) for runtime safety AND grep-test (Marcus) for compile-time discipline.

---

## What's still contested

Even WITH the helper/RAII abstraction:

| Question | α camp answer | δ camp answer |
|---|---|---|
| Should ALL 6 PDAs use flags? | YES — uniform mental model, contributor #7 can't drift if there's only one pattern | NO — flags only for re-init-collision threats (`pending_owner`, `pending_agent_grant`); events for pure-rent classes |
| Schema cost | +14 bytes (PolicyConfig +4, AgentVault +10) — rounding error | +2 bytes — right-sized for actual threat |
| Ephemeral observability | Flags + on-chain hard-fail | Events (visible to ALL indexers — Helius/Geyser/customer SOC) |
| Drift in 2027 | Single rule, can't misapply | Mechanized trait split per Riley + Sam — can't misapply either |

The structural-helper question is settled. The **scope question (all 6 vs 2+3) is not.**

---

## Riley's tier-3 wrinkle (γ overlay)

Riley conceded that γ's caller-attested bitmask has value as **defense-in-depth on top of δ events**: SDK attests "I expected to drain these N ephemerals", close_vault validates that all attested PDAs are present. +2 bytes ix args. Ava's R2 already showed γ's `bitmask=0` failure mode can be closed by bidirectional validation.

This produces a possible **δ+γ hybrid** that isn't on the original option list:
- 2 flags for state-protocol PDAs (hard-fail like `pending_policy`)
- Events for 3 ephemeral PDAs
- 5-bit bitmask in ix args, validated by close_vault against passed accounts (defense-in-depth, catches SDK bugs)

---

## R3 task — CONVERGENCE round

Each voice answers:

1. **Does the structural helper (PendingGuard/PendingLifecycle/grep test) settle the cancel-race for you?** Yes / No / Partially. If no, what residual concern remains?

2. **Given the helper is on the table, what is your FINAL vote?** This is the convergence round. Pick one:
   - α (full flags for all 6 PDAs)
   - δ (flags for 2 state-protocol + events for 3 ephemeral)
   - δ+γ (flags + events + caller-attested bitmask defense-in-depth)
   - ε (status quo + docs only)

3. **One risk you most fear in the OPPOSING winning option.** If your preferred option loses, what's the single risk you want pre-emptively addressed? Give the engineering team something to mitigate.

4. **Hard convergence test:** would you accept the other camp's option if (a) the structural helper is built, and (b) your top risk is mitigated? Yes / No.

Format: ~200 words. Tight. Convergence-oriented, not adversarial. The point of R3 is to find the path everyone can live with.
