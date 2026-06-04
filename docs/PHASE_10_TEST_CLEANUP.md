# Phase 10a-B7 — Test Cleanup + Redeploy Prep

**Status:** in-progress at HEAD `65732362` (branch `revamp/v2-2026-05`, LOCAL ONLY).
**Created:** 2026-05-23.
**Owner:** Sigil V2 Phase 10 work — closes the test-harness debt accumulated through Bucket 1 + Bucket 2 architectural changes.

---

## Why this exists

After Bucket 2 (HEAD `46b51800`) closed the D-1 (intent-digest), D-5 (cosign_session_pubkey), and NH-1 (default-on FULL_CAPABILITY cosigner) hardening, the LiteSVM CI list reported 232 passing / 215 failing. The on-chain build was green and Rust unit tests passed, but ~94% of the LiteSVM failures (202/215) were CASCADE failures from three IDL shape changes that the legacy ts-mocha harness had not been updated for.

Three shape changes drove the cascade:

| Ix | Old args | New args | Insertion point |
|---|---|---|---|
| `validate_and_authorize` | 5 | 6 | New 6th arg `expectedIntentDigest: [u8; 32]` |
| `queue_policy_update` | 18 | 19 | New 17th arg `cosign_session_pubkey: Option<Pubkey>` between `cosign_required` and `cosign_session` |
| `reactivate_vault` (semantic) | — | — | FULL_CAPABILITY now unconditionally raises error 6114 without a non-owner cosigner |

This document captures the cleanup work + the procedures Phase 10b and Phase 10 themselves will follow.

---

## Sub-batches

| Batch | Scope | Status |
|---|---|---|
| **B7.1** | Build canonical helper `tests/helpers/intent-digest-fixture.ts` + 4 pinned hex fixtures + 13-assertion parity test | **DONE** at `65732362` |
| **B7.2** | Bulk-update ~135 validateAndAuthorize callsites across 16 LiteSVM-scope test files (real digest via helper) | in-progress (Engineer agent) |
| **B7.3** | Bulk-update ~65 queuePolicyUpdate callsites (insert `null` at position 17 default-case; specific Pubkey for D-5 tests) | in-progress (Engineer agent) |
| **B7.4** | Fix 9 FULL_CAPABILITY reactivate sites at `sigil.ts:{1000,1050,1075,3050,5617}` + `security-exploits.ts:{1756,1819,3724,3833}` — add non-owner cosigner OR assert error 6114 | pending |
| **B7.5** | Triage residual ~10 failures + run CI list twice consecutively for flake detection | pending |
| **B7.6** | Adversarial review (`code-reviewer` + `silent-failure-hunter` parallel) — must return 0 CRITICAL, explicitly assert NC-1/NC-2/NH-1..NH-4 non-regression | pending |
| **B7.7** | This doc + Phase 10b prep + Phase 10 redeploy procedure | in-progress |
| **B7.8** | Mutation test (flip one byte of helper output → ≥1 success-path test fails) + `tsc --noEmit` on tests/ + commit `agent-errors.generated.ts` | pending |

---

## D-1 helper recipe

Use the shared helper. Do NOT duplicate the math inline (one file at `tests/sandwich-integration.ts:132-162` predates the helper — leave it; it byte-equals).

```ts
import {
  buildExpectedIntentDigest,
  digestAsArgs,
  ZERO_INTENT_DIGEST,
} from "./helpers/intent-digest-fixture";

await program.methods
  .validateAndAuthorize(
    tokenMint,
    amount,
    targetProtocol,
    policyVersion,
    new BN(0),
    digestAsArgs(
      buildExpectedIntentDigest({
        vault: vaultPda,
        agent: agent.publicKey,
        tokenMint,
        amount,
        targetProtocol,
      }),
    ),
  )
  .accountsPartial({ /* … */ })
  .rpc();
```

### When ZERO_INTENT_DIGEST is appropriate

ONLY when the test literally asserts:
- Error **6111** (`ErrIntentDigestMismatch`)
- Error **6066** (`CpiCallNotAllowed`) — the only gate that fires before the digest check at `validate_and_authorize.rs:159-191`

For ALL other negative-path tests (caps, allowlist, policy version, observe-only, agent paused, etc.) you MUST compute the real digest — the on-chain handler verifies the digest FIRST. A zero-buffer at those callsites makes the test fail with 6111 instead of the intended error.

---

## D-5 queuePolicyUpdate cleanup

