# Sigil Architecture Reference

This document describes the on-chain architecture of the Sigil program: account model,
instruction catalog, transaction composition pattern, key constants, and tech stack. It is
written directly from the Rust source (`programs/sigil/src/`) and is the authoritative
reference for layout and structural facts.

What this document does NOT cover: security invariants and access control matrix
(`docs/SECURITY.md`), full error code table (`docs/ERROR-CODES.md`), coding conventions and
guardrails (`docs/INSTRUCTIONS.md`), complete feature narrative (`docs/PROJECT.md`), and
per-instruction operational detail (`docs/ONCHAIN-FEATURE-INVENTORY.md`).

---

## System Overview

Sigil is a Solana program that enforces permission policies, spending caps, and session
accountability for AI agents interacting with DeFi protocols. It operates at the transaction
boundary: the owner configures a vault with policies; registered agents spend from the vault
only through Sigil-supervised sessions. No agent can move funds or change policy — only the
owner holds that authority.

Sigil is deliberately protocol-agnostic on-chain. It does not parse Jupiter swap routes,
Flash Trade position layouts, or any other protocol-specific instruction formats except for
one narrow carve-out: it inspects Jupiter V6 slippage bytes to enforce the vault's
`max_slippage_bps` cap. Everything else — which program, what arguments, what accounts — is
expressed by the owner through a generic instruction-constraint system (`InstructionConstraints`
PDA) that matches instructions by program ID, data byte ranges, and account-index pubkeys.

Solana enforces a maximum CPI call depth of four. Wrapping every DeFi instruction inside a
Sigil CPI would exhaust this budget immediately, since DeFi programs themselves issue CPIs
(e.g., Jupiter → token program → system program). Sigil therefore uses **instruction
composition** instead: a single Solana transaction carries `validate_and_authorize` (Sigil),
one or more DeFi instructions (any program), and `finalize_session` (Sigil) as sequential
top-level instructions. All three succeed or all three revert atomically. No CPI nesting is
required; Sigil reads the transaction's instruction sysvar to detect the surrounding
instructions (`programs/sigil/src/instructions/validate_and_authorize.rs:1-12`,
`programs/sigil/src/instructions/finalize_session.rs:1-12`).

---

## Transaction Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Solana Transaction (atomic — all succeed or all revert)                │
│                                                                         │
│  ┌─────────────────────────┐                                           │
│  │ [0] ComputeBudget        │  Set CU limit (1.4M) + priority fee      │
│  │     SetComputeUnitLimit  │                                           │
│  │     SetComputeUnitPrice  │                                           │
│  └────────────┬────────────┘                                           │
│               │                                                         │
│               ▼                                                         │
│  ┌─────────────────────────┐                                           │
│  │ [1] validate_and_        │  Sigil program                           │
│  │     authorize            │  · Checks agent capability               │
│  │                          │  · Checks daily spend cap (SpendTracker) │
│  │  IN:  vault, policy,     │  · Checks per-agent spend (Overlay)      │
│  │       tracker, agent     │  · Verifies InstructionConstraints match │
│  │       overlay, session   │  · Checks Jupiter slippage (if Jupiter)  │
│  │                          │  · Creates SessionAuthority PDA          │
│  │  OUT: session.authorized │  · Captures Phase B2 account snapshots   │
│  │       = true; delegation │  · Approves token delegation to agent    │
│  │       set on vault ATA   │                                           │
│  └────────────┬────────────┘                                           │
│               │  session.authorized = true                              │
│               ▼                                                         │
│  ┌─────────────────────────┐                                           │
│  │ [2..N] DeFi Instruction  │  Any external program                    │
│  │        (one or more)     │  e.g. Jupiter V6 swap, Flash Trade open  │
│  │                          │  · Executes against vault token accounts  │
│  │  IN:   vault ATAs,       │  · Consumes the approved delegation       │
│  │        protocol accounts │                                           │
│  └────────────┬────────────┘                                           │
│               │                                                         │
│               ▼                                                         │
│  ┌─────────────────────────┐                                           │
│  │ [N+1] finalize_session   │  Sigil program                           │
│  │                          │  · Verifies session still authorized      │
│  │  IN:  session, vault,    │  · Revokes token delegation               │
│  │       policy, tracker,   │  · Records spend in SpendTracker +       │
│  │       overlay            │    AgentSpendOverlay                      │
│  │                          │  · Evaluates PostExecutionAssertions      │
│  │  OUT: session PDA closed │  · Closes SessionAuthority PDA           │
│  │       rent → agent       │  · Emits SessionFinalized event          │
│  └─────────────────────────┘                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

