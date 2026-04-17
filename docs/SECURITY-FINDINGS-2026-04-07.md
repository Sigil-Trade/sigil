# Security Findings — 2026-04-07

**Status:** INTERNAL — Phase 1.5 closure pass in progress
**Source:** Phase 1 Sigil Constraint Engine Foundation Sprint verification pass + Gate 5 code review + Phase 1.5 addendum
**Verifier:** Multi-agent pentest + silent-failure-hunter + code-reviewer against live source

**Closure status as of 2026-04-08 (Phase 1.5 FULL CLOSE):** 10 of 16 findings CLOSED + 1 COVERED. All CRITICAL + HIGH + MEDIUM-above-the-line items are now closed including Finding 3 (A9 CPI guard on 28 handlers via `reject_cpi!()` macro, commit 37485ac). Remaining: Finding 8b (chunked encoding DOS — new), Findings 10/11/13/14/16 (LOW or test-only), META items (route test coverage, CPI regression harness), plus Phase 1 deferred items — all Phase 1.6 / Phase 2 prereqs.

| # | Finding | Severity | Status | Commit |
|---|---|---|---|---|
| 1 | A5 discriminator anchor invariant | CRITICAL (9) | ✅ **CLOSED** | 40beafe |
| 2 | A3 zero-mask Bitmask wildcard | HIGH (7) | ✅ **CLOSED** | 4bf7463 |
| 3 | A9 CPI guard on 28 handlers (Pentester said 27, actual count 28 incl. close_settled_escrow) | MEDIUM (6) | ✅ **CLOSED** | 37485ac |
| 4 | toDxError string-code collapse | CRITICAL | ✅ **CLOSED** | 6e904fb |
| 5 | getVaultActivity silent swallow | HIGH | ✅ **CLOSED** | c7774ae |
| 6 | RPC proxy X-Real-IP bypass | HIGH | ✅ **CLOSED** | 3403518 |
| 7 | RPC proxy forward-raw body | MEDIUM | ✅ **CLOSED** | 5065c36 |
| 8 | RPC proxy body buffer DOS | HIGH | ✅ **CLOSED (partial — see 8b)** | 3403518 |
| 8b | RPC proxy chunked-encoding DOS | MEDIUM | ⏳ open (new, surfaced during Finding 8 close) | — |
| 9 | RPC proxy LRU eviction refresh | MEDIUM | ✅ **CLOSED** | 5065c36 |
| 10 | Content-Type check before rate limit | LOW | ⏳ open (cosmetic reorder) | — |
| 11 | HTTP 200 for parser/envelope errors | LOW | ⏳ open (JSON-RPC compliance judgment) | — |
| 12 | Parser nested Option<i64> signedness | MEDIUM | ✅ **CLOSED** | ec640f2 |
| 13 | Integration test hermeticity + Windows path | MEDIUM (test) | ⏳ open (Phase 1.6) | — |
| 14 | Parser allArgs post-boundary drops | LOW | ⏳ open (introspection gap) | — |
| 15 | Missing Option<i64> fixture | LOW | ✅ **COVERED** by ec640f2 fixtures 16+17 | ec640f2 |
| 16 | 0.9 integration pass-rate threshold | LOW | ⏳ open | — |
| — | Sigil-dashboard route unit test coverage | META | ⏳ open (Phase 1.6 prereq, raised by monitoring agent) | — |

---

## Summary

Phase 1 Steps 1–6 implementation landed cleanly (5 commits across
`agent-middleware` + `sigil-dashboard/v2-rebuild`). The Step 7 Pentester
verification of the on-chain constraint engine (A5/A3/A9) revealed
**three still-vulnerable findings that defeat the constraint engine
moat**. In parallel, the silent-failure-hunter and Pentester reviews of
the SDK and RPC proxy surfaced **one CRITICAL** (error code collapse)
and **one HIGH** (rate limit bypass) that the Phase 1 implementation did
not close.

**Per the Phase 1 plan STOP rule, Phase 1 cannot close until A5 and A3
are fixed.** A9 is ~18% fixed and needs to be completed to full 33/33
coverage. The SDK CRITICAL and RPC HIGH should also be addressed before
the Phase 1 commits can be considered production-safe.

| # | Finding | Severity | Layer | Location |
|---|---|---|---|---|
| 1 | A5 — Discriminator anchor invariant missing | **9 (CRITICAL)** | on-chain | `programs/sigil/src/state/constraints.rs:107-136` + `programs/sigil/src/instructions/integrations/generic_constraints.rs:179-200` |
| 2 | A3 — Zero-mask Bitmask wildcard | **7 (HIGH)** | on-chain | `programs/sigil/src/instructions/integrations/generic_constraints.rs:149-160` + test at 686-691 |
| 3 | A9 — CPI guard missing on 27 of 33 state-mutating instructions | **6 (MEDIUM)** | on-chain | 27 files in `programs/sigil/src/instructions/` |
| 4 | `toDxError` collapses string SDK codes to 7000 | **CRITICAL** | SDK | `sdk/kit/src/dashboard/errors.ts:15-19` |
| 5 | `getVaultActivity` catch swallows silently with no logging | **HIGH** | SDK | `sdk/kit/src/dashboard/reads.ts:175` |
| 6 | RPC proxy trusts client-set `X-Real-IP` | **HIGH** | dashboard | `sigil-dashboard/src/app/api/rpc/route.ts:93-103` |
| 7 | RPC proxy forwards raw body instead of re-serialized validated body | **MEDIUM** | dashboard | `sigil-dashboard/src/app/api/rpc/route.ts:233` |

---

## Finding 1 — A5: Discriminator anchor invariant missing

**Severity:** 9 (CRITICAL)
**Layer:** on-chain program
**Files:**
- `programs/sigil/src/state/constraints.rs:107-136` (`validate_entries`)
- `programs/sigil/src/instructions/integrations/generic_constraints.rs:179-200` (`verify_data_constraints_zc`)
- `programs/sigil/src/instructions/integrations/generic_constraints.rs:223-253` (`verify_against_entries_zc`)

### Problem

`validate_entries()` only checks:
- `entries.len() <= MAX_CONSTRAINT_ENTRIES`
- `data_constraints.len() <= MAX_DATA_CONSTRAINTS_PER_ENTRY`
- `account_constraints.len() <= MAX_ACCOUNT_CONSTRAINTS_PER_ENTRY`
- Entry is not *fully* empty (must have at least one of data OR account constraints)
- `dc.value.len() <= MAX_CONSTRAINT_VALUE_LEN`
- `dc.value.len() != 0`

