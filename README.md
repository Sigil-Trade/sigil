<div align="center">

<img src=".github/sigil-icon.svg" alt="Sigil" width="80" />

# Sigil

**On-chain guardrails for AI agents on Solana.**

Your policies are enforced by Solana validators, not software promises.

[![CI](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-2775-brightgreen)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

## Mental Model

Sigil is three layers. The security boundary is the **bottom** layer — the Solana program — not the SDK.

```
┌─────────────────────────────────────────────────────────────────┐
│  SDK (TypeScript) — convenient transaction builder              │
│  - createSigilClient + seal()                                   │
│  - createOwnerClient + reads/mutations                          │
│  - shield() — client-side pre-flight (advisory, fast-deny)      │
└─────────────────────────────────────────────────────────────────┘
                              │ builds
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Solana Transaction                                             │
│  [ validate_and_authorize ]  ← reads PolicyConfig PDA           │
│  [ DeFi instruction       ]  ← Jupiter / Flash Trade / etc.     │
│  [ finalize_session       ]  ← measures spend, updates tracker  │
└─────────────────────────────────────────────────────────────────┘
                              │ submits
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  ON-CHAIN PROGRAM (Anchor) — the security boundary              │
│  - Enforces spending caps (rejects tx if over)                  │
│  - Enforces protocol allowlist (rejects tx if not allowed)      │
│  - Enforces agent permissions (rejects tx if no rights)         │
│  - Vault PDA holds funds; agent has NO direct authority         │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** A developer cannot bypass on-chain enforcement by skipping the SDK. The agent's signing key has zero authority over vault funds. Only the on-chain Sigil program can authorize spending, and only after `validate_and_authorize` succeeds against the vault's on-chain policy. The SDK is the convenient way to construct transactions the on-chain program will accept — it is not where the rules live.

For the SDK-level detail (caches, hooks, plugins, owner vs. agent paths), see [`sdk/kit/README.md`](sdk/kit/README.md#mental-model).

## The Problem

Every AI agent on Solana today operates with unrestricted wallet access. Frameworks like Solana Agent Kit give agents raw keypair signing authority with zero spending limits, asset restrictions, or kill switches. There is no way for an agent owner to say "this agent can spend up to 500 USDC/day on Jupiter swaps, nothing else."

## The Solution

Sigil wraps your agent's wallet with on-chain policy enforcement. One call gives you client-side fast deny, TEE key custody, and on-chain vault enforcement — bundled as one product.

```typescript
import { seal } from "@usesigil/kit";

// seal() sandwiches any DeFi instruction with Sigil security
// policies enforced by Solana validators
```

### Security Model

Sigil provides three layers of protection in a single integration:

1. **Client-side policy checks** — fast deny before transactions hit the network
2. **TEE key custody** — agent private keys stored in hardware enclaves (Crossmint, Turnkey, Privy)
3. **On-chain vault enforcement** — PDA vaults with cryptographic policy guarantees enforced by Solana validators

### Key Features

- **Stablecoin-only USD tracking** — no oracle dependency, no feed staleness, no price manipulation risk. USDC/USDT amount = USD value
- **Rolling 24h spending caps** — 144-epoch circular buffer tracks stablecoin outflows. No exploitable midnight reset
- **Risk-reducing actions exempt** — closing positions, decreasing exposure, and removing collateral never count as spending
- **On-chain slippage verification** — Jupiter and Flash Trade slippage enforced by Solana validators via `max_slippage_bps` policy
- **Token delegation** — SPL `approve`/`revoke` CPI; funds never leave the vault
- **Timelocked policy changes** — queue updates with configurable delay to prevent rug-pulls
- **Agent transfers** — destination-allowlisted stablecoin transfers initiated by agents
- **Kill switch** — owner can freeze any vault instantly, revoking all agent permissions
- **On-chain audit trail** — every action emits Anchor events for full transaction history
- **x402 payments** — `shieldedFetch()` for automatic HTTP 402 payment negotiation, policy-enforced

### How It Works

Sigil uses **instruction composition** to avoid Solana's 4-level CPI depth limit. Instead of wrapping DeFi calls inside the program, it sandwiches them in an atomic transaction:

```
Transaction = [
  ValidateAndAuthorize,   // Sigil checks policy, creates session, delegates tokens
  DeFi instruction(s),    // Jupiter swap, Flash Trade open, etc.
  FinalizeSession         // Sigil records audit, revokes delegation
]
```

All instructions succeed or all revert atomically. The agent's signing key is validated, spending limits are checked, and the action is recorded — without adding CPI depth to the DeFi call.

### Account Model

Twelve PDA account types. Seeds and sizes are verified against `programs/sigil/src/state/` (the code is the source of truth).

| Account                             | Seeds                                    | Size (bytes)      | Purpose                                                          |
| ----------------------------------- | ---------------------------------------- | ----------------- | --------------------------------------------------------------- |
| **AgentVault**                      | `[b"vault", owner, vault_id]`            | 676               | Multi-agent vault: up to 10 agents, each a 2-bit capability      |
| **PolicyConfig**                    | `[b"policy", vault]`                     | 1,649             | Spending caps, protocol allowlist, leverage/slippage, timelock   |
| **SpendTracker**                    | `[b"tracker", vault]`                    | 3,328 (zero-copy) | 144-epoch circular buffer for rolling 24h USD spend tracking     |
| **SessionAuthority**                | `[b"session", vault, agent, token_mint]` | 619               | Ephemeral PDA created per action, expires after 30s wall-clock   |
| **PendingPolicyUpdate**             | `[b"pending_policy", vault]`             | 1,349             | Queued policy change with timelock, applied after delay          |
| **PendingAgentGrant**               | `[b"pending_agent_grant", vault]`        | 144               | Queued agent grant awaiting timelock apply                       |
| **PendingAgentPermissionsUpdate**   | `[b"pending_agent_perms", vault, agent]` | 185               | Queued per-agent capability/limit change awaiting apply          |
| **PendingOwnershipTransfer**        | `[b"pending_owner", vault]`              | 136               | Queued vault ownership handover (single or multisig accept)      |
| **AgentSpendOverlay**               | `[b"agent_spend", vault, &[0u8]]`        | 2,688 (zero-copy) | Per-agent rolling 24h spend tracking (10 agent slots)            |
| **PostExecutionAssertions**         | `[b"post_assertions", vault]`            | 672 (zero-copy)   | Optional post-execution checks (leverage, balance-delta)         |
| **AuditLogRejected**                | `[b"audit_rejected", vault]`             | 4,152 (zero-copy) | On-chain ring buffer of rejected actions                         |
| **AuditLogSuccess**                 | `[b"audit_success", vault]`              | 8,248 (zero-copy) | On-chain ring buffer of successful actions                       |

### On-Chain Instructions (32)

> Policy- and agent-level mutations are timelock-guarded and go through
> queue/apply/cancel flows for TOCTOU protection — there are no "direct" policy
> or permission mutation handlers.

| Instruction | Signer | Description |
| --- | --- | --- |
| **Vault Lifecycle** | | |
| `initialize_vault` | Owner | Create vault, policy, tracker, overlay PDAs (mandatory timelock) |
| `freeze_vault` | Owner | Protective freeze — blocks agent execution, preserves agents |
| `reactivate_vault` | Owner | Unfreeze vault, optionally add a new agent |
| `close_vault` | Owner | Close all PDAs, reclaim rent. Requires no active sessions. |
| **Fund Management** | | |
| `deposit_funds` | Owner | Transfer SPL tokens into vault |
| `withdraw_funds` | Owner | Withdraw tokens to owner |
| **Agent Execution** | | |
| `validate_and_authorize` | Agent | Check policy, collect fees, create session, delegate tokens |
| `finalize_session` | Agent | Outcome-based spend measurement, revoke delegation, close session |
| `agent_transfer` | Agent | Stablecoin transfer to an allowlisted destination |
| **Agent Management** | | |
| `register_agent` | Owner | Register agent with capability + spending limit (max 10 agents) |
| `revoke_agent` | Owner | Remove agent from vault |
| `pause_agent` | Owner | Temporarily block an agent without revoking |
| `unpause_agent` | Owner | Restore a paused agent |
| `set_observe_only` | Owner | Downgrade an agent to OBSERVER capability |
| `record_agent_violation` | Owner | Record an off-chain-observed agent violation on-chain |
| **Timelocked Agent Changes** | | |
| `queue_agent_grant` | Owner | Queue a timelocked new-agent grant |
| `apply_agent_grant` | Owner | Apply a queued agent grant after timelock |
| `cancel_agent_grant` | Owner | Cancel a queued agent grant |
| `queue_agent_permissions_update` | Owner | Queue timelocked capability/limit change for an agent |
| `apply_agent_permissions_update` | Owner | Apply a queued agent permission change after timelock |
| `cancel_agent_permissions_update` | Owner | Cancel a queued agent permission change |
| **Policy** | | |
| `queue_policy_update` | Owner | Queue a timelocked policy change |
| `apply_pending_policy` | Owner | Apply a queued policy change after timelock |
| `cancel_pending_policy` | Owner | Cancel a queued policy change |
| `approve_pending_policy` | Owner | Co-sign/approve a queued policy change |
| `promote_graylist_destination` | Owner | Promote a graylisted transfer destination to allowlisted |
| **Ownership Transfer** | | |
| `initiate_ownership_transfer` | Owner | Begin a two-step vault ownership handover |
| `accept_ownership_transfer` | Owner | Accept a pending ownership transfer |
| `accept_ownership_transfer_multisig` | Owner | Accept a pending ownership transfer via multisig |
| `cancel_ownership_transfer` | Owner | Cancel a pending ownership transfer |
| **Post-Execution Assertions** | | |
| `create_post_assertions` | Owner | Create PostExecutionAssertions PDA (leverage, balance-delta) |
| `close_post_assertions` | Owner | Remove post-execution assertions |

## Packages

| Package                                   | Description                                                          | npm                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@usesigil/kit`](./sdk/kit)              | Full SDK — policy engine, `seal()` API, TEE custody, analytics       | [![npm](https://img.shields.io/npm/v/@usesigil/kit)](https://www.npmjs.com/package/@usesigil/kit)           |
| [`@usesigil/platform`](./sdk/platform)    | Platform client — request TEE wallet provisioning via Solana Actions | [![npm](https://img.shields.io/npm/v/@usesigil/platform)](https://www.npmjs.com/package/@usesigil/platform) |
| [`@usesigil/custody`](./sdk/custody)      | TEE wallet custody adapters — Crossmint, Privy, Turnkey              | [![npm](https://img.shields.io/npm/v/@usesigil/custody)](https://www.npmjs.com/package/@usesigil/custody)   |
| [`@usesigil/plugins`](./packages/plugins) | Agent framework adapters — Solana Agent Kit                          | [![npm](https://img.shields.io/npm/v/@usesigil/plugins)](https://www.npmjs.com/package/@usesigil/plugins)   |

## Quick Start

### Add to an Existing Project

```bash
npm install @usesigil/kit
```

```typescript
import { seal } from "@usesigil/kit";

// seal() sandwiches any DeFi instruction with Sigil security
// policies enforced by Solana validators
```

## Program

| Network | Program ID                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Devnet  | [`7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK`](https://explorer.solana.com/address/7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK?cluster=devnet) |

## Development

```bash
# Build the Anchor program (--no-idl required on stable Rust with Anchor 0.32.1)
anchor build --no-idl

# Restore the committed IDL after building (build may emit a stale one)
git checkout -- target/idl/ target/types/

# Run on-chain tests (581 LiteSVM tests — no validator needed)
npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/sigil.ts tests/jupiter-integration.ts \
  tests/flash-trade-integration.ts tests/security-exploits.ts

# Run all SDK package tests
pnpm -r run test

# Lint
npm run lint
cargo fmt --check --manifest-path programs/sigil/Cargo.toml
```

### Test Suites

| Suite                                                               | Tests    |
| ------------------------------------------------------------------- | -------- |
| Core vault management & permission engine                           | 120      |
| Missing-coverage gap-fill (DC audit 2026-05-19)                     | 14       |
| Jupiter integration (composed swaps)                                | 9        |
| Jupiter Lend integration (deposit/withdraw)                         | 7        |
| Flash Trade integration (leveraged perps)                           | 17       |
| Security exploit scenarios                                          | 187      |
| TOCTOU security (policy version + timelock)                         | 6        |
| F-1 timelock-brick close (1b)                                       | 7        |
| Verified-build gate (Item 3 — upgrade-TOCTOU pin)                   | 9        |
| Analytics counters (failed TX + per-agent TX count)                 | 7        |
| Devnet integration tests (real network)                             | 64       |
| Surfpool integration tests (local Surfnet)                          | 49       |
| Platform client tests (`@usesigil/platform`)                        | 17       |
| Custody adapters (`@usesigil/custody`)                              | 96       |
| Kit-native SDK (`@usesigil/kit` — includes merged core + dashboard) | 1877     |
| Kit SDK devnet tests (`@usesigil/kit` devnet)                       | 34       |
| Plugins (`@usesigil/plugins`)                                       | 14       |
| Rust unit tests (cargo test)                                        | 182      |
| Devnet extended scenarios (flash-trade + stress)                    | 43       |
| Trident fuzz tests (1K iterations)                                  | 16       |
| **Total**                                                           | **2775** |

## Security

- [Vulnerability Disclosure Policy](./SECURITY.md) — how to report, and published audit reports when available
- [Error codes (6000–6117)](./docs/ERROR-CODES.md)

Raw scan output is stored as private CI artifacts (accessible to repo collaborators only).

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
