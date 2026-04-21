# Sigil — Project Specification

## Executive Summary

Sigil is on-chain security infrastructure for AI agents operating on Solana. It sits between an AI agent's signing key and any DeFi protocol, enforcing spending limits, protocol allowlists, per-agent capability controls, and an immutable audit trail — all enforced by the Solana runtime rather than by application-layer software alone. The intended audience is agent developers and AI framework authors (Solana Agent Kit, MCP servers, GOAT, custom orchestrators) who need a tamper-resistant guardrail layer: a policy the agent cannot override, spending caps that survive prompt injection, and a session-level cryptographic receipt for every transaction. Owners configure vaults and policies; agents execute within those bounds. Agents cannot modify policy, withdraw funds, or exceed their approved capability level.

---

## Core Mechanism

Solana imposes a maximum CPI call depth of four levels. Any architecture that wraps DeFi protocol instructions inside a Sigil instruction would hit that limit immediately — a Jupiter swap itself already nests CPIs internally. Sigil therefore uses **instruction composition** instead of CPI wrapping: every protected DeFi transaction is a versioned transaction containing at least three instructions that the Solana runtime executes atomically.

The sandwich pattern is:

```
[ComputeBudgetInstruction, ValidateAndAuthorize, ...defiInstructions, FinalizeSession]
```

`ValidateAndAuthorize` creates a short-lived `SessionAuthority` PDA and checks: vault active, agent registered and unpaused, agent capability level, per-agent and vault-wide spending caps, protocol allowlist, slippage bounds, and generic instruction constraints. The DeFi instructions then execute. `FinalizeSession` revokes the `SessionAuthority`, records the spend in `SpendTracker`, evaluates any post-execution byte-level assertions, and emits a structured audit event. All three instructions succeed or all revert — there is no partial state.

The entry point in the TypeScript SDK is `seal()` in `sdk/kit/src/seal.ts`. It accepts arbitrary `Instruction[]` from any source (Jupiter API, SAK, MCP, hand-crafted), strips any `ComputeBudget` or `SystemProgram` instructions the caller may have included, derives all required Sigil PDAs, fetches the current blockhash, builds the composed transaction, and returns a signed, wire-ready versioned transaction. The `SigilClient` class in `sdk/kit/src/client.ts` wraps `seal()` with instance-level caching of vault state and blockhash.

This design has a deliberate secondary benefit: new DeFi protocol integrations require only SDK changes. The on-chain program never needs to know which protocol is being called — it validates that the instruction targets an address on the vault's protocol allowlist and that the capability and spend constraints are satisfied. No program upgrade is needed to support a new DEX, lending protocol, or perp platform.

---

## Program ID and Network

| Network | Program ID                                     |
| ------- | ---------------------------------------------- |
| Devnet  | `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL` |
| Mainnet | Not yet deployed                               |

The program ID is declared at `programs/sigil/src/lib.rs:16` (`declare_id!`) and registered in `Anchor.toml:9` under `[programs.devnet]`.

---

## Tech Stack

- **Anchor** 0.32.1 (`Anchor.toml:2`, `programs/sigil/Cargo.toml:25`)
- **Rust toolchain** 1.89.0 (`rust-toolchain.toml:2`, components: `rustfmt`, `clippy`)
- **Solana SDK** `solana-program = ">=2"` (`programs/sigil/Cargo.toml:27`)
- **Node.js** >=18.0.0 (`package.json:7`)
- **TypeScript** ^5.9.3 (`package.json` devDependencies)
- **@solana/kit** ^6.2.0 — peer dependency for `@usesigil/kit` (`sdk/kit/package.json:63`)
- **LiteSVM** ^0.6.0 — in-process Solana VM for unit tests, no validator required (`package.json` devDependencies)
- **pnpm** — workspace manager (workspaces declared in `package.json:79-84`); no `packageManager` field pinned in `package.json`

---

## Packages

| Package              | Path                | Version | Purpose                                                                                                                                                                                                    |
| -------------------- | ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@usesigil/kit`      | `sdk/kit/`          | 0.8.1   | Primary TypeScript SDK — ESM-only, zero web3.js dependency, `@solana/kit` native. Exposes `SigilClient`, `seal()`, analytics, dashboard helpers, x402 integration, TEE utilities. (`sdk/kit/package.json`) |
| `@usesigil/platform` | `sdk/platform/`     | 0.1.0   | Platform client for TEE wallet provisioning via Solana Actions/Blinks. (`sdk/platform/package.json`)                                                                                                       |
| `@usesigil/custody`  | `sdk/custody/`      | 0.1.0   | TEE wallet custody adapters — Crossmint, Privy, Turnkey via subpath exports (`./crossmint`, `./privy`, `./turnkey`). (`sdk/custody/package.json`)                                                          |
| `@usesigil/plugins`  | `packages/plugins/` | 7.0.0   | Agent framework adapters — Solana Agent Kit (SAK) plugin via `./sak` subpath export. (`packages/plugins/package.json`)                                                                                     |

---

## Project Layout

```
agent-middleware/
├── programs/sigil/         Anchor program source — 36 instruction handlers, 12 PDA types, 75 errors, 37 events
│   └── src/
│       ├── instructions/   One .rs file per dispatchable instruction
│       ├── state/          One .rs file per on-chain account type
│       ├── errors.rs       All 75 custom SigilError variants (codes 6000-6074)
│       └── events.rs       All 38 Anchor event structs
├── sdk/
│   ├── kit/                @usesigil/kit — primary TypeScript SDK (ESM, @solana/kit)
│   ├── platform/           @usesigil/platform — Blinks-based TEE provisioning client
│   └── custody/            @usesigil/custody — TEE custody adapters (Crossmint, Privy, Turnkey)
├── packages/
│   └── plugins/            @usesigil/plugins — thin agent-framework adapters (SAK)
├── tests/                  On-chain LiteSVM test suite (ts-mocha, no validator needed)
├── target/
│   ├── idl/                Committed Anchor IDL (do not auto-regenerate; restore after every build)
│   └── types/              Committed TypeScript types generated from IDL
├── docs/                   Reference documentation (this file lives here)
├── scripts/                Utility scripts — test-counts.json, update-test-counts.js, verify-test-counts.js
├── trident-tests/          Trident fuzz test suite (cargo-trident, 1K iterations)
├── Anchor.toml             Anchor workspace configuration and program ID registry
├── Cargo.toml              Rust workspace root
├── package.json            pnpm workspace root + test/lint/security scripts
└── rust-toolchain.toml     Pinned Rust toolchain (1.89.0)
```

---

## Build and Test Commands

```bash
# ── Install ──────────────────────────────────────────────────────────────────
pnpm install