`validate_and_authorize` uses `load_instruction_at_checked` from the instruction introspection
sysvar to confirm that `finalize_session` appears later in the same transaction
(`programs/sigil/src/instructions/validate_and_authorize.rs`). It identifies `finalize_session`
by its 8-byte Anchor discriminator:
`FINALIZE_SESSION_DISCRIMINATOR = [34, 148, 144, 47, 37, 130, 206, 161]`
(`programs/sigil/src/state/mod.rs:66`).

---

## Account Model

All sizes are read from `pub const SIZE` in the respective source files. Zero-copy accounts
use `#[account(zero_copy)]` and require `AccountLoader` (not `Account`) at call sites.

| PDA | Seeds | Size (bytes) | Notes | Source |
|-----|-------|:------------:|-------|--------|
| `AgentVault` | `["vault", owner, vault_id_le8]` | 635 | Root vault state; `agents: Vec<AgentEntry>` capped at 10 entries × 49 bytes | `programs/sigil/src/state/vault.rs:109-127` |
| `PolicyConfig` | `["policy", vault]` | 826 | Spending caps, protocol allow/deny list, slippage, timelock, `policy_version` OCC counter | `programs/sigil/src/state/policy.rs:104-124` |
| `SpendTracker` | `["tracker", vault]` | 2,840 | **Zero-copy**; 144 × 10-min epoch buckets for rolling 24 h USD spend; per-protocol counters (10 slots × 48 bytes) | `programs/sigil/src/state/tracker.rs:70` |
| `SessionAuthority` | `["session", vault, agent, token_mint]` | 377 | Per-session auth token; delegation state, fees, stablecoin snapshot, Phase B2 assertion snapshots (4 × 32 bytes) | `programs/sigil/src/state/session.rs:75-76` |
| `AgentSpendOverlay` | `["agent_spend", vault, &[0u8]]` | 2,528 | **Zero-copy**; 10 agent slots × 232 bytes (24-bucket hourly epoch); lifetime spend + tx count arrays | `programs/sigil/src/state/agent_spend_overlay.rs:82-88` |
| `EscrowDeposit` | `["escrow", source_vault, destination_vault, escrow_id_le8]` | 170 | Escrow state: net amount, expiry, 32-byte condition hash, status enum | `programs/sigil/src/state/escrow.rs:26` |
| `InstructionConstraints` | `["constraints", vault]` | 35,888 | **Zero-copy**; 64 entries × 560 bytes (8 data + 5 account constraints); strict-mode flag; schema version | `programs/sigil/src/state/constraints.rs:177` |
| `PendingPolicyUpdate` | `["pending_policy", vault]` | 826 | Queued policy diff; all 14 policy fields as `Option<T>`; holds `executes_at` timestamp | `programs/sigil/src/state/pending_policy.rs:42-60` |
| `PendingConstraintsUpdate` | `["pending_constraints", vault]` | 35,904 | **Zero-copy**; same 64-entry layout as `InstructionConstraints` plus `queued_at` / `executes_at` timestamps | `programs/sigil/src/state/pending_constraints.rs:42` |
| `PendingAgentPermissionsUpdate` | `["pending_agent_perms", vault, agent]` | 105 | Queued capability + spend-limit change for one agent; per-agent PDA allows concurrent updates | `programs/sigil/src/state/pending_agent_perms.rs:21` |
| `PendingCloseConstraints` | `["pending_close_constraints", vault]` | 57 | Minimal timelock gate for constraint PDA closure; holds `queued_at` / `executes_at` | `programs/sigil/src/state/pending_close_constraints.rs:15` |
| `PostExecutionAssertions` | `["post_assertions", vault]` | 352 | **Zero-copy**; up to 4 assertion entries × 76 bytes; Phase B1 (absolute), B2 (delta), B3 (cross-field) modes | `programs/sigil/src/state/post_assertions.rs:115` |

Notes on zero-copy accounts:
- Zero-copy accounts are declared with `#[account(zero_copy)]` and carry `#[repr(C)]`-compatible
  Pod fields only. They are accessed via `AccountLoader<'info, T>` and require explicit `load()`
  or `load_mut()` before field access.
- `InstructionConstraints` and `PendingConstraintsUpdate` exceed Solana's 10,240-byte CPI
  allocation limit. They are allocated and extended across multiple transactions using
  `allocate_constraints_pda`, `allocate_pending_constraints_pda`, and `extend_pda`.

---

## Instruction Catalog

Total: **36** dispatchable instructions defined in `programs/sigil/src/lib.rs`.