**Nothing requires that any DataConstraint targets offset=0 with an Eq
operator and a non-zero ≥8-byte value matching the instruction
discriminator.** A constraint entry with `data_constraints = []` and
only `account_constraints = [...]` passes validation.

At runtime, `verify_data_constraints_zc` iterates
`data_constraints[0..data_count]`. When `data_count == 0` the loop
never runs and `data_ok` is trivially `Ok(())`. Combined with a
matching `program_id`, the entry accepts any instruction payload.

### Proof of Concept

1. Owner calls `create_instruction_constraints` with:
   ```rust
   entries: vec![ConstraintEntry {
       program_id: JUPITER_PROGRAM,
       data_constraints: vec![],   // empty — passes validation
       account_constraints: vec![AccountConstraint {
           index: 6,
           expected: EXPECTED_USDC_MINT,
       }],
   }]
   ```
2. `validate_entries` passes (entry has at least one constraint).
3. Agent submits a Jupiter instruction where:
   - `program_id == JUPITER_PROGRAM`
   - First 8 bytes of `ix.data` are the discriminator of
     `setTokenLedger` or any other Jupiter instruction — **NOT the
     constrained `route` / `shared_accounts_route`**
   - Account index 6 happens to be the USDC mint pubkey (Jupiter
     instructions share account layouts)
4. `verify_against_entries_zc` finds the program_id match →
   `verify_data_constraints_zc` returns `Ok(())` (loop skipped,
   `data_count == 0`) → `verify_account_constraints_zc` passes →
   `any_passed = true` → instruction is allowed.

**The constraint engine was bypassed at the data-check layer.** The
dashboard UI would show this policy as "USDC mint pinned on Jupiter
route" but in reality ANY Jupiter instruction with the correct USDC
mint in account slot 6 is allowed.

### Specificity note

The only `discriminator` references in the runtime path
(`validate_and_authorize.rs:157, 274` and `state/mod.rs:63
FINALIZE_SESSION_DISCRIMINATOR`) check the **finalize_session
instruction discriminator** (sandwich-end marker) and the **8-byte
Anchor account-data discriminator** (account deserialization). Neither
is the user-supplied DataConstraint must-anchor-on-the-target-instruction
discriminator. The conflation the original report warned about is real.

### Recommended fix

In `validate_entries`, add:
```rust
for entry in entries {
    // ... existing checks ...

    // Fix A5: the first DataConstraint must anchor on the target
    // instruction discriminator. This is the *instruction*
    // discriminator (ix.data[0..8]), NOT the account-data discriminator.
    require!(
        !entry.data_constraints.is_empty(),
        SigilError::InvalidConstraintConfig
    );
    let first = &entry.data_constraints[0];
    require!(
        first.offset == 0,
        SigilError::InvalidConstraintConfig
    );
    require!(
        first.operator == ConstraintOperator::Eq as u8,
        SigilError::InvalidConstraintConfig
    );
    require!(
        first.value.len() >= 8 && first.value.iter().any(|&b| b != 0),
        SigilError::InvalidConstraintConfig
    );
}
```

Also document in `ConstraintEntry` that `data_constraints[0]` is the
discriminator anchor and cannot be omitted. Update the SDK
`constraints/` module (now in `sdk/kit/src/constraints/`) to always
emit a discriminator anchor as the first DataConstraint when compiling
user rules.

**Effort:** ~50 LOC + 5 tests + SDK update. 3 days.

---

## Finding 2 — A3: Zero-mask Bitmask wildcard

**Severity:** 7 (HIGH)
**Layer:** on-chain program
**Files:**
- `programs/sigil/src/instructions/integrations/generic_constraints.rs:149-160` (`bitmask_check`)
- `programs/sigil/src/instructions/integrations/generic_constraints.rs:686-691` (`bitmask_zero_mask_always_passes` — asserts the broken semantic is intended)

### Problem

```rust
pub(crate) fn bitmask_check(actual: &[u8], mask: &[u8]) -> bool {
    for (i, &m) in mask.iter().enumerate() {
        let a = if i < actual.len() { actual[i] } else { 0x00 };
        if (a & m) != m {
            return false;
        }
    }
    true
}
```

When `m == 0`, `(a & 0) == 0 == m` is always true. A Bitmask constraint
with all-zero `value` bytes is a universal wildcard.

**The broken semantic is codified-as-intended** by a passing unit test
at line 686-691:
```rust
#[test]
fn bitmask_zero_mask_always_passes() {
    assert!(bitmask_check(&[0x00], &[0x00]));
    assert!(bitmask_check(&[0xFF], &[0x00]));
    assert!(bitmask_check(&[0x42], &[0x00]));
}
```
This test must be deleted and replaced with a `bitmask_zero_mask_rejected` test.

`validate_entries` (constraints.rs:107-136) does not branch on
`dc.operator` — there is no `match dc.operator { Bitmask => ... }`
rejection of all-zero masks.

### Proof of Concept

```rust
DataConstraint {
    offset: 0,
    operator: ConstraintOperator::Bitmask,
    value: vec![0u8; 8],   // 8 zero bytes — passes all length/emptiness checks
}
```

`validate_entries` accepts (length OK, non-empty, value.len() > 0).
`bitmask_check(any_actual, [0;8])` always returns `true`. The
constraint becomes a no-op posing as a guard.

**Combined with A5**, a single constraint entry with
`data_constraints = [Bitmask{offset:0, value:[0;8]}]` and no
account_constraints is a fully-permissive whitelist for the program_id,
while the dashboard UI shows it as "8-byte instruction discriminator
constrained".

### Recommended fix

In `validate_entries` (constraints.rs), inside the per-entry loop:
```rust
for dc in &entry.data_constraints {
    // ... existing checks ...

    // Fix A3: reject zero-mask Bitmask constraints — they are
    // universal wildcards that defeat byte-level filtering.
    if dc.operator == ConstraintOperator::Bitmask as u8 {
        require!(
            dc.value.iter().any(|&b| b != 0),
            SigilError::InvalidConstraintConfig
        );
    }
}
```

And in `generic_constraints.rs`, delete the
`bitmask_zero_mask_always_passes` test and replace with:
```rust
#[test]
fn bitmask_zero_mask_rejected() {
    // validate_entries must reject zero-mask Bitmask constraints
    // before they reach pack_entries. bitmask_check is unreachable
    // for zero masks in production.
}
```

**Effort:** ~5 LOC + 1 test replacement. 1 day.

---

## Finding 3 — A9: CPI guard missing on 27 of 33 state-mutating instructions

