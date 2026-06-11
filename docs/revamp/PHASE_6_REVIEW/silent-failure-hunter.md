# Phase 6 §RP audit — silent-failure-hunter

HEAD `1169668` (Phase 6 + error code deviation note).

## Engineer-disclosed CRITICAL — VERIFIED FIXED

`programs/sigil/src/instructions/create_post_assertions.rs:84-85` now copies
`zc.aux_value = entry.aux_value` and `zc.aux_byte = entry.aux_byte` inside
the pack loop. The bug (aux fields silently zeroed on persist) is closed.

## Audit findings (Phase 6 specific)

### CRITICAL: R-4 mode==7 falls through validate-time snapshot dispatcher
- File: `programs/sigil/src/instructions/validate_and_authorize.rs:1187-1273`
- Issue: the if/else cascade matches mode 4, 6, 5, 0 — but **not 7**. A vault
  with an R-4 (DeclarationConsistency) entry has the validate path drop into
  the legacy delta-snapshot block at lines 1255-1273.
  - `entry.target_account` for R-4 = `declared_recipient` (a WALLET pubkey,
    not a token account). The `remaining_accounts.iter().find(...)` at 1259
    REQUIRES that wallet's account_info to be passed at validate time.
  - If the agent omits it: hard `PostAssertionFailed` — vault is bricked
    (cannot validate any sandwich containing the R-4 entry).
  - If the agent includes it: `try_borrow_data()` succeeds, `end = 0+0 = 0`,
    snapshot is a zero-byte copy. snapshot_lens[i] = 0. Harmless functionally,
    but the require chain still gates on data length and the wallet may not
    even be a data-bearing account.
- Exploit: deploying an R-4 policy is a vault-wide DoS or a forced
  recipient-account-info disclosure at every sandwich.
- Fix: add `if entry.assertion_mode == 7 { continue; }` between lines 1249
  and 1250 (mirror the R-2 short-circuit). R-4 is finalize-only.
- Confidence: CONFIRMED via direct code read.

### CRITICAL: R-1 scope=0 agent-omission bypass
- File: `programs/sigil/src/utils/mint_delta_cap.rs:140-179`
- Issue: scope=0 sums "the derived ATAs that the caller chose to include in
  remaining_accounts" with explicit `None => continue` semantics on missing
  PDAs (line 147). Agent supplies remaining_accounts on EVERY call,
  including validate.
- Exploit walk-through:
  1. Vault has Token-2022 ATA holding 1M USDC, SPL classic ATA = 0.
  2. Agent calls `validate_and_authorize` with remaining_accounts that
     INCLUDES the SPL classic ATA but OMITS the Token-2022 ATA.
  3. `sum_vault_mint_balance(scope=0)` derives both PDAs but only `find`s
     the SPL classic. `pre_sum = 0`.
  4. DeFi sandwich drains 500K from the Token-2022 ATA.
  5. Finalize calls `verify_mint_delta_cap` with remaining_accounts that
     NOW INCLUDES the Token-2022 ATA (so the finalize verifier can read
     post_balance). `post_sum = 500K`.
  6. `net_decrease = pre_sum.saturating_sub(post_sum) = 0` (saturating).
  7. `0 <= max_net_decrease` → check passes. **R-1 SILENTLY BYPASSED.**
- Even with the same remaining_accounts at both validate and finalize, an
  agent can collude with itself by simply not declaring an ATA it knows
  will be drained — pre_sum and post_sum both measure 0 for that ATA, and
  the actual decrease never shows up in either snapshot.
- Worse: the comment at line 169 says "AtaAuthorityPin (R-2) catches this
  at finalize time" — but R-2 only fires if the OWNER explicitly pinned
  that specific ATA. R-2 is a per-entry primitive; it doesn't auto-cover
  every scope=0 R-1 derivation.
- Fix options:
  - (a) scope=0 must REQUIRE every derived ATA to be present (loop
    becomes `let info = remaining.iter().find(...).ok_or(MintDeltaCapMisconfigured)?`
    — the symmetric of the scope=1 path).
  - (b) Pair scope=0 with an implicit R-2 on every derived ATA so an
    omitted ATA at finalize hard-fails the authority check.
