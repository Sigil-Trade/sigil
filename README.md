<div align="center">

<img src=".github/sigil-icon.svg" alt="Sigil" width="80" />

# Sigil

**On-chain guardrails for AI agents on Solana.**

Your policies are enforced by Solana validators, not software promises.

[![CI](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sigil-Trade/sigil/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-2111-brightgreen)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

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

| Account                      | Seeds                                              | Purpose                                                                 |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| **AgentVault**               | `[b"vault", owner, vault_id]`                      | Multi-agent vault: up to 10 agents with per-agent permission bitmasks   |
| **PolicyConfig**             | `[b"policy", vault]`                               | Spending caps, protocol allowlist, leverage/slippage limits, timelock   |
| **SpendTracker**             | `[b"tracker", vault]`                              | Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking  |
| **SessionAuthority**         | `[b"session", vault, agent, token_mint]`           | Ephemeral PDA created per action, expires after 20 slots                |
| **PendingPolicyUpdate**      | `[b"pending_policy", vault]`                       | Queued policy change with timelock, applied after delay                 |
| **EscrowDeposit**            | `[b"escrow", source_vault, dest_vault, escrow_id]` | Cross-vault stablecoin escrow with optional SHA-256 condition proof     |
| **InstructionConstraints**   | `[b"constraints", vault]`                          | Up to 16 per-program instruction constraints with 7 operators           |
| **PendingConstraintsUpdate** | `[b"pending_constraints", vault]`                  | Queued constraint changes with timelock                                 |
| **AgentSpendOverlay**        | `[b"agent_spend", vault, shard_index]`             | Per-agent rolling 24h spend tracking (10 agent slots)                   |

### On-Chain Instructions (26)

| Instruction                       | Signer | Description                                                 |
| --------------------------------- | ------ | ----------------------------------------------------------- |
| `initialize_vault`                | Owner  | Create vault, policy, tracker, and overlay PDAs             |
| `deposit_funds`                   | Owner  | Transfer SPL tokens into vault                              |
| `register_agent`                  | Owner  | Register agent with permission bitmask and spending limit   |
| `update_policy`                   | Owner  | Modify policy (direct if no timelock)                       |
| `update_agent_permissions`        | Owner  | Update agent permissions and spending limit                 |
| `validate_and_authorize`          | Agent  | Check policy, collect fees, create session, delegate tokens |
| `finalize_session`                | Agent  | Revoke delegation, close session PDA                        |
| `revoke_agent`                    | Owner  | Kill switch — freeze vault                                  |
| `reactivate_vault`                | Owner  | Unfreeze vault, optionally rotate agent key                 |
| `withdraw_funds`                  | Owner  | Withdraw tokens to owner                                    |
| `close_vault`                     | Owner  | Close all PDAs, reclaim rent                                |
| `queue_policy_update`             | Owner  | Queue timelocked policy change                              |
| `apply_pending_policy`            | Owner  | Apply queued change after timelock expires                  |
| `cancel_pending_policy`           | Owner  | Cancel queued policy change                                 |
| `agent_transfer`                  | Agent  | Transfer stablecoins to allowlisted destination             |
| `sync_positions`                  | Owner  | Correct open position counter if out of sync                |
| `create_escrow`                   | Agent  | Create cross-vault stablecoin escrow                        |
| `settle_escrow`                   | Agent  | Settle escrow to destination vault                          |
| `refund_escrow`                   | Agent  | Refund expired escrow to source vault                       |
| `close_settled_escrow`            | Owner  | Close settled/refunded escrow PDA, reclaim rent             |
| `create_instruction_constraints`  | Owner  | Create per-program instruction constraints                  |
| `close_instruction_constraints`   | Owner  | Close instruction constraints PDA                           |
| `update_instruction_constraints`  | Owner  | Update constraints (direct if no timelock)                  |
| `queue_constraints_update`        | Owner  | Queue timelocked constraint change                          |
| `apply_constraints_update`        | Owner  | Apply queued constraint change after timelock               |
| `cancel_constraints_update`       | Owner  | Cancel queued constraint change                             |

## Packages

| Package                                                         | Description                                                          | npm                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`@usesigil/kit`](./sdk/kit)                                      | Full SDK — policy engine, `seal()` API, TEE custody, analytics       | [![npm](https://img.shields.io/npm/v/@usesigil/kit)](https://www.npmjs.com/package/@usesigil/kit)                                         |
| [`@usesigil/platform`](./sdk/platform)                            | Platform client — request TEE wallet provisioning via Solana Actions | [![npm](https://img.shields.io/npm/v/@usesigil/platform)](https://www.npmjs.com/package/@usesigil/platform)                               |
| [`@usesigil/custody`](./sdk/custody)                              | TEE wallet custody adapters — Crossmint, Privy, Turnkey             | [![npm](https://img.shields.io/npm/v/@usesigil/custody)](https://www.npmjs.com/package/@usesigil/custody)                                 |
| [`@usesigil/plugins`](./packages/plugins)                         | Agent framework adapters — Solana Agent Kit                          | [![npm](https://img.shields.io/npm/v/@usesigil/plugins)](https://www.npmjs.com/package/@usesigil/plugins)                                 |

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

# Run on-chain tests (532 LiteSVM tests — no validator needed)
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

| Suite                                                | Tests   |
| ---------------------------------------------------- | ------- |
| Core vault management & permission engine            |     107 |
| Jupiter integration (composed swaps)                 |       8 |
| Jupiter Lend integration (deposit/withdraw)          |       6 |
| Flash Trade integration (leveraged perps)            |      26 |
| Security exploit scenarios                           |     163 |
| Instruction constraints (generic enforcement)        |      55 |
| Escrow integration (deposit/settle/refund)           |      15 |
| TOCTOU security (policy version + timelock)          |       7 |
| Analytics counters (failed TX + per-agent TX count)  |       8 |
| Devnet integration tests (real network)              |      69 |
| Surfpool integration tests (local Surfnet)           |      59 |
| Platform client tests (`@usesigil/platform`)         |      17 |
| Custody adapters (`@usesigil/custody`)               |      96 |
| Kit-native SDK (`@usesigil/kit` — includes merged core + dashboard) |    1253 |
| Kit SDK devnet tests (`@usesigil/kit` devnet)        |      34 |
| Plugins (`@usesigil/plugins`)                        |       6 |
| Rust unit tests (cargo test)                         |     121 |
| Devnet extended scenarios (flash-trade + stress)     |      45 |
| Trident fuzz tests (1K iterations)                   |      16 |
| **Total**                                            | **2111** |

## Security

- [Vulnerability Disclosure Policy](./SECURITY.md)
- [Security Tools & Scanning](./docs/SECURITY-TOOLS.md)
- [Published Audit Reports](./docs/audits/)

Raw scan output is stored as private CI artifacts (accessible to repo collaborators only). Published audit reports are added to `docs/audits/` after auditor release.

## License

This project is licensed under the [Apache License 2.0](./LICENSE).
