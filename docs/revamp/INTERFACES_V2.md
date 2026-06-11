> ⚠️ **SUPERSEDED — HISTORICAL V2 DESIGN ARCHIVE** (branch `revamp/v2-2026-05`). The current source of truth is **`ROADMAP/`** + the shipped program source. **Stale below:** the TA-08 Token-2022 allowlist is listed as 3 items including `NonTransferable` — F-Q4 (`b710f6a9`) **removed `NonTransferable`**; the live accept-set is **`MemoTransfer` + `MetadataPointer` only** (`programs/sigil/src/utils/token2022_extension.rs`). See [`README.md`](./README.md).

# INTERFACES_V2.md — Sigil v2 ID Registry

**Status:** Source of truth for all IDs used across Stage 0+ docs (K1-K7, TA-01..TA-19 with TA-16 DELETED, AC-1..AC-11, D-01..D-09, plus T-21 / T-DoS-1/2 / T-K6-1 / Def-1..Def-6).
**Last updated:** 2026-05-17 (Phase 0.5 hygiene pass — TA-16 deleted, TA-17/18/19 finalized)
**Companion docs:** [REVAMP_PLAN.md](./REVAMP_PLAN.md), [THREAT_MODEL_V2.md](./THREAT_MODEL_V2.md), [ACCEPTANCE_V2.md](./ACCEPTANCE_V2.md), [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md)