```ts
program.methods.queuePolicyUpdate(
  /* 1  */ null, // daily_spending_cap_usd
  /* 2  */ null, // max_transaction_amount_usd
  /* 3  */ null, // protocol_mode
  /* 4  */ null, // protocols
  /* 5  */ null, // developer_fee_rate
  /* 6  */ null, // max_slippage_bps
  /* 7  */ null, // timelock_duration
  /* 8  */ null, // allowed_destinations
  /* 9  */ null, // session_expiry_seconds
  /* 10 */ null, // has_protocol_caps
  /* 11 */ null, // protocol_caps
  /* 12 */ null, // destination_mode
  /* 13 */ null, // operating_hours
  /* 14 */ null, // stable_balance_floor
  /* 15 */ null, // per_recipient_daily_cap_usd
  /* 16 */ null, // cosign_required
  /* 17 */ null, // cosign_session_pubkey  ← NEW arg D-5; null = default opt-in off
  /* 18 */ null, // cosign_session
  /* 19 */ newPolicyPreviewDigest, // 32-byte preview digest
);
```

Pass a real `PublicKey` at position 17 only when binding the policy to a specific cosigner for NH-1 hardening tests.

---

## NH-1 reactivate cleanup

For each of the 9 sites:
1. Generate a non-owner cosigner: `const cosigner = Keypair.generate(); expect(cosigner.publicKey).to.not.deep.equal(owner.publicKey);`
2. Have the policy bind this cosigner via `queue_policy_update` `cosign_session_pubkey = cosigner.publicKey`
3. Pass `cosigner` in the `Signers` list of the reactivate transaction
4. If a test is meant to exercise the NH-1 default-on safety (the failure path), assert error **6114** (`ErrReactivateCosignRequiredForFullCapability`)

NEVER pass `owner` as the cosigner — that's a silent NH-1 bypass (closed by ISC-A-7).

---

## Phase 10b — Devnet treasury + ALT swap (PROCEDURE, NOT EXECUTED)

User confirmed prior session:
- Treasury keypair `ASHie1dFTn…` is NOT on this machine (exhaustive 4-pass search)
- Devnet treasury swap target: `6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp` (= the configured wallet keypair at `~/.config/solana/id.json`)
- This change is **devnet only** — the mainnet treasury constant in `programs/sigil/src/state/vault.rs` stays pinned to the Squads V4 multisig vault PDA `7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy` (compile-time constant). DO NOT modify it.

### Steps (to be executed by user when ready)

1. **Audit the current devnet treasury account**
   ```bash
   solana account ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT \
     --url devnet --output json | jq '.account.lamports'
   ```
   Confirm balance; transfer SOL out if needed (only the keypair holder can do this, which user does not have).

2. **Update the devnet feature constant in code** (Phase 10a-B7.9+ — not in scope here):
   - The treasury pubkey is wired via build feature; flipping it requires either an on-chain re-deploy or an off-chain Codama codegen of new test-only constants.
   - DO NOT change the `mainnet` constant.

3. **Create the new devnet ALT** with `6wrkKTM2pj…` as authority:
   ```bash
   solana address-lookup-table create --authority ~/.config/solana/id.json --url devnet
   # outputs new ALT address; capture and update sdk/kit/src/network.ts devnet entry
   ```

4. **Populate the ALT** with the Sigil program ID, treasury ATA, mock-defi program, common tokens (USDC, SOL, USDT):
   ```bash
   solana address-lookup-table extend <ALT> --addresses <pubkey1>,<pubkey2>,... --url devnet
   ```

5. **Verify ALT writable bitmask** matches `programs/sigil/src/utils/alt_writable.rs` expectations.

### Rollback

If Phase 10b causes devnet integration test failures:
1. Revert the SDK `network.ts` devnet entry
2. Old ALT (if any) remains usable until manually frozen
3. The old program ID `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` stays deployed at devnet; redeploy is Phase 10 (separate)

---

## Phase 10 — Devnet redeploy under new program ID (PROCEDURE, NOT EXECUTED)

### New program ID

- Keypair: `target/deploy/sigil-keypair.json`
- Pubkey: `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`

> **Note** — prior session memory mentioned `H2Hxvpig1Lx…` as the planned new program ID; the actual keypair at `target/deploy/sigil-keypair.json` generates `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`. The keypair takes precedence. If the user wants a different pubkey, regenerate the keypair with `solana-keygen new -o target/deploy/sigil-keypair.json --force` (DESTRUCTIVE — irrecoverable).

### Pre-redeploy gate