- Confidence: CONFIRMED via direct code read of mint_delta_cap.rs:140-179
  and post_assertion_helpers.rs:31-65.

### HIGH: R-3 OutputBalanceFloor no vault-ownership enforcement
- File: `programs/sigil/src/state/post_assertions.rs:294-318` (validate_entries),
  `programs/sigil/src/instructions/validate_and_authorize.rs:1207-1243`
  (snapshot), `programs/sigil/src/utils/post_assertion_helpers.rs:99-133`
  (finalize verify).
- Issue: at NO layer does R-3 require `target_account.owner_field == vault_key`.
  Validate_entries only requires `target_account != Pubkey::default()`. The
  snapshot path checks the mint matches `expected_value[0..32]` but not who
  OWNS the token account. The finalize verify only checks data length.
- Exploit: misconfigured owner sets `target_account = <attacker-controlled
  ATA holding mint X>`, `min_increase = 1`. Attacker mints +1 lamport into
  their own ATA between validate and finalize → R-3 passes trivially while
  the vault's actual balance can move in any direction.
- This is technically a CONFIGURATION footgun rather than a hard exploit,
  but the comments at post_assertions.rs:58-62 say "typically the vault's
  stablecoin ATA" — typically is not enforced. The TypeScript SDK should
  refuse to encode R-3 without a vault-ownership pre-check, and ideally the
  validate-time snapshot should add a `target_data[32..64] == vault_key`
  require!.
- Fix: add owner-field require! to both `validate_and_authorize.rs` lines
  1207-1243 (snapshot block) and `post_assertion_helpers.rs` line 113
  (finalize verifier).
- Confidence: CONFIRMED via direct code read.

### HIGH: Sandwich-level adversarial tests ENTIRELY DEFERRED
- File: `tests/post-assertions-r-variants.ts:1-26` (file-level comment
  explicitly acknowledges the gap).
- Issue: all 16 LiteSVM cases AND all 218 Rust unit cases exercise ONLY
  `create_post_assertions` validate_entries. ZERO tests exercise the
  validate→DeFi→finalize sandwich for the four new variants. The CRITICALs
  R-1-omission and R-4-fallthrough above would not be caught by any
  existing test.
- The Phase 6 §RP brief said "ALL FOUR PASS tests (Audit #2 F-15)" — the
  PASS tests at the `create_post_assertions` layer do exist (4 PASS + 12
  REJECT), but the "all four end-to-end sandwich PASS" coverage promised
  by the brief is missing.
- Confidence: CONFIRMED — Engineer disclosed and acknowledged.

### MEDIUM: Error code drift documented but not consumed by SDK
- File: `programs/sigil/src/errors.rs:456-538` documents the drift from
  the brief's 6097-6100 to actual 6097-6101.
- Issue: any monitoring/SDK code that pre-computed the error-code map
  from the Phase 6 brief will reference the wrong codes (6098 → R-2 in
  the brief but → MintDeltaCapMisconfigured in production). The comment
  at lines 509-515, 535-537 acknowledges this is forward-only. Check
  the TS SDK + monitoring dashboards consume `target/idl/sigil.json` and
  not a hand-pinned table.
- Confidence: LIKELY — TS test pin is at `expectSigilError`; need to
  confirm SDK doesn't hardcode 6098 to ErrAtaAuthorityChanged.

### LOW: R-2 verify does not assert vault-ownership at validate time
- File: `programs/sigil/src/utils/post_assertion_helpers.rs:69-95`
- The finalize verify requires `target_data[32..64] == vault_key` (good).
  validate_entries requires `target_account != Pubkey::default()` (weak).
  There's no validate-time check that the configured ATA is currently
  vault-owned. A policy can configure R-2 on an unrelated ATA; finalize
  always rejects, the vault is bricked for that entry.
