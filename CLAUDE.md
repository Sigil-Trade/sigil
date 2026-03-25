# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read docs/PROJECT.md for full specification. Read docs/INSTRUCTIONS.md for all coding rules and guardrails. Read WRAP-ARCHITECTURE-PLAN.md for the definitive implementation plan and priorities.**

## What This Is

Phalnx is a Solana Anchor program (Rust) that sits between AI agent signing keys and DeFi protocols (Jupiter, Flash Trade). It provides PDA vaults with configurable permission policies, spending limits, and audit infrastructure. The developer is proficient in Rust and Anchor — write production-quality code.

**Program ID:** `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`

---

## Reference Skills (`.claude/skills/`) — Load On Demand

Skills are large reference files (20KB–213KB each). Reading one permanently consumes that many tokens for the entire session. **Do not read skills proactively.**

Load a skill only when you need specific API specs, integration patterns, or security rules not already covered in CLAUDE.md or MEMORY.md. When you do load a skill, read only the specific file within the skill directory that answers your question — not the entire directory.

| Skill | Size | When to read | Path |
|-------|------|-------------|------|
| **solana-dev** | 83KB | Anchor/LiteSVM patterns, program security checklist | `.claude/skills/solana-dev/` |
| **jupiter** | 21KB | Jupiter API endpoints, swap instruction building | `.claude/skills/jupiter/` |
| **helius** | 177KB | Priority fees, RPC, DAS API, webhooks | `.claude/skills/helius/` |
| **vulnhunter** | 54KB | Vulnerability patterns, sharp edges, variant analysis | `.claude/skills/vulnhunter/` |
| **code-recon** | 58KB | Architectural reviews, trust boundary mapping | `.claude/skills/code-recon/` |
| **drift** | 137KB | Drift Protocol SDK, perps, spot trading | `.claude/skills/drift/` |
| **pinocchio-dev** | 126KB | New greenfield programs only — NOT for phalnx | `.claude/skills/pinocchio-dev/` |
| **squads** | 213KB | Squads V4 multisig, Smart Account, Grid | `.claude/skills/squads/` |
| **flash-trade** | 123KB | Flash Trade perps, position management, composability | `.claude/skills/flash-trade/` |
| **solana-kit** | 114KB | @solana/kit modern SDK, tree-shakeable, zero-dependency | `.claude/skills/solana-kit/` |
| **solana-kit-migration** | 94KB | Migrating @solana/web3.js v1.x → @solana/kit, API mappings | `.claude/skills/solana-kit-migration/` |

---

## Monorepo & Commands

pnpm workspace with changesets for versioning. All packages publish to npm with OIDC provenance.

```
pnpm-workspace.yaml → sdk/*, sdk/custody/*, packages/*, apps/*
```

### Release Workflow
1. Add changeset: `pnpm changeset` → commit with your PR
2. Merge to `main` → CI opens a **Version Packages** PR (bumps versions, generates changelogs)
3. Merge the Version Packages PR → CI publishes to npm with provenance
4. Never run `npm publish` manually — the release workflow handles it

```bash
# Build the program (--no-idl required on stable Rust with Anchor 0.32.1)
anchor build --no-idl

# Restore committed IDL after build (build may produce stale IDL)
git checkout -- target/idl/ target/types/

# Sync program ID with declare_id!
anchor keys sync

# Lint
npm run lint          # Check formatting (prettier)
npm run lint:fix      # Fix formatting

# Check Rust formatting
cargo fmt --check --manifest-path programs/phalnx/Cargo.toml

# On-chain tests (LiteSVM — no validator needed)
npx ts-mocha -p ./tsconfig.json -t 300000 tests/<file>.ts

# Package-specific tests (from package directory)
pnpm --filter <package> test
```

See `docs/COMMANDS-REFERENCE.md` for security tooling (Sec3 X-Ray, Trident, Certora), Surfpool, and environment setup.

---

## Architecture

### Instruction Composition Pattern (NOT CPI Wrapping)

The program uses multi-instruction atomic transactions to avoid Solana's 4-level CPI depth limit:
```
Transaction = [validate_and_authorize, DeFi_instruction, finalize_session]
```
All succeed or all revert atomically. The SDK constructs these composed transactions.

### Account Model

Nine PDA account types in `state/`:

| PDA | Seeds | Size |
|-----|-------|------|
| **AgentVault** | `[b"vault", owner, vault_id]` | 634 bytes |
| **PolicyConfig** | `[b"policy", vault]` | 817 bytes |
| **SpendTracker** | `[b"tracker", vault]` | 2,840 bytes (zero-copy) |
| **SessionAuthority** | `[b"session", vault, agent, token_mint]` | Standard |
| **PendingPolicyUpdate** | `[b"pending_policy", vault]` | Standard |
| **EscrowDeposit** | `[b"escrow", source_vault, dest_vault, escrow_id]` | 170 bytes |
| **InstructionConstraints** | `[b"constraints", vault]` | 8,318 bytes |
| **PendingConstraintsUpdate** | `[b"pending_constraints", vault]` | 8,334 bytes |
| **AgentSpendOverlay** | `[b"agent_spend", vault]` | 2,528 bytes (zero-copy) |

See `docs/ARCHITECTURE.md` for full account descriptions, ActionType classification, validate_and_authorize flow, on-chain constants, and x402 payment flow.

### Key Design Decisions
- Multi-agent vaults: up to 10 agents per vault with per-agent permission bitmasks (21 bits)
- Rolling 24h window for spending caps, not calendar-day
- Protocol fees collected at authorization (upfront, non-bypassable)
- fee_destination is immutable after vault creation (prevents compromised owner from redirecting fees)
- All vectors bounded: max 10 protocols, 10 destinations. SpendTracker uses fixed 144-element epoch bucket array.
- Stablecoin-only: USD tracking uses stablecoin identity (USDC/USDT amount / 10^6 = USD). No oracles.
- Token validation via typed `Account<'info, Mint>` with constraint checks (not raw remaining_accounts)

---

## Critical Constraints

1. **CPI depth = 4 max.** Use instruction composition, never nested CPIs.
2. **Compute budget = 1.4M CU.** Always set compute budget in composed transactions.
3. **Checked math only.** Never `+`, `-`, `*`, `/` on u64. Always `.checked_add()` etc., return `PhalnxError::Overflow` on None. This is the most common audit finding — zero tolerance.
4. **Bounded vectors.** No unbounded `Vec<T>` in on-chain accounts.
5. **Every instruction emits an Anchor event** via `emit!()`. No exceptions.
6. **Owner = full authority. Agent = execute only.** Agents cannot modify policies or withdraw.
7. **developer_fee_rate capped at 500 (5 BPS = 0.05%).** Hardcoded `MAX_DEVELOPER_FEE_RATE` constant.
8. **No external crates** beyond anchor-lang, anchor-spl, solana-program.
9. **Account init max = 10,240 bytes.** CPI account creation limit. SpendTracker is sized to fit.
10. **Zero-copy accounts require `#[repr(C)]`** and Pod-compatible fields only (no String, Vec, Option, enum). Use `AccountLoader`, not `Account`.
11. **`require_keys_eq!` for pubkey checks, `require!` for everything else.** Do not use `require_eq!` to compare pubkeys.
12. **IDL is committed, not auto-generated.** After `anchor build --no-idl`, always `git checkout -- target/idl/ target/types/` to restore the committed IDL.
13. **Build→IDL→Test after any Rust edit.** Never report a Rust change as complete without: `anchor build --no-idl` → `git checkout -- target/idl/ target/types/` → run relevant test file. "Done" without build = failed task.
14. **WIP commit per plan step.** When implementing multi-step plans, commit after each completed step: `[WIP step N/M] description`. Never accumulate >1 step of uncommitted changes. This prevents context overflow from losing progress.
15. **Check before overwriting.** Before editing any file, run `git diff <file>`. If uncommitted changes exist that you didn't make this session, STOP and ask. Never overwrite another agent's work.
16. **Changeset check after implementation.** After changes to `sdk/`, `plugins/`, `packages/`, or `apps/`, check if a changeset is needed. Ask before creating.

---

## Formally Verified Invariants (Certora)

These invariants are enforced by formal verification. **Code changes must not violate them.**

Specs live in `programs/phalnx/src/certora/specs/`:
- `access_control.rs` — constants correctness, fee cap = 500, session expiry = 20 slots, rolling window = 86,400s, epoch buffer = 144 × 600 = 86,400, vector bounds (10/10)
- `session_lifecycle.rs` — expiry ≥ current slot, expiry = saturating_add(20), sessions expire after window, valid at creation, saturates at u64::MAX
- `spending_caps.rs` — decimal scaling preserves ordering, checked arithmetic overflow detection

---

## Error Codes (6000–6070)

71 error codes. Source of truth: `programs/phalnx/src/errors.rs`. See `docs/ERROR-CODES.md` for full table.

---

## Code Conventions

