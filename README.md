<div align="center">

<img src=".github/sigil-icon.svg" alt="Sigil" width="80" />

# Sigil

**On-chain guardrails for AI agents on Solana.**

Your policies are enforced by Solana validators, not software promises.

[![CI](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-2267-brightgreen)
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
- **Token delegation** — SPL `approve`/`revoke` CPI instead of escrow transfers
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

| Account                      | Seeds                                              | Purpose                                                                |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| **AgentVault**               | `[b"vault", owner, vault_id]`                      | Multi-agent vault: up to 10 agents with per-agent permission bitmasks  |
| **PolicyConfig**             | `[b"policy", vault]`                               | Spending caps, protocol allowlist, leverage/slippage limits, timelock  |
| **SpendTracker**             | `[b"tracker", vault]`                              | Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking |
| **SessionAuthority**         | `[b"session", vault, agent, token_mint]`           | Ephemeral PDA created per action, expires after 20 slots               |
| **PendingPolicyUpdate**      | `[b"pending_policy", vault]`                       | Queued policy change with timelock, applied after delay                |
| **EscrowDeposit**            | `[b"escrow", source_vault, dest_vault, escrow_id]` | Cross-vault stablecoin escrow with optional SHA-256 condition proof    |
| **InstructionConstraints**   | `[b"constraints", vault]`                          | Up to 16 per-program instruction constraints with 7 operators          |
| **PendingConstraintsUpdate** | `[b"pending_constraints", vault]`                  | Queued constraint changes with timelock                                |
| **AgentSpendOverlay**        | `[b"agent_spend", vault, shard_index]`             | Per-agent rolling 24h spend tracking (10 agent slots)                  |

### On-Chain Instructions (35)

> Policy-level mutations are timelock-guarded (minimum 1800s). The "direct"
> `update_policy`, `update_agent_permissions`, `update_instruction_constraints`,
> and `close_instruction_constraints` handlers were removed — all such changes
> now go through queue/apply/cancel flows for TOCTOU protection.

| Instruction                             | Signer      | Description                                                               |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| **Vault Lifecycle**                     |             |                                                                           |
| `initialize_vault`                      | Owner       | Create vault, policy, tracker, overlay PDAs (mandatory timelock)          |
| `freeze_vault`                          | Owner       | Protective freeze — blocks agent execution, preserves agents              |
| `reactivate_vault` (resume)             | Owner       | Unfreeze vault, optionally add new agent                                  |
| `close_vault`                           | Owner       | Close all PDAs, reclaim rent. Requires zero open positions.               |
| `sync_positions`                        | Owner       | Correct open position counter drift                                       |
| **Fund Management**                     |             |                                                                           |
| `deposit_funds`                         | Owner       | Transfer SPL tokens into vault (SPL Token only, no Token-2022)            |
| `withdraw_funds`                        | Owner       | Withdraw tokens to owner                                                  |
| **Agent Execution**                     |             |                                                                           |
| `validate_and_authorize`                | Agent       | Check policy + constraints, collect fees, create session, delegate tokens |
| `finalize_session`                      | Agent       | Outcome-based spend measurement, revoke delegation, close session PDA     |
| `agent_transfer`                        | Agent       | Stablecoin transfer to allowlisted destination (bypasses DeFi sandwich)   |
| **Agent Management**                    |             |                                                                           |
| `register_agent` (addAgent)             | Owner       | Register agent with capability tier + spending limit (max 10 agents)      |
| `revoke_agent`                          | Owner       | Remove agent from vault                                                   |
| `pause_agent`                           | Owner       | Temporarily block agent without revoking                                  |
| `unpause_agent`                         | Owner       | Restore paused agent                                                      |
| `queue_agent_permissions_update`        | Owner       | Queue timelocked capability/limit change for agent                        |
| `apply_agent_permissions_update`        | Owner       | Apply queued agent permission change after timelock                       |
| `cancel_agent_permissions_update`       | Owner       | Cancel queued agent permission change                                     |
| **Policy**                              |             |                                                                           |
| `queue_policy_update`                   | Owner       | Queue timelocked policy change (min 1800s)                                |
| `apply_pending_policy`                  | Owner       | Apply queued change after timelock expires                                |
| `cancel_pending_policy`                 | Owner       | Cancel queued policy change                                               |
| **Escrow**                              |             |                                                                           |
| `create_escrow`                         | Agent       | Cross-vault stablecoin escrow (max 30 days)                               |
| `settle_escrow`                         | Agent       | Settle escrow to destination vault                                        |
| `refund_escrow`                         | Owner/Agent | Refund expired escrow to source vault                                     |
| `close_settled_escrow`                  | Owner       | Close settled/refunded escrow PDA, reclaim rent                           |
| **Instruction Constraints**             |             |                                                                           |
| `allocate_constraints_pda`              | Owner       | Allocate InstructionConstraints PDA (35,888 bytes)                        |
| `allocate_pending_constraints_pda`      | Owner       | Allocate PendingConstraintsUpdate PDA                                     |
| `extend_pda`                            | Owner       | Extend PDA in multiple transactions (large-account bootstrap)             |
| `create_instruction_constraints`        | Owner       | Populate constraints after allocation                                     |
| `queue_constraints_update`              | Owner       | Queue timelocked constraint change                                        |
| `apply_constraints_update`              | Owner       | Apply queued constraint change after timelock                             |
| `cancel_constraints_update`             | Owner       | Cancel queued constraint change                                           |
| `queue_close_constraints`               | Owner       | Queue timelocked constraint deletion                                      |
| `apply_close_constraints`               | Owner       | Apply close after timelock, close PDA                                     |
| `cancel_close_constraints`              | Owner       | Cancel queued close                                                       |
| **Post-Execution Assertions (Phase B)** |             |                                                                           |
| `create_post_assertions`                | Owner       | Create PostExecutionAssertions PDA (leverage, balance delta checks)       |
| `close_post_assertions`                 | Owner       | Remove post-execution assertions                                          |

## Packages

| Package                                   | Description                                                          | npm                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@usesigil/kit`](./sdk/kit)              | Full SDK — policy engine, `seal()` API, TEE custody, analytics       | [![npm](https://img.shields.io/npm/v/@usesigil/kit)](https://www.npmjs.com/package/@usesigil/kit)           |
| [`@usesigil/platform`](./sdk/platform)    | Platform client — request TEE wallet provisioning via Solana Actions | [![npm](https://img.shields.io/npm/v/@usesigil/platform)](https://www.npmjs.com/package/@usesigil/platform) |
| [`@usesigil/custody`](./sdk/custody)      | TEE wallet custody adapters — Crossmint, Privy, Turnkey              | [![npm](https://img.shields.io/npm/v/@usesigil/custody)](https://www.npmjs.com/package/@usesigil/custody)   |
| [`@usesigil/plugins`](./packages/plugins) | Agent framework adapters — Solana Agent Kit                          | [![npm](https://img.shields.io/npm/v/@usesigil/plugins)](https://www.npmjs.com/package/@usesigil/plugins)   |

## Quick Start

### Option A — Add to an Existing Project

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
| Devnet  | [`4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`](https://explorer.solana.com/address/4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL?cluster=devnet) |

## Development

```bash
# Build the Anchor program (--no-idl required on stable Rust with Anchor 0.32.1)
anchor build --no-idl

# Generate IDL separately (requires nightly Rust — anchor-syn 0.32.1 bug)
RUSTUP_TOOLCHAIN=nightly anchor idl build -o target/idl/sigil.json

# Run on-chain tests (526 LiteSVM tests — no validator needed)
npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/sigil.ts tests/jupiter-integration.ts \
  tests/flash-trade-integration.ts tests/security-exploits.ts \
  tests/instruction-constraints.ts tests/escrow-integration.ts

# Run all SDK tests (1,218 tests across 4 packages)
pnpm -r run test

# Lint
npm run lint
cargo fmt --check --manifest-path programs/sigil/Cargo.toml
```

### Test Suites

| Suite                                                               | Tests    |
| ------------------------------------------------------------------- | -------- |
| Core vault management & permission engine                           | 107      |
| Jupiter integration (composed swaps)                                | 8        |
| Jupiter Lend integration (deposit/withdraw)                         | 6        |
| Flash Trade integration (leveraged perps)                           | 26       |
| Security exploit scenarios                                          | 158      |
| Instruction constraints (generic enforcement)                       | 55       |
| Escrow integration (deposit/settle/refund)                          | 15       |
| TOCTOU security (policy version + timelock)                         | 7        |
| Analytics counters (failed TX + per-agent TX count)                 | 7        |
| Devnet integration tests (real network)                             | 69       |
| Surfpool integration tests (local Surfnet)                          | 59       |
| Platform client tests (`@usesigil/platform`)                        | 17       |
| Custody adapters (`@usesigil/custody`)                              | 96       |
| Kit-native SDK (`@usesigil/kit` — includes merged core + dashboard) | 1415     |
| Kit SDK devnet tests (`@usesigil/kit` devnet)                       | 34       |
| Plugins (`@usesigil/plugins`)                                       | 6        |
| Rust unit tests (cargo test)                                        | 121      |
| Devnet extended scenarios (flash-trade + stress)                    | 45       |
| Trident fuzz tests (1K iterations)                                  | 16       |
| **Total**                                                           | **2267** |

## Security

- [Vulnerability Disclosure Policy](./SECURITY.md)
- [Security Findings Log](./docs/SECURITY-FINDINGS-2026-04-07.md) — Phase 1.5 findings + closures
- [Published audit reports](./SECURITY.md) — disclosure policy + public reports (when available)

Raw scan output is stored as private CI artifacts (accessible to repo collaborators only). Published audit reports are added to `docs/audits/` after auditor release.

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