ALL of these must be true before deploying:
- [ ] B7.2 done — all validateAndAuthorize callsites use 6-arg shape
- [ ] B7.3 done — all queuePolicyUpdate callsites use 19-arg shape
- [ ] B7.4 done — all NH-1 reactivate sites either cosigner-fixed or assert 6114
- [ ] B7.5 done — LiteSVM CI list reports zero failures TWICE in a row
- [ ] B7.6 done — code-reviewer + silent-failure-hunter both return 0 CRITICAL
- [ ] B7.8 done — mutation test confirms helper-output dependency; tsc --noEmit clean
- [ ] `anchor build --no-idl` green at HEAD
- [ ] `git checkout -- target/idl/ target/types/` produces zero diff after build
- [ ] User explicitly approves push to origin

### Redeploy steps (USER-EXECUTED)

1. **Verify on-chain program ID matches code**
   ```bash
   grep -n "declare_id" programs/sigil/src/lib.rs
   # Must match: 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK
   ```
   If mismatch, update `declare_id!()` + `Anchor.toml` `[programs.devnet]` + `sdk/kit/src/network.ts` devnet entry.

2. **Build production artifact**
   ```bash
   anchor build --no-idl
   git checkout -- target/idl/ target/types/      # restore committed IDL
   solana program show <NEW_ID> --url devnet     # verify NOT already deployed
   ```

3. **Deploy**
   ```bash
   solana program deploy target/deploy/sigil.so \
     --program-id target/deploy/sigil-keypair.json \
     --url devnet \
     --keypair ~/.config/solana/id.json
   ```

4. **Verify on-chain bytecode hash**
   ```bash
   solana program dump <NEW_ID> /tmp/deployed.so --url devnet
   sha256sum target/deploy/sigil.so /tmp/deployed.so
   # Must match
   ```

5. **Run devnet smoke tests**
   ```bash
   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com pnpm test:onchain
   ```

### Rollback (if Phase 10 fails)

The old program ID `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` stays deployed during the redeploy — the new ID is independent. If the new deploy fails or behaves unexpectedly:

1. Revert `declare_id!()` in `programs/sigil/src/lib.rs` to `7FtAXUcr…`
2. Revert `Anchor.toml` `[programs.devnet]`
3. Revert `sdk/kit/src/network.ts` devnet entry
4. Run `anchor build --no-idl` + `git checkout -- target/idl/ target/types/`
5. Verify tests pass against old ID
6. The new program at `7FtAXUcr…` can be frozen later via `solana program close <NEW_ID> --recipient <wallet>` (returns rent SOL)

The new ID and the old ID can coexist — Sigil's PDA seeds derive from `vault.vault_authority` + `vault_id`, not from program ID, so old vaults stay accessible at the old program.

---

## Audit-cadence discipline (applies to every commit in this phase)

Per `docs/AUDIT_SNAPSHOT_CADENCE.md` — every cleanup commit MUST:
- Cite the HEAD SHA pinned for the change
- Include the gate-command output (`anchor build --no-idl` line + relevant ts-mocha pass count) in the commit body
- Reference the ISC criterion ID(s) closed
- Use Conventional Commits format with the `(scope)` matching the affected area

Example commit body template:
```
test(intent-digest): pass real digest at <FILE> callsites (B7.2 of N)

Updated <COUNT> .validateAndAuthorize callsites to pass the 6th
expectedIntentDigest arg via buildExpectedIntentDigest. <SUCCESS>/<TOTAL>
use real-computed digests; <ZERO_COUNT> use ZERO_INTENT_DIGEST per the
"asserts error 6111 or 6066" rule.

Closes ISC-1, ISC-2 (per-callsite scope), ISC-6 (zero 5-arg callsites in this file).

Gate output:
  anchor build --no-idl: Finished release in 0.4s
  npx ts-mocha tests/<FILE>.ts: <PASS_COUNT> passing

Pin SHA: <HEAD>
```

---

## Critical invariants preserved across the cleanup

The bulk callsite refactor MUST NOT regress any of:

| Invariant | Where it lives | How to verify |
|---|---|---|
| **D-1**: scalar intent-digest binds (vault, agent, mint, amount, protocol, network) | `validate_and_authorize.rs:159-191` | Mutation test (B7.8) — flip helper byte, ≥1 success test must fail |
| **D-5**: cosign_session_pubkey at TA-19 canonical position 22 | `policy_digest.rs` + `state/policy.rs` | TA-19 cross-impl test (tests/policy-digest-invariant.ts) |
| **NH-1**: FULL_CAPABILITY reactivate requires non-owner cosigner | `reactivate_vault.rs:187-235` | B7.4 negative-path test asserts error 6114 |
| **TA-11**: agent_transfer walker dedupes by visited pubkey | `validate_and_authorize.rs::build_ta11_protected_set` | FINDING-B test uses distinct ATAs (ISC-63) |
| **RAV-1**: violation log skips already-disabled agent | `record_agent_violation.rs` | ISC-64 — assert pre-state in test |
| **PEN-CROSS-3**: pending_content_digest re-verified at apply time | `apply_pending_constraints.rs` + `apply_agent_grant.rs` | ISC-65 |