### Rust
- One file per instruction in `instructions/`, one file per account in `state/`
- Handler functions named `handler` within their module
- `require!()` for preconditions, `require_keys_eq!()` for pubkey comparisons
- `pub(crate)` for internal visibility, `emit!()` on every instruction
- `rustfmt` default formatting, max 100 char lines
- `.ok_or(error!(PhalnxError::Overflow))?` for checked math

### TypeScript
- `BN` from `@coral-xyz/anchor` for on-chain numbers
- `PublicKey` for addresses, never raw strings
- USD amounts use 6 decimals: `$500 = new BN(500_000_000)`

### Git
- Conventional commits: `feat:`, `fix:`, `test:`, `refactor:`

---

## Current State

On-chain program has 29 instructions, 9 PDA types, and is under active development (not frozen). Spending enforcement is **outcome-based**: `finalize_session` measures actual stablecoin balance delta (not declared amounts) for cap checks, with post-finalize instruction scan (error 6070) as defense-in-depth. See `WRAP-ARCHITECTURE-PLAN.md` for the definitive implementation plan and `scripts/test-counts.json` for test counts.

### Wrap Architecture (Definitive Direction)

Phalnx is a **security wrapper**, not a DeFi SDK. The `wrap()` function takes arbitrary DeFi instructions from any source (Jupiter API, Solana Agent Kit, MCP servers) and sandwiches them with `validate_and_authorize` + `finalize_session`. `PhalnxClient` is the primary API — holds vault/agent/network context, delegates to `wrap()` with instance-level caches.

**Phase 5 (SDK additions) — COMPLETE (all 10 steps):**
- `PhalnxClient` promoted (5.3): stateful client with `wrap()`, `executeAndConfirm()`, `getPnL()`, `getVaultState()`, `getTokenBalances()`, `getAgentBudget()`, static `createVault()`
- Test utilities (5.4): `@phalnx/kit/testing` subpath with `createMockRpc()`, `createMockVaultState()`, devnet helpers
- Formatting (5.5): 11 functions in `formatting.ts` with full-precision defaults (6 decimals USD, full token decimals)
- Vault presets (5.6): `presets.ts` with Jupiter/perps/lending/full-access templates
- Owner transactions (5.7): `buildOwnerTransaction()` in `owner-transaction.ts`
- Spending history (5.8): `getSpendingHistory()` in `state-resolver.ts` — 144-epoch circular buffer to chart-ready time series
- Post-finalize scan (5.9): defense-in-depth instruction check after finalize, error 6070
- SAK plugin (5.10): `packages/plugin-solana-agent-kit/` — thin adapter with swap/transfer/status actions via `PhalnxClient.executeAndConfirm()`

**Phase 6 (Analytics Data Layer) — COMPLETE (42 functions across 11 modules):**
- `formatting.ts` (11): USD/percent/time/address/token display with full-precision defaults
- `spending-analytics.ts` (3): velocity, breakdown, per-agent history
- `vault-analytics.ts` (2): health assessment, one-call summary
- `event-analytics.ts` (4): categorize, describe, build activity items, fetch feed
- `agent-analytics.ts` (4): profiles, leaderboard, comparison, error breakdown
- `security-analytics.ts` (3): 13-point posture, alert conditions, audit trail
- `portfolio-analytics.ts` (4): cross-vault aggregation, agent ranking, time series
- `protocol-analytics.ts` (2): per-protocol breakdown, cross-vault usage
- `advanced-analytics.ts` (7): slippage, cap velocity, deviation, idle capital, escalation latency, coverage ratio, permission utilization
- `protocol-names.ts` (1): shared protocol name resolution
- `math-utils.ts` (1): shared Herfindahl computation (bigint-safe)

See `WRAP-ARCHITECTURE-PLAN.md` for full spec and `WRAP-DISCRIMINATOR-TABLES.md` for verified discriminator bytes.

---

## Testing

Test counts are in `scripts/test-counts.json` (run `node scripts/update-test-counts.js` to refresh).

| Tier | Tool | Speed | When to use |
|------|------|-------|-------------|
| Unit | LiteSVM | ~45s for 361 tests | Policy logic, error paths, security exploits, composed TX with mocks |
| Integration | Surfpool | ~60s for 20 tests | Session expiry, real token balances, CU profiling, time travel |
| Cluster | Devnet | ~5min for 69 tests | End-to-end with deployed program, costs SOL |

On-chain tests use LiteSVM (in-process Solana VM) — no solana-test-validator needed. Shared helpers in `tests/helpers/litesvm-setup.ts`.
Surfpool tests use a local Surfnet (LiteSVM-backed validator with lazy devnet forking). Shared helpers in `tests/helpers/surfpool-setup.ts`.
Test file list and counts: `scripts/test-counts.json`.