**Severity:** 6 (MEDIUM)
**Layer:** on-chain program
**Files:** 27 handler files in `programs/sigil/src/instructions/`

### Status per handler

| FIXED (6) | MISSING (27) |
|---|---|
| `validate_and_authorize.rs:119-124` | `initialize_vault.rs` |
| `finalize_session.rs:92-95` | `close_vault.rs` |
| `create_escrow.rs:107-110` | `deposit_funds.rs` |
| `settle_escrow.rs:73-76` | `withdraw_funds.rs` |
| `refund_escrow.rs:61-64` | `freeze_vault.rs` |
| `agent_transfer.rs:85-88` | `reactivate_vault.rs` |
| | `register_agent.rs` |
| | `revoke_agent.rs` |
| | `pause_agent.rs` |
| | `unpause_agent.rs` |
| | `queue_policy_update.rs` |
| | `apply_pending_policy.rs` |
| | `cancel_pending_policy.rs` |
| | `queue_agent_permissions_update.rs` |
| | `apply_agent_permissions_update.rs` |
| | `cancel_agent_permissions_update.rs` |
| | `allocate_constraints_pda.rs` |
| | `allocate_pending_constraints_pda.rs` |
| | `create_instruction_constraints.rs` |
| | `queue_constraints_update.rs` |
| | `apply_constraints_update.rs` |
| | `cancel_constraints_update.rs` |
| | `queue_close_constraints.rs` |
| | `apply_close_constraints.rs` |
| | `cancel_close_constraints.rs` |
| | `extend_pda.rs` |
| | `sync_positions.rs` |
| | `close_settled_escrow.rs` |

### Inverse-attack vector (the specific concern)

The CPI guard on `validate_and_authorize` alone does NOT close the
inverse attack — it only closes the case where the sandwich entry
instruction is itself nested. Re-entry into any other handler bypasses
it. Most dangerous gaps:

- **`withdraw_funds`**: owner-signed token transfer out of vault. If
  the owner ever signs a transaction whose downstream CPI chain
  reaches a compromised whitelisted program that re-invokes Sigil's
  `withdraw_funds`, the guard is absent so the re-entry succeeds.
  Anchor's `Signer<'info>` check passes because `is_signer` is
  propagated through CPI for accounts the owner already signed for.
- **`close_vault`**: owner-signed vault close + rent reclaim. Same
  re-entry vector.
- **`apply_pending_policy` / `apply_constraints_update` /
  `apply_close_constraints`**: state-mutating "apply" handlers that
  finalize queued changes. CPI re-entry could be used to apply a
  policy update mid-execution of another sandwich, racing the timelock.
- **`allocate_*` and `extend_pda`**: rent-payer manipulation. A CPI
  re-entry could be steered to siphon lamports if the rent payer is
  also a signer of the outer transaction.
- **`register_agent` / `revoke_agent` / `pause_agent` /
  `unpause_agent`**: permission flips. CPI re-entry mid-sandwich could
  grant or revoke an agent permission between `validate_and_authorize`
  and `finalize_session`.

### Recommended fix

Factor the guard into a helper macro:
```rust
// programs/sigil/src/utils.rs (or similar)
#[macro_export]
macro_rules! require_top_level {
    () => {
        require!(
            solana_program::sysvar::instructions::get_stack_height()
                == solana_program::sysvar::instructions::TRANSACTION_LEVEL_STACK_HEIGHT,
            $crate::errors::SigilError::CpiNotAllowed
        )
    };
}
```

Call `require_top_level!()` at the top of every mutating handler's
`handler` function. Alternatively use Anchor's `#[access_control]`
attribute so future handlers cannot forget. Re-run Trident fuzz + Sec3
X-Ray to confirm no regression.

**Effort:** ~2 lines × 27 handlers + 1 macro + 1 regression test per
handler. 2 days including test matrix.

---

## Finding 4 — `toDxError` collapses string SDK codes to 7000

**Severity:** CRITICAL
**Layer:** SDK (`@usesigil/kit/dashboard`)
**File:** `sdk/kit/src/dashboard/errors.ts:15-19`

### Problem

```ts
const code = (() => {
  const n = Number(agentErr.code);
  return Number.isFinite(n) ? n : 7000;
})();
```

`toAgentError` returns **string** codes for every SDK-pattern and
fallback branch (`agent-errors.ts:1855-1878`, `1883`, `2188`):
`"RPC_ERROR"`, `"NETWORK_ERROR"`, `"EXECUTION_FAILED"`,
`"SIMULATION_FAILED"`, `"PRECHECK_FAILED"`,
`"ADAPTER_VERIFICATION_FAILED"`, `"UNKNOWN"`, etc.

`Number("RPC_ERROR") → NaN → Number.isFinite(NaN) === false → 7000`.
Every non-on-chain error collapses to the same code. `NETWORK_ERROR`
happens to equal 7000 by coincidence, but `RPC_ERROR` (real 7001),
`SIMULATION_FAILED` (7002), account-not-found, stray TypeErrors all
become indistinguishable 7000s in `DxError.code`.

**The audit's stated goal — "real on-chain code or SDK code, NOT
generic 7000" — is broken for 6 out of 7 SDK branches and for every
unmatched error.** Affects all 6 read methods after Phase 1 Step 4
AND all pre-existing mutations.

### Recommended fix

Add a name → number lookup before the `Number()` coercion:
```ts
import { SDK_ERROR_CODES } from "../agent-errors.js";

const SDK_CODE_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(SDK_ERROR_CODES).map(([n, s]) => [s, Number(n)]),
);

// ... inside toDxError ...
const code =
  typeof agentErr.code === "string" && SDK_CODE_BY_NAME[agentErr.code] != null
    ? SDK_CODE_BY_NAME[agentErr.code]
    : Number.isFinite(Number(agentErr.code))
      ? Number(agentErr.code)
      : 7999; // sentinel for "unmappable"
```

**Effort:** ~15 LOC + 3 tests. 30 minutes.

---

## Finding 5 — `getVaultActivity` catch swallows silently

**Severity:** HIGH
**Layer:** SDK (`@usesigil/kit/dashboard`)
**File:** `sdk/kit/src/dashboard/reads.ts:175`

### Problem

```ts
getVaultActivity(rpc, vault, 100, toNet(network)).catch(() => []),
```

Zero observability. If Helius silently rate-limits
`getSignaturesForAddress`, every dashboard call shows "last action:
never" for every agent forever and nobody notices.

### Recommended fix

```ts
getVaultActivity(rpc, vault, 100, toNet(network)).catch((err) => {
  console.warn("[OwnerClient.getAgents] activity enrichment failed:", err);
  return [];
}),
```