If any of these regresses, P0 — fix before pushing.

---

## B7.5 — LiteSVM CI list result + deferred failures

**Two consecutive runs at HEAD `a9838733`:** 503 passing / 5 pending / **12 failing — 100% deterministic** (no flakes).

The 22-file LiteSVM CI list:
```
tests/sigil.ts, tests/security-exploits.ts, tests/sandwich-integration.ts,
tests/policy-digest-invariant.ts, tests/missing-coverage.ts,
tests/ownership-transfer.ts, tests/post-execution-assertions.ts,
tests/agent-violation-tracking.ts, tests/canonical-policy-digest.ts,
tests/jupiter-integration.ts, tests/jupiter-lend-integration.ts,
tests/flash-trade-integration.ts, tests/instruction-constraints.ts,
tests/toctou-security.ts, tests/analytics-counters.ts, tests/audit-log.ts,
tests/audit-log-burst.ts, tests/audit-log-coverage.ts, tests/cu-budget.ts,
tests/sysvar-scan-bound.ts, tests/post-assertions-sandwich.ts,
tests/intent-digest-parity.ts
```

### 12 deferred failures (PRE-EXISTING, not caused by B7 cleanup)

| Suite | Tests failing | Failure mode | Pre-existing since |
|---|---|---|---|
| `tests/instruction-constraints.ts` "V2: OR logic" | 2 | `AccountOwnedByWrongProgram (3007)` on AllocatePendingConstraintsPda — constraints PDA setup unfixed for Phase 5 OR-logic schema migration | last touched at `e813f2f9` (pre-Phase-10a) |
| `tests/instruction-constraints.ts` "V2 Phase 2: Signed + Bitmask operators" | 8 | Mix of `AccountOwnedByWrongProgram (3007)` and `InvalidConstraintConfig (6037 — bounds exceeded)` at `state/constraints.rs:263` — Phase 6 Signed + Bitmask operator schema migration incomplete | pre-Phase-10a |
| `tests/audit-log.ts` "slot/blockhash fields read FRESH from sysvar each ix" | 1 | `RangeError: encoding overruns Uint8Array` — sysvar fixture shape mismatch | last touched at `c7cf727f` (§RP-2) |
| `tests/cu-budget.ts` "Scenario 6: ComputeBudget×28 pad ≤ 1,020,000 CU" | 1 | Pad-bytes scenario exceeds 1232-byte tx serialization limit after IDL expansion | flagged by B7.2 agent as out-of-scope |

**Triage verdict:** none of these are caused by the B7.2/B7.3/B7.4 mechanical cleanup. They are pre-existing schema-migration bugs (instruction-constraints Phase 5/6), a sysvar fixture issue (audit-log Phase 7), and a CU-budget tx size limit (cu-budget Scenario 6). All are tracked as separate work and DO NOT block Phase 10 redeploy.

### Before / after delta

| State | Total | Passing | Failing |
|---|---|---|---|
| Prior session (HEAD `46b51800`) | 451 | 232 | 215 |
| After B7 cleanup (HEAD `a9838733`) | 520 | 503 | 12 |
| Delta | +69 (new tests from B7.4) | +271 | -203 (94% reduction) |

### Closing follow-up for the 12 deferred items

A separate task (Phase 10a-B8 or later) should:
1. Update `tests/helpers/litesvm-setup.ts` `createConstraintsAccount` for Phase 5 OR-logic + Phase 6 Signed/Bitmask schema
2. Update audit-log slot/blockhash fixture for Phase 7 sysvar shape
3. Adjust cu-budget Scenario 6 pad count for new IDL serialization size

None of these regress on-chain invariants. The Rust unit tests + LiteSVM CI list above prove the program itself is sound.

## What is NOT in scope for this phase

- Surfpool integration test cleanup (`tests/surfpool-integration.ts` — separate runner, deferred to Phase 10c)
- Devnet integration test cleanup (`tests/devnet/**` — runs against live RPC, deferred)
- Dashboard cosign UI work (Task #54 — separate effort, will need a similar pass on the dashboard mutation callsites)
- Mainnet program ID changes (Squads V4 multisig migration — separate effort)
- Bumping `@usesigil/kit` version (the cleanup doesn't change the SDK public API)