# ── Build ────────────────────────────────────────────────────────────────────
# --no-idl is required on stable Rust with Anchor 0.32.1
anchor build --no-idl

# Restore committed IDL — MANDATORY after every build
git checkout -- target/idl/ target/types/

# ── On-chain tests (LiteSVM — no validator, ~45s) ────────────────────────────
# Full suite (all 9 test files)
npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/sigil.ts tests/jupiter-integration.ts tests/jupiter-lend-integration.ts \
  tests/flash-trade-integration.ts tests/security-exploits.ts \
  tests/instruction-constraints.ts tests/escrow-integration.ts \
  tests/toctou-security.ts tests/analytics-counters.ts

# ── SDK tests ────────────────────────────────────────────────────────────────
pnpm -r --filter './sdk/*' --filter './packages/*' test

# ── Rust unit tests ──────────────────────────────────────────────────────────
cargo test --manifest-path programs/sigil/Cargo.toml

# ── Surfpool integration tests (~60s, requires surfpool running) ─────────────
npm run surfpool:start          # Terminal 1: start surfpool (devnet fork, 100ms slots)
npm run test:surfpool           # Terminal 2: npx ts-mocha tests/surfpool-integration.ts

# ── Devnet cluster tests (~5min, real network) ───────────────────────────────
ANCHOR_PROVIDER_URL=<rpc_url> npx ts-mocha -p ./tsconfig.json -t 300000 \
  tests/sigil.ts tests/jupiter-integration.ts tests/flash-trade-integration.ts \
  tests/security-exploits.ts

# ── Lint ─────────────────────────────────────────────────────────────────────
npm run lint          # Prettier check
npm run lint:fix      # Prettier fix
cargo fmt --check --manifest-path programs/sigil/Cargo.toml

# ── Security tooling ─────────────────────────────────────────────────────────
npm run security:xray     # Sec3 X-Ray static analysis (requires Docker)
npm run security:fuzz     # Trident fuzz (1K iterations)
npm run security:verify   # Certora formal verification
```

Scripts are defined in `package.json` and `docs/COMMANDS-REFERENCE.md`.

---

## Documentation Map

All files live in `agent-middleware/docs/`:

| File                              | Description                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT.md`                      | This file — top-level project orientation, tech stack, packages, test statistics                                                          |
| `ARCHITECTURE.md`                 | Account model, seed derivation, instruction flow, composed-transaction anatomy, constants                                                 |
| `INSTRUCTIONS.md`                 | Claude Code guardrails — Solana constraints, Anchor patterns, coding conventions, what never to do                                        |
| `ERROR-CODES.md`                  | Full table of all 75 custom `SigilError` variants (codes 6000-6074) with categories and invocation sites                                  |
| `SECURITY.md`                     | Formal security specification — access control matrix, trust model, invariants, threat model; intended for external auditors              |
| `ONCHAIN-FEATURE-INVENTORY.md`    | Complete on-chain feature inventory — all 36 instructions, 12 account types, capability model, events; source-cited from actual .rs files |
| `COMMANDS-REFERENCE.md`           | Developer command reference — build, test, lint, deploy, security tooling                                                                 |
| `DEPLOYMENT.md`                   | ALT (Address Lookup Table) deployment plan for devnet and mainnet                                                                         |
| `RFC-ACTIONTYPE-ELIMINATION.md`   | Design record for the ActionType → tri-state capability migration; status: IMPLEMENTED                                                    |
| `SECURITY-FINDINGS-2026-04-07.md` | Internal security findings log — Phase 1 audit closure pass; tracks finding status and fix commits                                        |

---

## Build Statistics

Test counts are sourced from `scripts/test-counts.json`. Do not derive these from memory — read the file.

See `scripts/test-counts.json` for the authoritative, machine-updateable counts across all suites (LiteSVM unit, Rust unit, Trident fuzz, Surfpool integration, devnet cluster, Kit SDK, Platform client, Custody adapters, Plugins). Run `node scripts/verify-test-counts.js` to validate that the reported counts match the actual suites. To update: edit `scripts/test-counts.json`, then run `node scripts/update-test-counts.js`.

---

## License

Apache-2.0. Copyright 2024-2026 Kaleb Rupe. See `LICENSE` at the repository root.