Or emit a metric/breadcrumb via whatever observability hook is
available in the SDK. At minimum, do not swallow anonymously.

**Effort:** ~3 LOC. 5 minutes.

---

## Finding 6 — RPC proxy trusts client-set `X-Real-IP`

**Severity:** HIGH
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:93-103` (`getClientIp`)

### Problem

The rate limiter reads `x-real-ip` first, with fallback to leftmost
`x-forwarded-for`. On Vercel's edge, `x-real-ip` is platform-set and
safe. But `runtime = "nodejs"` means this also runs in self-hosted,
dev, preview, and non-Vercel environments where the header is
**attacker-controlled**. A client can set `X-Real-IP: <random>` per
request and rotate rate-limit buckets indefinitely.

### Proof of Concept

```bash
for i in $(seq 1 1000); do
  curl -s -X POST https://target/api/rpc \
    -H "Content-Type: application/json" \
    -H "X-Real-IP: 10.0.0.$((RANDOM%255))" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["So11111111111111111111111111111111111111112"]}'
done
```

Every request gets a fresh bucket. **Rate limit effectively = none.**

Compounds with the LRU eviction at 10,000 IPs — attacker-rotated IPs
also evict legitimate users' buckets.

### Recommended fix

Use `NextRequest.ip` (trusted on Vercel) or
`x-vercel-forwarded-for`. Document that the route MUST be fronted by
Vercel's edge. Reject requests where the trusted header is absent, or
fall back to a shared global bucket — never a client-header-derived
bucket.

```ts
function getClientIp(request: NextRequest): string {
  // Vercel sets this from the edge — trusted.
  const vercelIp = request.headers.get("x-vercel-forwarded-for");
  if (vercelIp) return vercelIp.split(",")[0].trim();
  // NextRequest.ip is also platform-populated.
  if (request.ip) return request.ip;
  // Fallback: shared global bucket. Never trust client-set headers.
  return "global";
}
```

**Effort:** ~10 LOC + 1 integration test. 30 minutes.

---

## Finding 7 — RPC proxy forwards raw body instead of re-serialized validated body

**Severity:** MEDIUM (structural — not currently exploitable against Helius)
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:233`

### Problem

```ts
upstreamResponse = await fetch(rpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: bodyText,   // raw text — the validated `body` object is not forwarded
});
```

The proxy validates the *parsed* object but forwards the *original
text*. `JSON.parse` is not round-trip stable — a hostile body can
contain JSON that parses one way for validation and is interpreted
differently by a downstream parser.

Currently not exploitable against Helius because V8 and serde_json
both take the last duplicate key. But any future upstream swap (a
different RPC provider, a caching layer, a WAF) could diverge.

### Recommended fix

Forward the validated, re-serialized body:

```ts
body: JSON.stringify(body),
```

Zero semantic cost, eliminates the entire class of validate-parsed /
forward-raw bugs.

**Effort:** ~1 LOC + comment. 2 minutes.

---

## Related LOW findings (Pentester + silent-failure-hunter)

- **RPC content-length pre-check** (`route.ts:184`): 64KB cap fires
  AFTER `request.text()` buffers. Pre-check `content-length` header.
- **RPC Content-Type startsWith** (`route.ts:173`): `.includes()`
  matches `multipart/form-data; boundary=application/json`. Use
  `startsWith` after media-type parse.
- **RPC null-byte allowlist branch** (`route.ts:143`): `\0` in method
  name hits "not on allowlist" instead of "explicitly blocked" — cosmetic.
- **`toDxError` context loss** (`errors.ts:20`): original `err.message`
  extra context (tx signature, RPC endpoint) dropped when
  `agentErr.message` is used. Consider also including `agentErr.context`
  in `DxError`.
- **`toDxError` ambiguous 7000/7999 sentinels** (`errors.ts:33`): inner
  catch-all falls back to `7999`. Primary flow falls back to `7000`.
  The two are indistinguishable from the outside. Paired with the
  CRITICAL fix above.

---

## Phase 1 close disposition

| Phase 1 Step | Landed | Disposition |
|---|---|---|
| Pre-Phase-1 R1 commits (4) | ✅ | STAND — R1 surface protection, independent of findings |
| v2-rebuild baseline (R2) | ✅ | STAND — 95-file dashboard rebuild protection |
| Step 1-4 SDK bugs (de7ce4d) | ✅ | STAND — dashboard reads bugs are independent of on-chain findings. **Must follow up with Finding 4 (toDxError) fix to meet the ISC-22 bar.** |
| Step 5 RPC proxy (6680469) | ✅ | STAND — shape is correct; **must follow up with Finding 6 (X-Real-IP) fix to meet the ISC-30 bar** and Finding 7 for defense-in-depth |
| Step 6 parser + fixtures (a0edcc5) | ✅ | STAND — parser is correct in isolation; Phase 2 cannot build on top of it until A3/A5 are fixed in the on-chain program |
| Step 7 Pentester verification | ❌ | **STOP — A3/A5/A9 findings filed in this doc.** No `chore(security): verify A5/A3/A9` commit because there are no fixes to verify. |

**No PR opened to either repo.** The landed commits stay local until
Findings 1–6 are addressed (at minimum Findings 1, 2, 4, 6 — the
CRITICAL/HIGH items).

---

## Next cycle scope

A clean Phase 1.5 should include:

1. **Finding 2 (A3) fix** — smallest patch, closes the most exploitable
   wildcard. 5 LOC + test replacement.
2. **Finding 1 (A5) fix** — discriminator anchor invariant. Requires
   SDK update to always emit the anchor as `data_constraints[0]`.
3. **Finding 4 (toDxError) fix** — name → number lookup. 15 LOC.
4. **Finding 6 (X-Real-IP) fix** — use `request.ip` /
   `x-vercel-forwarded-for`. 10 LOC.
5. **Finding 3 (A9) fix** — factor into `require_top_level!()` macro,
   apply to 27 handlers, re-run LiteSVM + Trident.
6. **Finding 5 (getVaultActivity logging)** — 3 LOC.
7. **Finding 7 (forward-raw)** — 1 LOC.
8. **ISC-52 differential fuzz 10K+** — deferred from Phase 1.
9. **16 of the top-20 IDL integration tests** — requires the three-era
   IDL fetcher (`idl-fetch.ts`) from Step 2.
10. **ISC-80/81/82 regression tests** — Bug 1 N+1 pin, Bug 3
    round-trip, cursor math invariant.

Nothing in Phase 1.5 should be committed to the constraint engine
codebase until Findings 1 and 2 land first — those are load-bearing.