### Vault Lifecycle (5)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `initialize_vault` | `instructions/initialize_vault.rs` | Create `AgentVault` + `PolicyConfig` + `SpendTracker` + `AgentSpendOverlay` PDAs; owner-only |
| `freeze_vault` | `instructions/freeze_vault.rs` | Immediately set vault status to `Frozen`; preserves all agent entries |
| `reactivate_vault` | `instructions/reactivate_vault.rs` | Unfreeze vault; optionally register a new agent in the same call |
| `close_vault` | `instructions/close_vault.rs` | Close vault (requires `active_sessions == 0`); reclaim rent from owned PDAs |

### Fund Management (2)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `deposit_funds` | `instructions/deposit_funds.rs` | Owner deposits SPL tokens into vault ATA; increments `total_deposited_usd` for stablecoins |
| `withdraw_funds` | `instructions/withdraw_funds.rs` | Owner withdraws tokens from vault ATA; increments `total_withdrawn_usd` for stablecoins |

### Agent Execution (3)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `validate_and_authorize` | `instructions/validate_and_authorize.rs` | Pre-action gate: capability, spend cap, constraint, and slippage checks; creates `SessionAuthority` PDA; captures Phase B2 snapshots |
| `finalize_session` | `instructions/finalize_session.rs` | Post-action: revoke delegation, record spend in tracker + overlay, evaluate post-assertions, close `SessionAuthority` PDA |
| `agent_transfer` | `instructions/agent_transfer.rs` | Agent-initiated stablecoin transfer to a policy-allowed destination; spend-capped and policy-version-gated |

### Agent Management (7)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `register_agent` | `instructions/register_agent.rs` | Add agent pubkey to vault with capability level and per-agent spend limit (max 10 per vault) |
| `revoke_agent` | `instructions/revoke_agent.rs` | Remove agent entry; auto-freezes vault if the last agent is removed |
| `pause_agent` | `instructions/pause_agent.rs` | Set `agent.paused = true`; blocks all agent execution immediately |
| `unpause_agent` | `instructions/unpause_agent.rs` | Clear `agent.paused`; restores execution rights |
| `queue_agent_permissions_update` | `instructions/queue_agent_permissions_update.rs` | Timelock-queue a capability + spend-limit change for one agent; creates `PendingAgentPermissionsUpdate` PDA |
| `apply_agent_permissions_update` | `instructions/apply_agent_permissions_update.rs` | Apply queued agent update after timelock expires; closes pending PDA |
| `cancel_agent_permissions_update` | `instructions/cancel_agent_permissions_update.rs` | Cancel a queued agent update; closes `PendingAgentPermissionsUpdate` PDA |

### Policy and Timelock (3)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `queue_policy_update` | `instructions/queue_policy_update.rs` | Timelock-queue up to 14 policy field changes as `Option<T>`; creates `PendingPolicyUpdate` PDA |
| `apply_pending_policy` | `instructions/apply_pending_policy.rs` | Apply queued policy after timelock expires; bumps `policy_version` for OCC |
| `cancel_pending_policy` | `instructions/cancel_pending_policy.rs` | Cancel a queued policy update; closes `PendingPolicyUpdate` PDA |

### Instruction Constraints (7)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `allocate_constraints_pda` | `instructions/allocate_constraints_pda.rs` | Allocate `InstructionConstraints` PDA at 10,240-byte CPI limit; extend before populate |
| `allocate_pending_constraints_pda` | `instructions/allocate_pending_constraints_pda.rs` | Allocate `PendingConstraintsUpdate` PDA at 10,240-byte CPI limit |
| `extend_pda` | `instructions/extend_pda.rs` | Grow a constraints PDA by up to 10,240 bytes per call toward full `SIZE` |
| `create_instruction_constraints` | `instructions/create_instruction_constraints.rs` | Populate a pre-allocated `InstructionConstraints` PDA with entries and strict-mode flag |
| `queue_constraints_update` | `instructions/queue_constraints_update.rs` | Timelock-queue a full constraints replacement |
| `apply_constraints_update` | `instructions/apply_constraints_update.rs` | Apply queued constraints after timelock expires; bumps `policy_version` |
| `cancel_constraints_update` | `instructions/cancel_constraints_update.rs` | Cancel a queued constraints update; closes `PendingConstraintsUpdate` PDA |