> **All other docs in this directory cite IDs from this file as canonical. Cross-doc ID drift = §RP CRITICAL finding.**
> Modifications here require a §RP Review Protocol pass per [REVAMP_PLAN.md §12](./REVAMP_PLAN.md#12-rp-review-protocol).
> **Numeric error code allocation:** see [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md) for the canonical line-by-line variant → code mapping. The "Error Code Allocation" section at the end of this file is a summary only.

---

## Foundational Features (K1-K7)

These are pre-V2 primitives carried forward unchanged. They are NOT enumerated in Tier A and do NOT count toward the TA surface; they form the substrate on which Tier A enforces.

### K1 — Vault PDA + token accounts
The `AgentVault` PDA at seeds `[b"vault", owner, vault_id]` plus its associated USDC/USDT ATAs. Foundation since V0.

### K2 — Session keys (TTL + nonce-based bulk revocation)
The `SessionAuthority` PDA at seeds `[b"session", vault, agent, token_mint]` with `expiry_unix` and `nonce` fields. Closes AC-5 stale-key class via TTL; load-bearing for TA-06 cooldown and TA-15 N1 temporal binding. Foundation since V0.

### K3 — `freeze_vault` kill switch
Owner-only instruction that transitions `vault.status` from `Active` to `Frozen`. Closes AC-1 (agent leak) and AC-2 (owner leak) blast radius once detected. Foundation since V0.

### K4 — `register_agent` / `revoke_agent` / `pause_agent` / `unpause_agent`
Owner-only lifecycle instructions for agents. K4 is the substrate for TA-04 capability split (which encodes the *type* of agent permission). Foundation since V0.

### K5 — Timelock on policy mutations
`PendingPolicyUpdate` + `PendingConstraintsUpdate` PDAs gate every owner-initiated change with `min_delay_seconds` (default 172,800 = 48h). Closes AC-2 timelock-window attack window. Foundation since V0.

### K6 — Mandatory Anchor event emission
Every instruction calls `emit!(...)` per project CLAUDE.md mandate. Foundation since V0 for audit/dashboard observability.

### K7 — NM-E primitive (generic vault-balance delta)
Net-Movement Enforcement — vault-balance delta assertions at finalize. Per Option A locks (L-1), there is no tier model and no per-protocol parser path; NM-E in V2 is the generic vault-balance delta check that applies uniformly to every protocol. Foundation since V1; v2 scope is the generic shape only.

---

## Tier A Primitives (TA-01..TA-19, TA-16 DELETED)

These are the NEW V2 constraint surface enforced on every seal() bundle. Per Option A locks (L-1), there is no tier model — every primitive applies to every protocol uniformly. Full implementation specs are deferred to per-phase prompts; this section provides one-line definitions for cross-doc reference.

**Allocation status post-Phase-0.5:**
- TA-01..TA-15: existing primitives (definitions tightened per Option A).
- TA-16: **DELETED.** Was `parser_version` under the tier model; incompatible with L-1.
- TA-17: **LOCKED.** Auto-revoke on consecutive failures (AgentEntry, configurable, policy-codes only).
- TA-18: **LOCKED.** Squads V4 SDK detection helper — off-chain only (§4.4 framing).
- TA-19: **LOCKED.** `policy_preview_digest` SHA-256 on PolicyConfig + PendingPolicyUpdate.

### TA-01 — Per-vault+agent protocol allowlist
`PolicyConfig.allowed_protocols: Vec<Pubkey>` runtime-bounded to 10. Default-deny. Entry guard rejects any seal() whose next DeFi-instruction program ID is absent. Applies uniformly (Option A — no tier filter).

### TA-02 — Wallet allowlist default-deny
`PolicyConfig.allowed_destinations: Vec<Pubkey>` runtime-bounded to 10. Default-deny per Ondo USDY precedent. Applies uniformly.

### TA-03 — USDC/USDT mint pinning
Cluster-pinned mints at build time. Mainnet USDC `EPjFWdd5...`, mainnet USDT `Es9vMFrz...`, devnet USDC `4zMMC9sr...`. Entry guard rejects any non-pinned mint. Applies uniformly.

### TA-04 — Per-agent capability split
`AgentEntry.capability: u8`: `DISABLED=0`, `OBSERVER=1`, `OPERATOR=2`. Reserved 3..=255 reject with `ErrInvalidCapability` (code 6079 — see [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md)). Applies uniformly.

### TA-05 — Operating hours UTC bitmask
`PolicyConfig.operating_hours: u32` — bit `i` (0..=23) set ⇒ hour `i` UTC is permitted. Applies uniformly.

### TA-06 — Per-agent cooldown (relocated from per-vault per F-16)
Per-agent `cooldown_seconds: u32` + `last_action_unix: i64` stored on `AgentSpendOverlay` (NOT on `PolicyConfig`). Entry guard rejects if `clock.unix_timestamp - last_action_unix < cooldown_seconds`. Applies uniformly.

### TA-07 — First-time-destination friction
`PolicyConfig.destination_graylist: Vec<(Pubkey, i64)>` runtime-bounded to 10. New destination → graylist with `unlock_unix = now + 86400`. `auto_promote_grays: bool` defaults `false`. Applies uniformly.

### TA-08 — Token-2022 dangerous-extension blocklist (deposit-path)
Deposit-path TLV check with a 3-item ALLOWLIST per D-4 (`MemoTransfer`, `MetadataPointer`, `NonTransferable`). All other extensions reject. Additive to the existing validate-time opcode blocklist (search for `BlockedSplOpcode` — runtime check lives in `validate_and_authorize.rs`; G5 audit fix 2026-05-18 — prior fixed line-range `validate_and_authorize.rs:417-429` was stale after Phase 3 refactor). Applies uniformly.

### TA-09 — Cosign workflow
Elevated owner operations require owner+session co-signature on the policy-update instruction. Applies uniformly. The full set of elevation triggers (G3a audit fix §RP-2 2026-05-18) is:

1. Raise `daily_spending_cap_usd` (`Some(new) > live`)
2. Raise `max_transaction_amount_usd` (`Some(new) > live`)
3. Expand `allowed_destinations` (more entries OR any pubkey not in live)
4. Expand `allowed_protocols` (more entries OR any pubkey not in live)
5. Lower `stable_balance_floor` (`Some(new) < live`) — G3a fix 2026-05-18; the existing `<` operator correctly handles the "0 = no floor" convention since `0 < live_non_zero` is true (weakening) while raising the floor (`new > live`) is strengthening
6. Weaken `per_recipient_daily_cap_usd` — G3a fix §RP-2 CRIT-1 2026-05-18; honors the "0 = unlimited" convention at `finalize_session.rs:486`. Weakening = `Some(0)` when live > 0, OR `Some(new) > live` when both bounded
7. Weaken `protocol_caps` — G3a fix §RP-2 HIGH-1 2026-05-18; triggered by `has_protocol_caps: Some(false)` (master-switch disable) OR any per-protocol cap shrinking to 0 from a non-zero live value OR any per-protocol cap growing to a larger value. Honors the "0 = unlimited" convention at `finalize_session.rs:411-412` + `state/policy.rs:347-355`

**Cosign is opt-in per vault (G6 audit fix 2026-05-18).** `PolicyConfig.cosign_required: bool` defaults to false. When false, the 7-trigger elevated-mutation check above short-circuits — elevated mutations only require the owner's signature (no cosign session required, single-signer flow). When true, the gate fires as before and requires a non-default `cosign_session` pubkey + a corresponding signer in `remaining_accounts` with `is_signer == true`. Enable via the `initialize_vault` arg or via a non-elevated `queue_policy_update` raising `cosign_required: Some(true)`. Disabling cosign (`Some(false)` when live is `true`) is itself an elevated mutation regardless of any other trigger — the one-way ratchet prevents a phishing-compromised owner key from silently turning cosign off and then draining via subsequent non-elevated mutations. The flag is bound by TA-19 at canonical digest position 20 so a tampered SDK cannot silently flip it between owner approval and on-chain landing. Pairs with the off-chain Squads V4 detection helper (`detectSquadsV4Owner`, `sdk/kit/src/squads-detection.ts`) which lets dashboards recognize the multisig-owner mode where cosign is unnecessary on top of Solana-layer multisig.

### TA-10 — Sandwich integrity N2 via instructions-sysvar
Entry guard reads `instructions` sysvar and asserts: (a) 1..=4 `validate_and_authorize` + `finalize_session` pairs in transaction, (b) immediate-next instruction after each `validate_and_authorize` is an allowed protocol program ID, (c) no foreign instruction inside any seal window writes to protected accounts. Applies uniformly.

### TA-11 — Protected-writable deny-list N4
Protected set: **16 PROTECTED_SEED_PREFIXES** (G5 audit fix 2026-05-18 — prior `{vault, tracker, session, policy}` listing was grossly understated). Active runtime set: 12 prefixes (vault, policy, tracker, session, post_assertions, pending_policy, pending_constraints, pending_agent_perms, pending_close_constraints, pending_owner, constraints, agent_spend) + 1 sentinel slot `Pubkey::default()` = 13-entry array. Forward-compat documentation prefixes: audit_success, audit_rejected, cosign, recipient (4 — Phase 7+ ships these PDAs). Entry guard rejects if any foreign instruction in the bundle lists a protected account as writable. Applies uniformly.

### TA-12 — Stablecoin balance floor
`PolicyConfig.stable_balance_floor: u64` (6-decimal USDC face value). `finalize_session` rejects if `usdc_balance + usdt_balance < stable_balance_floor`. Applies uniformly.

### TA-13 — Rolling 24h tracker (RATIFY existing wiring)
`SpendTracker` PDA (zero-copy, 2,840 bytes baseline; +484 in Phase 5), keyed by `(vault, agent, protocol)`. Each entry tracks rolling-24h outflow in USDC face value. RATIFICATION of existing wiring (Phase 5 does NOT unlock new behavior).

### TA-14 — Per-recipient daily cap
`SpendTracker.per_recipient: [PerRecipientCounter; 10]` (fixed-size array, NOT Vec) with explicit `count: u8`. Applies uniformly.

**V1 constraint — single recipient per finalize (H-10, audit 2026-05-21):**
`finalize_session` enforces AT MOST ONE distinct allowlisted recipient per transaction. A bundle whose DeFi instruction touches two distinct allowlisted recipients in the same finalize hard-rejects with `ErrRecipientCapExceeded` (6096) at `finalize_session.rs:638`, BEFORE the rolling-24h cap is even consulted. This is a per-tx cap-attribution invariant — the per-recipient counter slot is updated against exactly one recipient pubkey, so attributing a single CPI's outflow across two recipients would be ambiguous.

**Resolution (caller-side):** split the multi-recipient batch into N transactions, each touching a single recipient. The total 24h spend across the N tx is unchanged; the per-recipient counter receives clean attribution.

```ts
// V1 — REJECTED (6096): single CPI sends to two distinct recipients.
const bundle = await composer.composeBundle({
  destinations: [
    { recipient: aliceAta, amount: 100_000_000n },
    { recipient: bobAta, amount: 200_000_000n },
  ],
});

// V1 — CORRECT: two finalize calls, each with one recipient.
await client.seal({ destinations: [{ recipient: aliceAta, amount: 100_000_000n }] });
await client.seal({ destinations: [{ recipient: bobAta, amount: 200_000_000n }] });
```

The `@usesigil/kit` error mapping for 6096 includes `split_into_separate_transactions` in its `recovery_actions` array so AI agents and dashboard consumers can route to the correct remediation automatically. Note: the same 6096 code is also emitted by two other branches (rolling-24h cap exceeded, `per_recipient` tracker array full with no expired slot) — see `sdk/kit/src/agent-errors.ts` (6096 entry) for the full TRIPLE-CAUSE disambiguation comment.

**V1.1 follow-up:** lifting the single-recipient-per-tx rule requires per-CPI outflow attribution (e.g. tracking each transfer instruction's amount + destination ATA owner separately). Not in V1 scope.

### TA-15 — Audit-log separate PDAs (with N1 temporal binding per C22)
**Per L-12 + C24 LOCKED disposition: two SEPARATE PDAs, NOT fields on AgentVault.**
- `AuditLogSuccess` PDA at seeds `[b"audit_success", vault]`: 128 entries × 64 bytes = **8,192 bytes** (account payload).
- `AuditLogRejected` PDA at seeds `[b"audit_rejected", vault]`: 64 entries × 64 bytes = **4,096 bytes** (account payload).

Each entry: `(discriminator, target_protocol, balance_delta_in, balance_delta_out, timestamp, slot_hash, blockhash)`. Each entry double-bound by slot + blockhash (C22 macaroon-style). Applies uniformly. Rent paid by owner per L-12.

### TA-16 — DELETED
Was `InstructionConstraints.parser_version: u8` under the tier model (C23). **DELETED in Phase 1 per L-1** (incompatible with Option A — there is no T1 parser path). The ID `TA-16` is permanently retired; no future primitive will re-use it.

### TA-17 — Auto-revoke on N consecutive failures (LOCKED per L-10)
**Location:** `AgentEntry.consecutive_failures: u8` (NOT `SessionAuthority` — sessions are ephemeral and would lose counter state on rotation).

**Filter:** Increments **only** on `SigilError::*` policy-violation codes. External causes (CU exhaustion, network errors, non-Sigil program failures, pre-finalize sysvar bound exceedance, runtime account-resolution failure) do **NOT** increment the counter. The filter list is exhaustive and committed at Phase 3 implementation time alongside the new error variant.

**Threshold:** Configurable per D-2. **Floor = 3, ceiling = 20, default = 5.** Stored on `PolicyConfig` as `auto_revoke_threshold: u8` with runtime range check.

**Behavior on trip:** AgentEntry transitions to a paused/revoked state; emits a K6 event with the trip reason. Owner-only `unpause_agent` / `revoke_agent` resets the counter to 0. Successful finalize also resets to 0 (Phase 3 decides whether to use a saturating decrement or hard reset).

**Error code:** `ErrAutoRevoked` = **6090** (G5 audit fix 2026-05-18 — prior "6088" was stale; 6088 is `ErrToken2022ExtensionForbidden`) — see [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md).

**DoS guard:** T-DoS-1 (auto-revoke spam) is mitigated by pairing TA-17 with TA-06 (per-agent cooldown). A storming adversary cannot increment the counter faster than the cooldown allows.

### TA-18 — Squads V4 SDK detection helper (LOCKED per L-11 — OFF-CHAIN ONLY)
**Off-chain ergonomics primitive. NOT an on-chain enforcement primitive.** See [§4.4 Off-chain SDK helpers](#44-off-chain-sdk-helpers-no-on-chain-enforcement) for the category framing.

**What it does:** A read-side SDK utility that inspects the program upgrade-authority and the program data account, and surfaces a structured warning to the dashboard / CLI if the upgrade authority is a single key (not a Squads V4 multisig vault PDA).

**What it does NOT do:** Block any transaction. Reject any seal(). Emit any on-chain event. Mutate any account.

**Scope:** `sdk/kit/src/dashboard/` only. No program code.

**Rationale (D-05):** Closes DEEP-9 (single-key upgrade authority) and DEEP-10 (solo founder bus factor) at the human-decision layer, not at the consensus layer. Sigil cannot enforce upgrade-authority shape on-chain (the upgrade-authority lives on a BPF loader account that is not a Sigil PDA); the best Sigil can do is detect and surface.

### TA-19 — `policy_preview_digest` (LOCKED per L-14 — NEW from Audit #3)
**SHA-256 of canonical-encoded policy form**, stored on both `PolicyConfig` (`policy_preview_digest: [u8; 32]`) and `PendingPolicyUpdate` (`new_policy_preview_digest: [u8; 32]`).

**Canonical form:** Borsh-serialize the policy in a strict field order (defined at Phase 2 implementation time), with all `Vec<T>` sorted lexically. The canonical encoding is a separate library function shared by the SDK and the program so that both compute the same digest.

**Handler behavior:** Every owner-initiated policy mutation (queue + apply) recomputes the digest from the canonical form and `require!` it matches `new_policy_preview_digest`. Mismatch rejects with `ErrPolicyPreviewMismatch` (code **6080** — G5 audit fix 2026-05-18; prior "6081" was stale, that code is `ObserveOnlyModeBlocksExecute`) — see [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md).

**Attack closed:** Audit #3 — SDK builds preview that owner sees and signs, but the on-chain instruction encodes a different policy (e.g., an extra allowlist entry the dashboard didn't render). The digest binds the visible preview to the executed form, making this discrepancy detectable.

**Phase:** lands in Phase 2 alongside the default-tightening pass.

**Phase 2 close-up additions:**
- `set_observe_only` instruction (F-12 audit fix) — direct owner-only flip of `vault.observe_only` (Option (a), no timelock; mirrors `freeze_vault`). observe_only is at position 10 of the canonical digest encoding, so the handler recomputes `policy_preview_digest` + bumps `policy_version` on every flip and emits `ObserveOnlyChanged`.
- F-11 `ActiveVaultRequiresAllowlist` (code 6082) enforced at `initialize_vault` AND at `set_observe_only` (when flipping to active=false). Active vaults must have at least one protocol or destination on the allowlist; observe_only=true skips the check (inert by design).

---

## 4.4 Off-chain SDK helpers (no on-chain enforcement)

This category groups primitives that live in `sdk/kit/` and never run on-chain. They produce structured warnings, telemetry, or ergonomic affordances — they cannot block transactions and cannot be relied upon as security boundaries.

Off-chain helpers are NOT counted in the on-chain Tier A surface for audit/threat-model purposes. They are listed here for cross-doc traceability.

**Current members:**
- **TA-18** — Squads V4 SDK detection helper (see above).

**Framing rule:** Any future off-chain ergonomic helper that earns a TA-NN ID must include the explicit "OFF-CHAIN ONLY" marker in its definition and be cross-linked from this section. On-chain primitives never live in this section.

---

## Attacker Classes (AC-1..AC-10)

Per [THREAT_MODEL_V2.md §2](./THREAT_MODEL_V2.md#2-attacker-classes--environmental-hazards) for full characterization. Brief here:

### AC-1 — Agent key leak
Session-key compromise via prompt injection, malicious tool call, agent host compromise, supply-chain attack.

### AC-2 — Owner key leak
Single-key owner phishing / hardware compromise / key-management failure. Mitigated by Squads V4 multisig per [D-05](#d-05--squads-v4-upgrade-authority) at the SDK layer (off-chain detection helper) plus [D-06](#d-06--tierregistry-asymmetric-threshold) registry-write threshold. **NOT a numbered TA primitive** — Squads detection is off-chain SDK ergonomics, not an on-chain enforcement primitive.

### AC-3 — Sigil program bug
Assertion bypass, integer overflow, missing constraint check, account validation gap in Sigil itself.

### AC-4 — Token-2022 silent drain
Malicious mint with `TransferFee`, `TransferHook`, `PermanentDelegate`, `DefaultAccountState::Frozen`, or `MintCloseAuthority` extensions.

### AC-5 — Protocol exploit
Exploit in a target protocol (Jupiter, Kamino, Drift, etc.) causing vault asset loss when the vault interacts with the exploited protocol.

### AC-6 — Stablecoin depeg
USDC or USDT depegs significantly from $1.00. Environmental hazard; accepted per documented unit-of-account.

### AC-7 — Network halt
Solana mainnet halts. Environmental hazard; Sigil cannot operate during halt. Symmetric (attacker can't drain either).

### AC-8 — CU exhaustion
Adversarial transaction crafted to exceed compute budget (1.4M CU) and revert. DoS, not theft.

### AC-9 — Sandwich injection
Attacker injects an instruction between Sigil's `validate_and_authorize` and `finalize_session` to perform a non-Sigil-authorized operation atomically.

### AC-10 — Durable nonce replay
A signed transaction using a durable nonce remains valid indefinitely. A leaked pre-signed instruction can execute at any time. Drift's April 2026 $285M loss precedent.

### AC-11 — Oracle staleness (V1 OUT-OF-SCOPE)
Pyth or Switchboard returns stale price data, leading a protocol to mis-price a vault position. Sigil does not consume oracles in V1. Folded into N1 TA-15 temporal binding (slot+blockhash double-bind) per D-09. v1.1 candidate for dual-floor with Pyth lazy fetch only when within 10% of floor.

### T-21 — Owner Policy Underspecification (workflow-mitigated)
Trust-assumption inversion: users empirically cannot pre-specify policy correctly. Maestro 60%+ default-policy rate. Workflow mitigations M-T21-1..4 (learning mode, attestation, onboarding wizard, policy-visibility UI). NOT an on-chain primitive.

### T-DoS-1 — Auto-revoke spam
Adversary spams crafted-failing bundles to trigger auto-revoke counter, denying legitimate agent service. V1 mitigation: auto-revoke deferred + per-action cooldown TA-06 rate-limits any counter increment.

### T-DoS-2 — Cosign lost-key brick
Agent session key lost; TA-09 cosign workflow wedges elevated operations. V1 mitigation: owner-only `force_unbind_session(vault, session)` with K5 timelock (48h).

### T-K6-1 — K6 silent emit failure
Highest-leverage single dependency per Architect 2026-05-17. CI static check + Stage 5 Inv-K6 formal verification target.

---

## Decisions (D-01..D-09)

### D-01 — Architecture pivot (Option A locks per L-1)
Deep-parsing universal walker → generic Maestro-floor guardrails + N1/N2/N4 always-on + generic vault-balance NM-E for every protocol uniformly. **No tier model. No per-protocol parsers. No Jupiter slippage verifier.** Every TA primitive applies to every program ID identically.

### D-02 — Auto-revoke threshold range (locked per L-10 / TA-17)
`auto_revoke_threshold: u8` configurable on `PolicyConfig` with runtime range check: **floor = 3, ceiling = 20, default = 5.** Counter increments only on `SigilError::*` policy-violation codes (external causes do not increment). State lives on `AgentEntry.consecutive_failures`, not `SessionAuthority`. **Supersedes** the prior D-02 "three-tier model" entry — tiers were dropped per L-1.

### D-03 — Unit of account
USDC face value at 1:1, not USD. No Pyth oracle in V1. Maestro precedent.

### D-04 — Token-2022 deposit-path TLV allowlist (locked per Option A)
TA-08 deposit-path check uses a **3-item ALLOWLIST**: `MemoTransfer`, `MetadataPointer`, `NonTransferable`. All other Token-2022 extensions reject at deposit. The ID `D-04` previously referenced "Funding gate"; that framing is dropped per L-2 (no audit/bounty/funding gate language in V2 scope). The funding-gate semantics, if revisited, will land in a v1.1 governance doc — not in V2 specs.

### D-05 — Squads V4 upgrade authority
Closes DEEP-9 (single-key upgrade authority) + DEEP-10 (solo founder bus factor). Program ID `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. 3-of-5 + 24-72hr timelock + autonomous mode (`config_authority == Pubkey::default()`).

### D-06 — DROPPED per L-1 (was TierRegistry asymmetric threshold)
The TierRegistry primitive presupposed the tier model. Under Option A (L-1), there is no tier registry to gate. The asymmetric-threshold idea is retained at the **policy-mutation** layer via TA-09 (cosign workflow) for elevated owner operations, NOT as a separate signed config.

### D-07 — Lighthouse pattern: INSPIRE not FORK
Sigil's PostExecutionAssertions IR shape is inspired by Lighthouse's 14 assertion types (per GeminiResearcher validation 2026-05-17: actual count is 14, not the previously-cited 8). No CPI to Lighthouse program; no fork of Lighthouse source. Append-only top-level instructions = zero upgrade-key contagion.

### D-08 — Anchor 0.32.1 for audit
Stay on Anchor 0.32.1 for the V2 audit cycle. Defer Anchor 1.0 migration to v1.1 post-mainnet. Rationale: minimize moving parts during audit; the 0.32 → 1.0 migration is a separate ~1-day effort once ecosystem stabilizes.

### D-09 — AC-11 oracle staleness out-of-V1
AC-11 (oracle staleness) is explicitly out-of-scope for V1. Folded into N1 TA-15 temporal binding (slot+blockhash double-bind) for any caller that wants oracle-style verification. v1.1 candidate for dual-floor dollar-value tracking with Pyth lazy fetch.

---

## Error Code Allocation

**Canonical source:** [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md). The summary below is for cross-doc convenience only; if it disagrees with the canonical doc, the canonical doc wins.

**Current state (post-Stage-1, V1 baseline):**
- **6000-6080:** 81 V1 variants (verified line-by-line against `programs/sigil/src/errors.rs`).

**Phase 1 deletions (LANDED 2026-05-17):** 2 Jupiter-runtime variants deleted: 6030 `SwapSlippageExceeded`, 6031 `InvalidJupiterInstruction`. The 3rd variant from the prompt's deletion list — `SlippageBpsTooHigh` (was 6033) — was **kept** because it is the only error variant used by the surviving `max_slippage_bps <= MAX_SLIPPAGE_BPS` config-bound check in `initialize_vault.rs:88` and `queue_policy_update.rs:99`, which D-5 explicitly preserves as a generic slippage primitive (not Jupiter-specific). Deleting it would have required either deleting the D-5-preserved validation or redirecting to a misleading existing error. This deviation is recorded in the Phase 1 commit message and in the canonical [ERROR_CODE_ALLOCATION_V2.md](./ERROR_CODE_ALLOCATION_V2.md).

**Post-Phase-1 V1 count:** 79 variants at codes 6000-6078 (NOT 78/6000-6077 as the prompt assumed). Compaction strategy chosen; all codes from 6030 onward shifted down by 2.

**V2 reservation table starts at 6079** (compaction; the first new V2 variant `ErrInvalidCapability` lands at 6079, not 6078). Phase 2 close-up appended 6082 `ErrActiveVaultRequiresAllowlist` (F-11), shifting Phase 3+ reservations down by 1:
- 6079 `ErrInvalidCapability` (TA-04, Phase 2 — LANDED)
- 6080 `ErrPolicyPreviewMismatch` (TA-19, Phase 2 — LANDED)
- 6081 `ErrObserveOnlyModeBlocksExecute` (TA-19, Phase 2 — LANDED)
- 6082 `ErrActiveVaultRequiresAllowlist` (F-11, Phase 2 close-up — LANDED)
- 6083 `ErrMintNotPinned` (TA-03, Phase 3)
- 6084 `ErrOutsideOperatingHours` (TA-05, Phase 3)
- 6085 `ErrCooldownActive` (TA-06, Phase 3)
- 6086 `ErrGraylistFriction` (TA-07, Phase 3)
- 6087 `ErrGraylistFull` (TA-07, Phase 3)
- 6088 `ErrToken2022ExtensionForbidden` (TA-08, Phase 3)
- 6089 `ErrCosignRequired` (TA-09, Phase 3)
- 6090 `ErrAutoRevoked` (TA-17, Phase 3)
- 6091 `ErrSandwichIntegrity` (TA-10, Phase 4)
- 6092 `ErrProtectedWritable` (TA-11, Phase 4)
- 6093 `ErrSessionNonceMismatch` (AC-10, Phase 4)
- 6094 `ErrStableFloorViolation` (TA-12, Phase 5)
- 6095 `ErrDailyCapExceeded` (TA-13, Phase 5)
- 6096 `ErrRecipientCapExceeded` (TA-14, Phase 5)
- 6097 `ErrMintDeltaCapExceeded` (R-1, Phase 6)
- 6098 `ErrAtaAuthorityChanged` (R-2, Phase 6)
- 6099 `ErrOutputBelowFloor` (R-3, Phase 6)
- 6100 `ErrDeclarationInconsistent` (R-4, Phase 6)
- 6101 `ErrPendingOwnershipExists` (C26, Phase 8)
- 6102 `ErrPendingOwnershipNotReady` (C26, Phase 8)
- 6103 `ErrInvalidFreezeReason` (C27, Phase 8)
- 6104 `ErrReactivateCooldownActive` (C28, Phase 8)

**Notes:**
- TA-16 is DELETED per L-1; `ErrParserVersionMismatch` is NOT allocated.
- TA-17's `ErrAutoRevoked` IS allocated at **6090** (G5 audit fix 2026-05-18; the §4 reservation table at `ERROR_CODE_ALLOCATION_V2.md` is authoritative). Auto-revoke is in V2 scope under Option A — TA-17 is locked, with TA-06 cooldown as its T-DoS-1 mitigation.
- The repo-root `CLAUDE.md` cites range "6000-6070" — that is stale (real count is 6000-6080). Correction is out of L-6 scope for Phase 0.5; flagged for v1.1 housekeeping.

---

**END OF INTERFACES_V2.md**