---

## Addendum (2026-04-08) — Gate 5 code-review results

After the initial findings above were documented and the Phase 1 STOP
disposition was set, the Gate 5 code-reviewer agent (background task
`a8c1be1`) completed its review of the three Phase 1 hotspot commits:
`de7ce4d` (SDK reads), `6680469` (RPC proxy), `a0edcc5` (parser).

**Gate 5 verdict: PASS WITH ONE FIX REQUIRED.**
Count: 0 CRITICAL, 1 HIGH, 3 MEDIUM, 5 LOW.

Commit `de7ce4d` (SDK reads.ts / errors.ts / mutations.ts) was rated
**CLEAN** — all 14 PendingPolicyUpdate fields verified, getPolicy's
inner null-handling confirmed preserved, getAgents activity plumbing
correct (N+1 prevention holds), error propagation sound. No new
findings beyond the CRITICAL / HIGH already recorded above (#4 and #5).

The RPC proxy and parser commits produced new findings.

### Finding 8 — RPC proxy body buffered before size check

**Severity:** HIGH
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:188-200`

Same class as Finding 7's "(d) body size pre-check" LOW note, but
Gate 5 rates it HIGH because the commit advertises "hardening" and the
attacker budget is bigger than the Pentester pass estimated: within
the 60 req/min rate limit, an attacker can push up to the Vercel
Function default (~4.5 MB per request), for **~270 MB/min of ingress
per IP**. Multiplied by the 10,000 tracked IP cap, real DOS vector.

**Fix:** inspect `Content-Length` header before calling
`request.text()` and reject early when it exceeds `MAX_BODY_BYTES`.
Additionally set a Vercel Function `bodyParser.sizeLimit` or the
equivalent Next.js 16 route segment config.

**Effort:** ~10 LOC + 1 test. 30 minutes.

### Finding 9 — RPC proxy LRU eviction can delete the just-refreshed entry

**Severity:** MEDIUM
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:70-78`

`Map.set()` on an existing key does NOT refresh insertion order. A
returning client whose state has expired can be the oldest-insertion
key; the eviction that runs immediately after the `set()` then deletes
the entry we just refreshed, silently resetting that user's budget.

```ts
if (!state || state.resetAt <= now) {
  rateState.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  if (rateState.size > MAX_TRACKED_IPS) {
    const oldest = rateState.keys().next().value;
    if (oldest !== undefined) rateState.delete(oldest);   // ← may delete `ip`
  }
  return true;
}
```

**Fix:** `rateState.delete(ip)` BEFORE the `set`, so the re-inserted
entry is at the end of the order. Then size-cap eviction will target a
genuinely different IP.

**Effort:** ~2 LOC + 1 unit test for LRU ordering. 10 minutes.

### Finding 10 — RPC proxy Content-Type check runs before rate limit

**Severity:** LOW
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:171-185`

An attacker can send invalid-Content-Type requests infinitely without
depleting rate-limit budget. Wastes compute on invalid-content
rejection. Move the Content-Type check below `checkRateLimit`.

**Effort:** ~4 LOC move. 2 minutes.

### Finding 11 — RPC proxy returns HTTP 200 for parser/envelope errors

**Severity:** LOW
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts:124-135, 207, 219`

JSON-RPC 2.0 compliant but standard HTTP tooling (cache layers, error
budget dashboards, CDN logs) sees 200s for malformed input. Consider
HTTP 400 for client-side errors.

**Effort:** ~5 LOC + documentation. 5 minutes. This is a judgment
call — leaving as 200 is also defensible.

### Finding 12 — Parser nested-Option<i64> signedness regression

**Severity:** MEDIUM — **new latent bug introduced by my Phase 1 commit**
**Layer:** SDK / parser
**File:** `sigil-dashboard/src/lib/constraint-parser/parser.ts:310-320` (inside `expandDefinedStruct`)

```ts
const leafOffset = subOffset + (sizeResult.payloadOffset ?? 0);
const leafSize = sizeResult.size - (sizeResult.payloadOffset ?? 0);
result.push({
  name: fieldName, offset: leafOffset, size: leafSize,
  type: idlTypeToFieldType(field.type, leafSize),  // ← bug: passes the outer Option<T>, not T
});
```

When a struct field is `Option<i64>`, `field.type` is `{option: "i64"}`
(an object). `idlTypeToFieldType` sees a non-string type, falls
through to the size-based fallback, and maps `leafSize=8` → `"u64"`.
**Fix #7 (signedness preservation) is silently undone inside nested
structs.** The top-level args branch (parser.ts:443-449) handles this
correctly by extracting the inner `option`/`coption` payload type. The
`expandDefinedStruct` branch does not.

**Fix:** In `expandDefinedStruct`, when `sizeResult.payloadOffset !==
undefined`, unwrap the Option/COption and pass the inner type:

```ts
let leafFieldType: IdlType = field.type;
if (typeof field.type === "object") {
  if ("option" in field.type) leafFieldType = field.type.option;
  else if ("coption" in field.type) leafFieldType = field.type.coption;
}
result.push({
  name: fieldName,
  offset: leafOffset,
  size: leafSize,
  type: idlTypeToFieldType(leafFieldType, leafSize),
});
```

**Regression test:** add an `Option<i64>` fixture to
`parser.test.ts` that wraps an i64 inside a struct field and verifies
the type is `"i64"`, not `"u64"`. See Finding 14 below.

**Effort:** ~10 LOC + 1 test. 15 minutes.

### Finding 13 — Parser integration tests are not hermetic (and break on Windows)

**Severity:** MEDIUM
**Layer:** tests
**File:** `sigil-dashboard/__tests__/constraints/parser.integration.test.ts:33-38`

```ts
const IDL_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "..",
);
```

`IDL_ROOT` resolves to `Middleware-Agent-Layer/` (the **parent** of
`sigil-dashboard/`). The 4 IDL files (`flash-trade-idl.json`,
`jupiter-perpetuals-idl.json`, `idl.json`, `perpetuals.json`) live
there, not inside the dashboard repo. If `sigil-dashboard/` is moved,
cloned standalone, or the IDLs relocated, every integration test
silently `ENOENT`s. Project CLAUDE.md says each sub-project should be
self-contained.

Additionally: `new URL(import.meta.url).pathname` produces a
leading-slash POSIX path but a malformed Windows path (`/C:/...`),
breaking the tests on Windows.

**Fix:**
1. Copy the 4 IDL fixtures into
   `sigil-dashboard/__tests__/constraints/fixtures/idls/`
2. Use `fileURLToPath(import.meta.url)` from `node:url` for
   cross-platform path resolution

**Effort:** ~15 LOC + 4 file copies (~1 MB total). 15 minutes.

### Finding 14 — Parser `allArgs` silently drops fixed args after variable boundary

**Severity:** LOW
**Layer:** SDK / parser
**File:** `sigil-dashboard/src/lib/constraint-parser/parser.ts:499-507`

After `hitVariableBoundary = true`, any subsequent fixed-size arg
(e.g., `u64` after `Vec<u8>`) takes neither the pre-boundary branch
nor the variable-boundary branch, so `allArgs` never gets an entry.
`parsedFields` still correctly throws for constrainable post-boundary
fields, but introspection via `allArgs` cannot distinguish
"not present in the IDL" from "post-boundary fixed".

**Fix:** Always emit an `allArgs` entry with
`{ offset: -1, size: -1, type: "post-variable" }` once past the
boundary.

**Effort:** ~5 LOC. 5 minutes.

### Finding 15 — Parser fixtures miss `Option<i64>` regression guard

**Severity:** LOW — directly enables Finding 12 to regress silently
**Layer:** tests
**File:** `sigil-dashboard/__tests__/constraints/parser.test.ts`

All 8 documented fixes are exercised, but the signedness-preservation
fix (#7) is only tested on BARE primitives — not inside `Option<T>`
or `COption<T>` or nested structs. Finding 12 would have been caught
at commit time with a single extra fixture.

**Fix:** Add an `Option<i64>` fixture with expected type `"i64"` and a
similar `COption<i64>` fixture.

**Effort:** ~20 LOC. 10 minutes.

### Finding 16 — Parser integration pass-rate threshold too lenient

**Severity:** LOW
**Layer:** tests
**File:** `sigil-dashboard/__tests__/constraints/parser.integration.test.ts:129,145,161,177`

Current gate is `passRate >= 0.9` per IDL — up to 10% of instructions
per IDL may silently throw during walking. For parser-foundation work,
project CLAUDE.md's "zero-tolerance" posture toward boundary errors
suggests 100% walk is a more honest gate.

**Fix:** Either tighten the threshold to 1.0, or assert that all
failures are expected "variable-length boundary" errors (not
unknown-primitive / undefined-type / depth-exceeded).

**Effort:** ~10 LOC + possibly expanding the error classification.
20 minutes.

---

## Updated Phase 1.5 order of operations

Merging the original list with the Gate 5 additions (fastest-first
within severity):

1. **Finding 2 (A3, 5 LOC)** — smallest critical on-chain patch
2. **Finding 1 (A5, ~50 LOC + SDK anchor update)** — load-bearing
   on-chain
3. **Finding 4 (toDxError, 15 LOC)** — CRITICAL SDK
4. **Finding 6 (X-Real-IP, 10 LOC)** — HIGH dashboard
5. **Finding 8 (body buffer DOS, 10 LOC)** — HIGH dashboard
6. **Finding 3 (A9, 27 handlers + macro)** — defense-in-depth on-chain
7. **Finding 9 (LRU refresh bug, 2 LOC)** — correctness
8. **Finding 12 (nested Option<i64> signedness, 10 LOC)** — latent
   regression of the Phase 1 Fix #7
9. **Finding 13 (integration test hermeticity, 15 LOC + fixture
   copies)** — portability
10. **Findings 5, 7, 10, 11, 14, 15, 16 (small items)** — cleanup
11. **ISC-52 differential fuzz 10K+**
12. **16 of the top-20 IDL integration tests** (requires
    `idl-fetch.ts` from Step 2 of the Constraint Builder plan)
13. **ISC-80/81/82 regression tests** — Bug 1 N+1 pin, Bug 3
    round-trip, cursor math invariant

Findings 1 and 2 remain load-bearing — nothing in Phase 1.5 touching
the constraint engine codebase should commit until they land.

**2026-04-08 UPDATE — Findings 1 and 2 are CLOSED** (commits 40beafe,
4bf7463). See the Phase 1.5 Closure Addendum below for the full
scoreboard and per-finding closure evidence.

---

## Phase 1.5 Closure Addendum (2026-04-08)

Eleven of the 16 findings documented above are now closed. The remaining
five open items are either load-bearing on-chain work (Finding 3 A9) or
low-severity polish that can ship to Phase 1.6. One NEW finding surfaced
during the Finding 8 close — tracked here as Finding 8b.

### Finding 1 — A5 discriminator anchor invariant → CLOSED

**Commit:** `40beafe` `fix(security): A5 require discriminator anchor invariant`

validate_entries now requires every ConstraintEntry's first DataConstraint
to be `{offset: 0, operator: Eq, value.len() >= 8, value contains at least
one non-zero byte}`. SDK `assembleEntries` updated to reject empty
`dataConstraints` arrays (closes the `length > 0` hole in the existing SDK
anchor check). 10 new Rust regression tests covering every rejection mode
+ the existing A3 tests restructured to include valid discriminator anchors
so they co-exist with A5. SDK test `allows entry with only account
constraints` inverted to assert rejection.

Verification: `cargo test --lib constraints::` = 59 pass (13 new + 46
existing), `anchor build --no-idl` = 4.40s, IDL restored, `pnpm test` =
145 LiteSVM passing, `sdk/kit pnpm test` = 1,212 passing. Known latent
test debt in `tests/instruction-constraints.ts` and
`tests/surfpool-integration.ts` (non-baseline tests) tracked as Phase 1.6
follow-up.

### Finding 2 — A3 zero-mask Bitmask wildcard → CLOSED

**Commit:** `4bf7463` `fix(security): A3 reject zero-mask Bitmask constraints`

validate_entries now rejects any `Bitmask` constraint whose `value` bytes
are all zero. The `bitmask_check` math primitive is left unchanged
(mathematically correct: `(actual & 0) == 0`). Validation-layer rejection
means zero masks never reach `pack_entries`, the zero-copy account, or
`verify_data_constraints_zc` in production. The passing unit test
`bitmask_zero_mask_always_passes` that codified the broken semantic was
removed and replaced with a historical comment pointing to the new tests.

Verification: `cargo test --lib constraints::` = 50 pass (4 new + 46
existing), `anchor build --no-idl`, IDL restored, `pnpm test` = 145
LiteSVM passing. CU impact: `validate+finalize:stablecoin` 67,952 →
72,452 (+4,500 CU per data-constraint check, well inside the 1.4M
budget).

### Finding 3 — A9 CPI guard on 28 handlers → CLOSED

**Commit:** `37485ac` `fix(security): A9 enforce CPI guard on all 28 missing state-mutating handlers`

New `reject_cpi!()` declarative macro added to
`programs/sigil/src/instructions/utils.rs` using fully-qualified paths
so handlers don't need to import `get_stack_height`,
`TRANSACTION_LEVEL_STACK_HEIGHT`, or `SigilError` just to call it.
Applied as `crate::reject_cpi!();` to the first statement of the
handler body in all 28 previously-unguarded handlers.

Handler count note: the initial Pentester finding said 27 missing,
actual count is 28 (the Pentester missed `close_settled_escrow`).
Total state-mutating handlers = 34: 6 pre-existing guarded handlers
(validate_and_authorize, finalize_session, create_escrow,
settle_escrow, refund_escrow, agent_transfer) + 28 newly guarded.

Per-handler list in the commit message; grouped by lifecycle:
account (8), funds (2), agent (4), policy timelock (3), agent
permissions timelock (3), constraints lifecycle (7), position sync
(1). Total 28.

The 6 pre-existing guarded handlers are LEFT INLINE with their
current `require!(get_stack_height() == ...)` pattern. Unifying them
to use the new macro was considered but deferred — refactoring
audited working code expands the diff for zero security benefit.
Noted as Phase 1.6 style cleanup.

**Verification:**
- `cargo fmt` clean
- `cargo check --lib` clean (1.58s)
- `cargo test --lib` → 83 passed, 0 failed (no regressions from
  macro expansion across 28 new call sites)
- `anchor build --no-idl` → 5.56s release profile
- IDL restored per project CLAUDE.md
- `pnpm test` → 145 LiteSVM tests passing (all existing test flows
  still work at top-level stack height where the guard passes)
- `sdk/kit pnpm test` → 1,219 SDK tests passing (sanity — Rust
  changes don't touch TypeScript)

**CPI-exploit regression tests — deferred to Phase 1.6:**
Writing a proper CPI regression test requires deploying a secondary
"malicious" program inside LiteSVM that makes a CPI call into a
Sigil handler, then asserting the transaction fails with
`CpiCallNotAllowed`. **Definitive error code: 6033** (confirmed by
counting enum position from `VaultNotActive` = 6000 in
`programs/sigil/src/errors.rs:110` — `CpiCallNotAllowed` is at
enum position 34, yielding 6033). Both `tests/helpers/litesvm-setup.ts:697`
(`CpiCallNotAllowed: 6033`) and `tests/helpers/surfpool-setup.ts:495`
(`6033: "CpiCallNotAllowed"`) agree. The SPEC comment at
`tests/security-exploits.ts:11441` says "(CpiCallNotAllowed 6034)" —
**off by one vs. the definitive value**; it's a stale unit test SPEC
comment that was never reconciled because the test was never
implemented. When the Phase 1.6 CPI regression test harness is
built, it MUST assert against code **6033**, not 6034, and the stale
comment at security-exploits.ts:11441 should be corrected in the
same commit. The test has never been implemented because the
infrastructure to compile and deploy a secondary program inside
LiteSVM doesn't exist yet. The 6 pre-existing guarded handlers also
lack LiteSVM CPI tests for the same reason. The A9 commit extends
the same pattern (code fix landed, regression tests pending) to the
28 newly-guarded handlers. Tracked as a Phase 1.6 prereq.

### Finding 4 — toDxError string-code collapse → CLOSED

**Commit:** `6e904fb` `fix(sdk): preserve DxError code fidelity via SDK_ERROR_CODES reverse lookup`

Exported `SDK_ERROR_CODES` from `agent-errors.ts`. Built a reverse `name →
number` lookup at module load in `dashboard/errors.ts`. New
`resolveDxCode(rawCode)` helper with priority: (1) named SDK code string
reverse-lookup, (2) numeric string/number passthrough, (3)
`DX_ERROR_CODE_UNMAPPED = 7999` sentinel. 7000 is now unambiguously
`NETWORK_ERROR` — never used as a fallback. 7 new regression tests lock
the invariants in place.

Verification: `sdk/kit pnpm test` = 1,219 passing (7 new + 1,212
existing). No Rust changes → no anchor build cycle.

### Finding 5 — getVaultActivity silent swallow → CLOSED

**Commit:** `c7774ae` `fix(sdk): log getVaultActivity failures instead of swallowing silently`

`.catch(() => [])` replaced with `.catch((err) => { console.warn(...);
return []; })`. Graceful degradation preserved (activity is enrichment —
`getAgents` should still complete on RPC failure), but the error is now
observable via `console.warn`.

### Finding 6 — RPC proxy X-Real-IP bypass → CLOSED

**Commit:** `3403518` `fix(dashboard): close RPC proxy HIGH findings (X-Real-IP + body DOS)`

**Current location (post-refactor):** `getClientIp()` moved from inline in
`route.ts:93-103` to `sigil-dashboard/src/lib/rate-limit.ts:162-169` and is
imported by the route via `import { checkRateLimit, getClientIp } from "@/lib/rate-limit"`.
The fix is intact — only the file location changed.

`getClientIp()` now trusts ONLY `x-vercel-forwarded-for` (platform-set,
stripped from incoming client traffic). When absent (non-Vercel deploy,
dev, preview), all callers share a single `"global"` rate-limit bucket —
noisy but not exploitable. Explicit SECURITY NOTE added to the docstring
that the route MUST be fronted by Vercel's edge in production.

### Finding 7 — RPC proxy forward-raw body → CLOSED

**Commit:** `5065c36` `fix(dashboard): RPC proxy LRU refresh + forward-validated body (Findings 9 + 7)`

Changed `body: bodyText` to `body: JSON.stringify(body)` at the Helius
fetch site. Proxy now forwards the re-serialized validated object, not
the raw client-supplied text.

### Finding 8 — RPC proxy body buffer DOS → CLOSED (partial; see Finding 8b)

**Commit:** `3403518` (same commit as Finding 6)

Added Content-Length pre-check BEFORE `request.text()`. Rejects clients
that declare oversized bodies via the `content-length` header. The
post-buffer `Buffer.byteLength` check remains as defense-in-depth.

**CLOSURE CAVEAT:** This fix rejects the common case where a hostile
client sets `Content-Length: <huge>`, but chunked transfer encoding
(`Transfer-Encoding: chunked`) omits Content-Length entirely, and the
post-buffer check only fires AFTER the full chunked body is read.
Chunked hostile payloads can still reach ~4.5 MB buffered before
rejection. See Finding 8b below.

### Finding 8b — RPC proxy chunked-encoding DOS → NEW, OPEN

**Severity:** MEDIUM (smaller blast radius than the original Finding 8
because chunked encoding is harder to automate at scale, but the same
attacker budget calculation applies within the per-IP rate limit)
**Layer:** dashboard
**File:** `sigil-dashboard/src/app/api/rpc/route.ts` body reading path

**Problem:** The Content-Length pre-check added in commit `3403518`
only fires when the client includes a `content-length` header. A
client using `Transfer-Encoding: chunked` omits Content-Length
entirely — the fetch Web API will still stream the chunked body into
`request.text()` up to whatever Next.js/Vercel Function limit applies.
The `Buffer.byteLength` post-check then rejects, but only AFTER the
full body is buffered in memory.

**Proof of concept:**
```bash
curl -X POST https://target/api/rpc \
  -H "Content-Type: application/json" \
  -H "Transfer-Encoding: chunked" \
  --data-binary @hostile-chunked-payload-4mb.json
```
The payload buffers to ~4 MB before `Buffer.byteLength` rejects.

**Recommended fix (two options):**
1. **Stream-based size accounting:** Instead of `await request.text()`,
   read the body via `request.body` (a `ReadableStream`), accumulate
   bytes in a loop, and abort the stream when
   `accumulated > MAX_BODY_BYTES`. Reject without buffering the rest.
2. **Reject chunked encoding entirely:** If `Transfer-Encoding: chunked`
   is set AND Content-Length is absent, reject with a JSON-RPC error.
   Legitimate JSON-RPC clients always know the body size in advance.

Option 2 is simpler but slightly more restrictive. Option 1 is more
permissive but more complex.

**Effort:** ~20-30 LOC + 1 regression test. 30-45 minutes. Deferred
to the next Phase 1.5 close-out cycle.

### Finding 9 — RPC proxy LRU eviction refresh → CLOSED

**Commit:** `5065c36` (same commit as Finding 7)

Added explicit `rateState.delete(ip)` before `rateState.set(ip, ...)`
so the re-inserted entry lands at the tail of the Map's insertion
order. Size-cap eviction now always targets a genuinely different IP.

### Finding 10 — Content-Type check order → STILL OPEN (LOW)

Cosmetic reorder. Moving the Content-Type check below `checkRateLimit`
so invalid-Content-Type traffic depletes the attacker's rate budget.
Deferred — not blocking.

### Finding 11 — HTTP 200 for parser/envelope errors → STILL OPEN (LOW)

Judgment call: JSON-RPC 2.0 spec is silent on HTTP status. Current
implementation prefers JSON-RPC compliance (HTTP 200 for JSON-RPC
errors). Deferred — not blocking.

### Finding 12 — Parser nested Option<i64> signedness → CLOSED

**Commit:** `ec640f2` `fix(parser): preserve signedness through nested Option<T> / COption<T>`

Added `unwrapOptionPayload(type)` helper. `expandDefinedStruct` leaf
branch now calls the helper before `idlTypeToFieldType`, so nested
`Option<i64>` and `COption<i64>` preserve signedness as `"i64"` instead
of falling through to the size-based `"u64"` fallback. Walker at
parser.ts:443-449 left alone (already correct via inline unwrap); DRY
refactor deferred.

**New fixtures added:** 16 (Option<i64> inside struct) + 17
(COption<i64> inside struct) in `parser.test.ts`. Both would have
failed pre-fix with `type: "u64"`. These fixtures also cover Finding
15's request for an Option<i64> regression guard.

Verification: `vitest run __tests__/constraints` = 22/22 passing (was
20; +2 regression guards).

### Finding 13 — Integration test hermeticity + Windows path → STILL OPEN (MEDIUM, Phase 1.6)

Not blocking the core Phase 1.5 close. Requires copying the 4 real
IDL files into `sigil-dashboard/__tests__/constraints/fixtures/idls/`
(~1 MB total) and updating `parser.integration.test.ts` to use
`fileURLToPath(import.meta.url)` for cross-platform resolution.
Deferred to Phase 1.6 test infrastructure pass.

### Finding 14 — Parser allArgs post-boundary drops → STILL OPEN (LOW)

Introspection completeness gap. allArgs should always emit an entry
(with `{offset: -1, size: -1, type: "post-variable"}`) for fixed-size
args that follow a variable-length boundary, so callers can
distinguish "not present" from "post-boundary fixed". Deferred.

### Finding 15 — Missing Option<i64> fixture → COVERED by Finding 12

The code-reviewer's Finding 15 asked for an `Option<i64>` regression
guard. The Finding 12 fix (commit `ec640f2`) added fixtures 16 + 17
covering `Option<i64>` and `COption<i64>` inside defined structs —
exactly where the regression would live. Finding 15 is effectively
closed by the Finding 12 commit. Not tracking separately.

### Finding 16 — 0.9 integration pass-rate threshold → STILL OPEN (LOW)

Threshold is too lenient vs. project CLAUDE.md's zero-tolerance
posture toward boundary errors. Tighten to 1.0 or require all
failures to be classified "variable-length boundary" errors
specifically. Deferred.

### Meta: sigil-dashboard route unit test coverage → STILL OPEN (Phase 1.6 prereq)

Raised by the monitoring agent. No unit tests exist at the
sigil-dashboard route level — Pentester did live PoC, QATester
checked page load, but there are no regression tests for the findings
themselves. Adding Vitest-based route handler tests (constructing a
`NextRequest`, calling `POST` directly, asserting on `Response.json()`
output) is a Phase 1.6 prereq before any further route-level security
work. Estimated 2-3 hours + ~200 LOC of test scaffolding. Deferred.

### Phase 1.5 close line (2026-04-08)

**Above the line — CLOSED:**
- ✅ Finding 3 — A9 CPI guard on 28 handlers (commit 37485ac)

**Below the line (Phase 1.6 / Phase 2 prereqs):**
- Finding 8b — chunked-encoding DOS (new, MEDIUM)
- Finding 13 — integration test hermeticity (MEDIUM, test-only)
- Findings 10, 11, 14, 16 — LOW polish
- Sigil-dashboard route unit test coverage — new meta-gap
- Phase 1 deferred items — differential fuzz 10K+, 16 of the top-20
  IDL integration tests (requires `idl-fetch.ts` from
  CONSTRAINT-BUILDER-PLAN Step 2), ISC-80/81/82 regression tests
  (Bug 1 N+1 pin, Bug 3 round-trip, cursor math invariant),
  ISC-85 adversarial parser inputs,
  `tests/instruction-constraints.ts` +
  `tests/surfpool-integration.ts` TS test sweep