### Constraint Closure (3)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `queue_close_constraints` | `instructions/queue_close_constraints.rs` | Timelock-queue closure of the `InstructionConstraints` PDA |
| `apply_close_constraints` | `instructions/apply_close_constraints.rs` | Close constraints PDA after timelock; clears `policy.has_constraints`; bumps `policy_version` |
| `cancel_close_constraints` | `instructions/cancel_close_constraints.rs` | Cancel a queued constraint closure; closes `PendingCloseConstraints` PDA |

### Escrow (4)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `create_escrow` | `instructions/create_escrow.rs` | Agent-initiated stablecoin escrow between two vaults; fees deducted upfront; spend-capped at creation |
| `settle_escrow` | `instructions/settle_escrow.rs` | Destination agent claims funds before expiry; SHA-256 proof required for conditional escrows |
| `refund_escrow` | `instructions/refund_escrow.rs` | Source agent or owner reclaims expired escrow; cap charge is NOT reversed (prevents cap-washing) |
| `close_settled_escrow` | `instructions/close_settled_escrow.rs` | Owner closes a settled or refunded `EscrowDeposit` PDA to reclaim rent |

### Post-Execution Assertions (2)

| Instruction | Source File | Purpose |
|-------------|-------------|---------|
| `create_post_assertions` | `instructions/create_post_assertions.rs` | Configure up to 4 byte-level account state checks evaluated inside `finalize_session` |
| `close_post_assertions` | `instructions/close_post_assertions.rs` | Close `PostExecutionAssertions` PDA; returns rent to owner |

---

## Key Constants

All values are read from `programs/sigil/src/state/mod.rs` unless otherwise noted.

| Name | Value | Source |
|------|-------|--------|
| `MAX_AGENTS_PER_VAULT` | `10` | `programs/sigil/src/state/mod.rs:28` |
| `MAX_ALLOWED_PROTOCOLS` | `10` | `programs/sigil/src/state/mod.rs:35` |
| `MAX_ALLOWED_DESTINATIONS` | `10` | `programs/sigil/src/state/mod.rs:38` |
| `SESSION_EXPIRY_SLOTS` | `20` (~8 seconds) | `programs/sigil/src/state/mod.rs:41` |
| `PROTOCOL_FEE_RATE` | `200` (= 0.02% = 2 BPS; denominator 1,000,000) | `programs/sigil/src/state/mod.rs:47` |
| `MAX_DEVELOPER_FEE_RATE` | `500` (= 0.05% = 5 BPS; denominator 1,000,000) | `programs/sigil/src/state/mod.rs:50` |
| `MAX_SLIPPAGE_BPS` | `5000` (= 50%) | `programs/sigil/src/state/mod.rs:54` |
| `MAX_ESCROW_DURATION` | `2_592_000` seconds (30 days) | `programs/sigil/src/state/mod.rs:57` |
| `MIN_TIMELOCK_DURATION` | `1800` seconds (30 minutes) | `programs/sigil/src/state/mod.rs:62` |
| `FINALIZE_SESSION_DISCRIMINATOR` | `[34, 148, 144, 47, 37, 130, 206, 161]` | `programs/sigil/src/state/mod.rs:66` |
| `FULL_CAPABILITY` | `2` (`CAPABILITY_OPERATOR`) | `programs/sigil/src/state/mod.rs:32` |
| `USD_DECIMALS` | `6` | `programs/sigil/src/state/mod.rs:224` |
| `USDC_MINT` (devnet) | `DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH` | `programs/sigil/src/state/mod.rs:110-113` |
| `USDC_MINT` (mainnet) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `programs/sigil/src/state/mod.rs:117-120` |
| `USDT_MINT` (devnet) | `43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze` | `programs/sigil/src/state/mod.rs:125-128` |
| `USDT_MINT` (mainnet) | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `programs/sigil/src/state/mod.rs:132-135` |
| `JUPITER_PROGRAM` | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | `programs/sigil/src/state/mod.rs:182-185` |
| `FLASH_TRADE_PROGRAM` | `FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn` | `programs/sigil/src/state/mod.rs:189-192` |
| `JUPITER_LEND_PROGRAM` | `JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu` | `programs/sigil/src/state/mod.rs:196-199` |
| `JUPITER_EARN_PROGRAM` | `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` | `programs/sigil/src/state/mod.rs:203-206` |
| `JUPITER_BORROW_PROGRAM` | `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi` | `programs/sigil/src/state/mod.rs:210-213` |
| `TOKEN_2022_PROGRAM_ID` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `programs/sigil/src/state/mod.rs:217-220` |

`USDC_MINT` and `USDT_MINT` are build-time feature-gated: the binary is compiled with either
`--features devnet` or `--features mainnet`; both flags simultaneously are a compile error
(`programs/sigil/src/state/mod.rs:82-89`).

