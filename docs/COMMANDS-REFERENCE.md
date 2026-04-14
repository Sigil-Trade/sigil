# Commands Reference

Developer commands for building, testing, and security analysis.

---

## Build

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
cargo fmt --check --manifest-path programs/sigil/Cargo.toml
```

## Testing

| Command | What runs | External deps |
|---|---|---|
| `pnpm test` | 3 LiteSVM files (sigil, jupiter, flash-trade) via `anchor test` | anchor |
| `pnpm test:onchain` | 4 LiteSVM files (above + security-exploits) | ts-mocha |
| `pnpm test:onchain:full` | **All 9** LiteSVM files | ts-mocha |
| `pnpm test:sdk` | All SDK + plugin package tests (kit, custody, platform, plugins) | pnpm workspaces |
| `pnpm test:rust` | `cargo test` on `programs/sigil` | rust toolchain |
| **`pnpm test:all`** | **`test:onchain:full` + `test:sdk` + `test:rust`** — every local-runnable suite | all of the above |
| `pnpm test:surfpool` | 59 Surfpool integration tests | `surfpool start` running (see below) |
| `pnpm count:check` | Drift check: actual test count vs `scripts/test-counts.json` | node |

Devnet and Trident fuzz suites are not included in `pnpm test:all` because they require external setup (devnet RPC + funded keypair, or `cargo trident` and multiple minutes). Run them separately:

```bash
# Devnet (requires ANCHOR_PROVIDER_URL + funded ANCHOR_WALLET)
npx ts-mocha -p ./tsconfig.json -t 300000 tests/devnet-*.ts tests/devnet/*.ts

# Trident fuzz (1K iterations)
pnpm security:fuzz
```

**Use `pnpm test:all` before opening a PR** — `pnpm test` alone runs only ~140 out of ~2,012 tests.

## Surfpool (Integration Testing)

```bash
# Install Surfpool CLI (pre-built binary from S3, NOT crates.io)
curl -sL https://run.surfpool.run/ | bash

# Start local Surfnet (forking devnet, 100ms slots, TUI + Studio)
npm run surfpool:start
# Or directly:
surfpool start --network devnet --slot-time 100

# Start for CI (no TUI, no Studio, no profiling)
npm run surfpool:start:ci
# Or directly:
surfpool start --network devnet --slot-time 100 --ci

# Run Surfpool integration tests (requires Surfnet running)
npm run test:surfpool
# Or directly:
npx ts-mocha -p ./tsconfig.json -t 300000 tests/surfpool-integration.ts
```

The `--network devnet` flag enables lazy forking (USDC/USDT mints cloned on-demand).
Test setup deploys the local `target/deploy/sigil.so` via `solana program deploy`
to override the devnet-forked (possibly stale) program. Test helpers use Surfnet cheatcode
RPC methods (`surfnet_setTokenAccount`, `surfnet_timeTravel`, etc.) via
`connection._rpcRequest()`. See `tests/helpers/surfpool-setup.ts`.

---

## Security Tooling

Three complementary security analysis tools for pre-audit preparation.

| Tool | Type | Speed | CI | What it finds |
|------|------|-------|-----|---------------|
| **Sec3 X-Ray** | Static analysis | ~1 min | Yes | Known vulnerability patterns |
| **Trident** | Fuzz testing | Hours | No | Unknown edge cases via random inputs |
| **Certora** | Formal verification | Minutes-hours | No | Mathematical proofs of correctness |

### Sec3 X-Ray — Static Analysis

Scans Rust source code against 50+ known Solana vulnerability patterns (missing signer checks, unsafe math, PDA seed issues, etc.).

```bash
npm run security:xray
# Or directly:
docker run --rm --volume "$(pwd):/workspace" \
  ghcr.io/sec3-product/x-ray:latest /workspace/programs/sigil
```

- Docker required. Runs automatically on every PR via `security-scan` CI job.
- Focus on **High** or above. False positives are common — review each finding against code.

### Trident — Fuzz Testing

Generates millions of random instruction sequences and verifies 5 invariants:

| ID | Invariant | What it proves |
|----|-----------|----------------|
| INV-1 | Spending cap enforcement | Aggregate 24h spend never exceeds daily cap |
| INV-2 | Access control | Only owner can modify policy / pause / withdraw |
| INV-3 | Session expiry | Session PDA expires within 20 slots |
| INV-4 | Fee immutability | fee_destination never changes after creation |
| INV-5 | Revoke permanence | Frozen vaults can only be reactivated by owner |

```bash
npm run security:fuzz
# Or directly:
cd trident-tests && trident fuzz run fuzz_0

# Prerequisites:
cargo install trident-cli
cargo install honggfuzz
```

Run for at least 1 hour for meaningful coverage. 24h runs before an audit are recommended.

### Certora Solana Prover — Formal Verification

Mathematical proofs that critical properties hold for ALL possible inputs. Three CVLR spec files in `certora/specs/`:

- **spending_caps.rs** (4 rules): Stablecoin-to-USD identity, decimal ordering, overflow detection
- **access_control.rs** (5 rules): Fee cap, session expiry, rolling window, vector bounds, epoch buffer
- **session_lifecycle.rs** (7 rules): Expiry bounds, validity, determinism, uniqueness, safety

```bash
npm run security:verify
# Or directly:
source .certora-venv/bin/activate
certoraSolanaProver certora/conf/sigil.conf

# Prerequisites:
python3 -m venv .certora-venv
source .certora-venv/bin/activate
pip install certora-cli
cargo +1.81 install cargo-certora-sbf
# Register for free API key at certora.com, add CERTORAKEY to .env
```

---

## Pre-Audit Checklist

Run this sequence before freezing the codebase for an external audit:

### 1. Code quality
- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy` passes (with allowed Anchor lints)
- [ ] `pnpm lint` passes
- [ ] All tests pass (see `scripts/test-counts.json` for current counts)

### 2. Static analysis
- [ ] `npm run security:xray` — zero High/Critical findings (or all triaged as false positives)

### 3. Fuzz testing
- [ ] `npm run security:fuzz` — 24h run with zero crashes
- [ ] All 5 invariants verified across millions of random sequences

### 4. Formal verification
- [ ] `npm run security:verify` — all 16 specs verified

### 5. Freeze
- [ ] Create tagged release: `git tag -a v1.0.0-audit -m "Frozen for security audit"`
- [ ] Record commit hash: `git rev-parse HEAD`
- [ ] Push tag: `git push origin v1.0.0-audit`
- [ ] **No further commits** until audit is complete

### 6. Deliverables for auditor
- [ ] Frozen commit hash
- [ ] X-Ray report (with triage notes)
- [ ] Trident fuzzing duration and crash summary
- [ ] Certora verification results
- [ ] `docs/SECURITY.md` (formal security specification)

### 7. Remediation (Post-Audit)
1. Apply fixes in a single "remediation" commit
2. Tag: `git tag -a v1.0.0-audit-fix -m "Audit remediation"`
3. Auditor reviews only the remediation diff

---

## Environment Setup

```bash
# Required toolchain
anchor-cli 0.32.1
solana-cli (matching version)
node >= 18
pnpm 10

# Certora (formal verification only)
python -m venv .certora-venv && source .certora-venv/bin/activate
pip install certora-cli
export CERTORAKEY=<your-api-key>   # Free registration at certora.com

# Trident (fuzz testing only)
cargo install trident-cli
```