- Fix: add a snapshot-time owner check at validate (currently mode 5
  short-circuits with `continue` at line 1247-1249) so misconfig surfaces
  at policy creation, not at first agent action.

### LOW: ATA derivation cap MAX_ATAS_PER_MINT=5 only ever populates 2
- File: `programs/sigil/src/utils/mint_delta_cap.rs:44-62`
- Code derives exactly 2 ATAs (SPL classic + Token-2022). Cap of 5 is
  defensive headroom. Slots 2-4 are "reserved" but never populated.
- If a future SIMD adds a new ATA program, derive_vault_atas must be
  updated AND every existing R-1 scope=0 entry on chain becomes
  retroactively under-counted. Migration story is unclear; doc this in
  the operator runbook.
- Confidence: LIKELY footgun, not an immediate exploit.

## Engineer claims verified

| Claim | Status |
|-------|--------|
| `aux_value`/`aux_byte` pack fix landed | CONFIRMED at create_post_assertions.rs:84-85 |
| All four helpers `#[inline(never)]` | CONFIRMED at post_assertion_helpers.rs:30,68,98,141 |
| PostExecutionAssertions SIZE = 672 | CONFIRMED at state/post_assertions.rs:199 (`8 + 32 + 78*8 + 1 + 1 + 6 = 672`) |
| SessionAuthority SIZE = 515 | CONFIRMED at state/session.rs:145 (`8+32+32+1+8+32+32+8+1+32+8+8+32+8+1+256+8+8 = 515`) |
| MAX_POST_ASSERTION_ENTRIES = 8 | CONFIRMED at state/post_assertions.rs:13 |
| Error codes 6097-6101 occupied (5 codes, not 4) | CONFIRMED at errors.rs:470-538 |
| 218 cargo lib tests pass | CONFIRMED via `cargo test --lib --features devnet-testing` |
| TA-19 digest still 20 fields | CONFIRMED at utils/policy_digest.rs:138-189 |
| `has_post_assertions` at TA-19 position 13 | CONFIRMED at utils/policy_digest.rs:172-173 |
| R-1 scope=0 saturating_sub semantic | CONFIRMED at post_assertion_helpers.rs:61 — but THIS IS THE BYPASS VECTOR (see CRITICAL above) |
| R-2 raw bytes[32..64] for authority field | CONFIRMED at post_assertion_helpers.rs:89-92 |
| R-3 snapshot u64 LE | CONFIRMED at validate_and_authorize.rs:1237-1242 |
| R-4 sysvar read at current_index-1 | CONFIRMED at post_assertion_helpers.rs:147-153 |
| R-4 meta_index < ix.accounts.len() bounds-checked | CONFIRMED at post_assertion_helpers.rs:156-159 |
| Sibling pack-loops also drop fields? | NO — only `create_post_assertions.rs` has the manual-field-by-field pattern. `pack_entries` (state/constraints.rs:1033) starts with `bytemuck::Zeroable::zeroed()` (defensive). `apply_pending_policy.rs` uses `Option<T>` field merge. Pattern is isolated to one file. |

## Verdict

**FIX-AND-RETEST** — two CRITICAL findings (R-4 mode==7 validate fall-through
and R-1 scope=0 agent-omission bypass) require source fixes before Phase 6
can be considered §RP-clean. R-3 vault-ownership gap is a HIGH that should
land in the same fix batch. The Engineer-disclosed CRITICAL (aux field pack
drop) is genuinely fixed and well-tested at the schema layer, but the
absence of any validate→DeFi→finalize sandwich coverage means the two new
CRITICALs found here would have shipped silently. The schema-layer tests
(16 LiteSVM + 218 Rust unit) are NECESSARY but NOT SUFFICIENT — sandwich
coverage is the gating coverage for finalize-time correctness and must land
either as a mock-DeFi LiteSVM harness or a surfpool integration suite
before mainnet redeploy.

The error-code drift to 6097-6101 is fine for new builds but warrants a
follow-up audit on any pre-built off-chain monitor or SDK pin map.