Stablecoin recognition at runtime: `is_stablecoin_mint(&mint)` returns `true` only for
`USDC_MINT` and `USDT_MINT`. With the `devnet-testing` sub-feature it accepts any mint to
allow testing on devnet where Circle-controlled USDC cannot be minted
(`programs/sigil/src/state/mod.rs:168-176`).

### Agent Capability Model

The old 21-bit `permissions: u64` ActionType bitmask has been eliminated. Spending
classification now derives from the matched `ConstraintEntryZC.is_spending` field.
Agent authorization uses a 2-bit capability field
(`programs/sigil/src/state/vault.rs:6-8`, `programs/sigil/src/state/mod.rs:32`):

| Constant | Value | Meaning |
|----------|-------|---------|
| `CAPABILITY_DISABLED` | `0` | Agent cannot execute any actions |
| `CAPABILITY_OBSERVER` | `1` | Non-spending actions only |
| `CAPABILITY_OPERATOR` | `2` | Full spending and non-spending execution |

---

## Composition Principle

Sigil never CPIs into DeFi programs. The Solana runtime caps CPI call depth at 4 levels.
DeFi programs routinely reach depth 3 or 4 on their own (protocol → token program → system
program). Inserting Sigil as a CPI caller would immediately exhaust the budget.

Instead, Sigil enforces guardrails through **instruction composition**: multiple top-level
instructions in a single versioned transaction. The SDK assembles:

```
[ComputeBudget ixs, validate_and_authorize, ...defiIxs, finalize_session]
```

All instructions execute sequentially within one atomic transaction. If any instruction
fails, the entire transaction reverts. Sigil reads adjacent instructions via the instruction
introspection sysvar (`get_stack_height`, `load_instruction_at_checked`) rather than through
CPI. This is the only pattern that achieves atomicity without consuming CPI depth.

The SDK entry point is `seal()` in `sdk/kit/src/seal.ts`. It accepts arbitrary DeFi
instructions from any source (Jupiter API, agent frameworks, MCP servers), resolves vault
state, builds the three-part instruction bundle, and submits a versioned transaction. The
`SigilClient` class in `sdk/kit/src/` is the primary consumer API and wraps `seal()` with
instance-level vault and agent state caching.

---

## Tech Stack

- **Anchor**: `0.32.1` — `programs/sigil/Cargo.toml:25`, `Anchor.toml:2`
- **Rust toolchain**: `1.89.0` (stable) — `rust-toolchain.toml:2`
- **Solana program SDK**: `>=2` — `programs/sigil/Cargo.toml:27`
- **Devnet program ID**: `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL` — `Anchor.toml:9`, `programs/sigil/src/lib.rs:16`
- **Bytemuck**: `1.14` with `derive` + `min_const_generics` — required by zero-copy account types — `programs/sigil/Cargo.toml:28`
- **Blake3**: `=1.5.5` (pinned) — discriminator computation; pinned to avoid edition 2024 incompatibility with BPF platform-tools — `programs/sigil/Cargo.toml:31-33`
- **TypeScript SDK**: `sdk/kit/` — ESM-only, peer dep `@solana/kit ^6.2.0` — `sdk/kit/package.json:63`
- **Testing**: LiteSVM in-process VM (unit, ~45 s), Surfpool LiteSVM-backed validator (integration, ~60 s), devnet cluster (~5 min) — `Anchor.toml:21-23`

---

## Cross-Reference Index

| Document | What it covers |
|----------|---------------|
| `docs/PROJECT.md` | Full program specification: goals, design decisions, feature narrative |
| `docs/INSTRUCTIONS.md` | Coding conventions, guardrails, and invariants for contributors |
| `docs/ERROR-CODES.md` | Complete table of all error codes with messages and triggering conditions |
| `docs/SECURITY.md` | Threat model, access control matrix, trust boundaries, upgrade authority governance |
| `docs/ONCHAIN-FEATURE-INVENTORY.md` | Per-instruction operational detail, complete account type list, event catalog, capability model |
| `docs/RFC-ACTIONTYPE-ELIMINATION.md` | Design rationale for replacing the 21-bit ActionType bitmask with the constraint-derived `is_spending` field |
| `docs/COMMANDS-REFERENCE.md` | All build, test, deploy, and tooling commands |
| `docs/DEPLOYMENT.md` | Devnet and mainnet deployment procedures, verification steps |
| `docs/SECURITY-FINDINGS-2026-04-07.md` | Detailed write-up of security findings and mitigations (A3, A5, H-1, M-1, M-2) |
