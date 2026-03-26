# On-Chain Implementation Plan

**Version**: 1.6.0 (six-pass audited)
**Date**: 2026-03-26
**Status**: IMPLEMENTED — All steps complete except ALT migration (deferred to MAINNET_DEPLOYMENT_CHECKLIST.md). Six audit passes (Appendix D-I), 42 findings resolved.
**Branch**: `feat/wrap-architecture`
**Author**: Architect Agent (Serena Blackwood persona)
**Audit**: v1.6 incorporates 11 security-implications findings from sixth-pass audit (2026-03-26). Prior audits checked correctness of claims — this audit checked what IMPLEMENTING the steps would introduce. Key additions: Step 10.2/10.3 code sketches, verification failure runbook, CI job separation, ALT TOCTOU mitigation, freeze precondition gate, cross-plan dependency note. Total across all audits: 42 findings resolved.

---

## Executive Summary

Six persona tests (Security Auditor "Rook", Perps Developer "Jake", Treasury Manager "David", DeFi SDK Developer, Protocol Integrator, AI Agent Developer) evaluated the Phalnx on-chain program across 10 dimensions. Two findings were already fixed during the session (unbounded scan loops, saturating_add standardization), plus one stale documentation gap added during re-audit. Three findings require implementation (P0 security). Five findings are by-design decisions that need formal documentation in the codebase, not code changes.

This plan covers every finding with exact file paths, Rust code sketches, risk analysis, and per-step acceptance criteria.

---

## Status Key

- [ ] Not started
- [x] Complete
- [~] In progress

---

## Table of Contents

1. [Already Implemented (Session Fixes)](#1-already-implemented)
2. [P0-A: ALT Authority Migration to Squads V4 Multisig](#2-p0-a-alt-authority-migration)
3. [P0-B: Program Bytecode Verification Tooling](#3-p0-b-program-bytecode-verification)
4. [P0-C: Upgrade Authority Documentation](#4-p0-c-upgrade-authority-documentation)
5. [By-Design Decision D1: Self-Declared Leverage](#5-d1-self-declared-leverage)
6. [By-Design Decision D2: Counter-Only Position Tracking](#6-d2-counter-only-position-tracking)
7. [By-Design Decision D3: No On-Chain Viewer/Delegate Role](#7-d3-no-viewer-delegate-role)
8. [By-Design Decision D4: No On-Chain Multi-Sig Awareness](#8-d4-no-on-chain-multisig-awareness)
9. [By-Design Decision D5: No Per-Agent P&L On-Chain](#9-d5-no-per-agent-pnl-on-chain)
10. [P1-A: Extract Shared Instruction Scan Helper](#10-p1-a-extract-shared-instruction-scan-helper-audit-fix-plan-f-8)
11. [Implementation Order and Dependencies](#11-implementation-order-and-dependencies)
12. [Testing Strategy](#12-testing-strategy)
13. [Appendix A: Affected Files Summary](#appendix-a-affected-files-summary)
14. [Appendix B: Constants Reference](#appendix-b-constants-reference)
15. [Appendix C: Error Code Budget](#appendix-c-error-code-budget)
16. [Appendix D: Verification Audit (v1.1)](#appendix-d-verification-audit)
17. [Appendix E: Independent Re-Audit (v1.2)](#appendix-e-independent-re-audit)
18. [Appendix F: Second-Pass Re-Audit (v1.3)](#appendix-f-second-pass-re-audit)
19. [Appendix G: Compile-Correctness Audit (v1.4)](#appendix-g-compile-correctness-audit)
20. [Appendix H: Comprehensive Fifth-Pass Audit (v1.5)](#appendix-h-comprehensive-fifth-pass-audit)
21. [Appendix I: Security-Implications Audit (v1.6)](#appendix-i-security-implications-audit)

---

## 1. Already Implemented

These were fixed during the current session. Documented here for completeness and audit traceability.

### 1a. Unbounded Instruction Scan Loops

- **WHAT**: Replaced fixed `for i in 0..20` scan caps with `while let Ok(ix) = load_instruction_at_checked(...)` loop that terminates naturally at finalize_session (break) or end of transaction (Err return from sysvar read).
- **WHERE**:
  - `programs/phalnx/src/instructions/finalize_session.rs` (line ~491, post-finalize scan)
  - `programs/phalnx/src/instructions/validate_and_authorize.rs` (line ~265, spending scan; line ~366, non-spending scan)
- **WHY**: Rook (Security Auditor) flagged that a fixed 20-instruction cap creates a coverage gap. If Solana increases transaction instruction limits (SIMD-0296 proposes 4,096 bytes), an attacker could place unauthorized instructions beyond position 20. The unbounded scan closes this gap permanently.
- **HOW**: All three scan sites now use the pattern:
  ```rust
  let mut scan_idx = current_idx_usize.saturating_add(1);
  while let Ok(ix) = load_instruction_at_checked(scan_idx, &ix_sysvar) {
      // ... check logic ...
      scan_idx = scan_idx.saturating_add(1);
  }
  ```
- **RISK**: None. The loop is naturally bounded by transaction size (currently ~1232 bytes, ~35 instructions maximum). Compute cost is proportional to actual instruction count, not a hardcoded cap.
- **STATUS**: COMPLETE. Verified via build + existing tests.

### 1b. Saturating Add Standardization in Scan Loops

- **WHAT**: Changed all scan index increments from raw `+1` to `.saturating_add(1)` to comply with the checked-math-only rule (CLAUDE.md constraint 3).
- **WHERE**: Same three files as 1a. Nine total `.saturating_add(1)` calls: v&a.rs lines 265, 301, 336, 344, 368, 401, 424; finalize.rs lines 491, 497.
- **WHY**: While `usize` overflow on a scan index is practically impossible (would require 2^64 instructions), the project mandates zero tolerance for unchecked arithmetic. Consistency prevents future audit findings.
- **HOW**: `scan_idx = scan_idx.saturating_add(1);` in all loop bodies and initializers.
- **RISK**: None. `saturating_add` on usize at values < 100 is a no-op versus `checked_add`.
- **STATUS**: COMPLETE.

### 1c. Update docs/ARCHITECTURE.md Scan Descriptions (RE-AUDIT ADDITION)

- **WHAT**: Update the `validate_and_authorize` flow documentation to reflect the unbounded scan pattern and correct line numbers.
- **WHERE**: `docs/ARCHITECTURE.md`, lines 47-48
- **WHY**: The documentation still says "scans up to 20 instructions forward" and references old line numbers (273-377 for spending, 379-415 for non-spending). After Step 1a changed the scans to unbounded `while let Ok(...)` patterns, the docs are stale and misleading.
- **HOW**: Replace:
  - `"scans up to 20 instructions forward"` → `"scans all instructions between validate and finalize (unbounded)"`
  - `"(lines 273-377)"` → `"(lines 261-357)"`
  - `"(lines 379-415)"` → `"(lines 366-428)"`
- **RISK**: None. Documentation-only fix.
- **STATUS**: COMPLETE (WIP 1/7).

**Acceptance criteria**: `docs/ARCHITECTURE.md` no longer mentions "20 instructions" or the old line number ranges. ✅ Verified.

---

## 2. P0-A: ALT Authority Migration to Squads V4 Multisig

> **DEFERRED TO MAINNET** — Moved to [MAINNET_DEPLOYMENT_CHECKLIST.md](./MAINNET_DEPLOYMENT_CHECKLIST.md#11-alt-authority-migration-to-squads-v4).
>
> Requires 3 distinct keypair holders (2-of-3 Squads V4 multisig). Steps 2.0-2.4 preserved
> in full in the mainnet checklist (Section 11) with all code sketches, risk analysis, and acceptance criteria.
> Not a devnet blocker — current single-EOA ALT authority is acceptable for development.

---

## 3. P0-B: Program Bytecode Verification Tooling

### Context

There is currently no automated way to verify that the deployed on-chain program matches the source code in this repository. Anyone can deploy arbitrary bytecode to the program address if they hold the upgrade authority.

### Finding Source

Rook (Security Auditor) stated: "CRITICALLY INSUFFICIENT -- ZERO capability to verify deployed binary matches source." This is standard for any production Solana program.

### Implementation

- [x] **Step 3.1**: Add `solana-verify` integration script

  **WHAT**: Create a script that uses `solana-verify` (Ellipsis Labs' toolchain) to verify the deployed program matches a deterministic build from source.

  **WHERE**: New file `scripts/verify-program.ts`

  **WHY**: Enables anyone (auditors, users, integrators) to independently verify program integrity. This is the Solana ecosystem standard (used by Jupiter, Marinade, etc.).

  **HOW**:
  ```typescript
  #!/usr/bin/env npx tsx
  /**
   * Verify deployed Phalnx program matches source code.
   *
   * Uses solana-verify CLI for deterministic build comparison.
   *
   * Prerequisites:
   * - cargo install solana-verify
   * - Docker (for deterministic builds)
   *
   * Usage: npx tsx scripts/verify-program.ts [--cluster devnet|mainnet]
   */

  import { spawnSync } from "node:child_process";

  const PROGRAM_ID = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";
  const cluster = process.argv.includes("--mainnet") ? "mainnet" : "devnet";

  // Step 1: Check solana-verify is installed
  //   spawnSync("solana-verify", ["--version"])
  // Step 2: Run deterministic build
  //   spawnSync("solana-verify", ["build", "--library-name", "phalnx"])
  // Step 3: Get on-chain program hash
  //   spawnSync("solana-verify", ["get-program-hash", PROGRAM_ID, "--cluster", cluster])
  // Step 4: Compare hashes
  //   spawnSync("solana-verify", ["verify-from-repo",
  //     "--program-id", PROGRAM_ID,
  //     "--library-name", "phalnx",
  //     "--mount-path", "programs/phalnx",
  //     "--cluster", cluster])
  // Step 5: Also display upgrade authority
  //   spawnSync("solana", ["program", "show", PROGRAM_ID, "--url", rpcUrl])
  // Step 6: Output result (match/mismatch)
  ```

  **RISK**: Low. This is a read-only verification tool. The deterministic build requires Docker but does not modify any source files.

  **Acceptance criteria**: `npx tsx scripts/verify-program.ts --cluster devnet` outputs MATCH or a clear mismatch message with both hashes.

  **Verification Failure Runbook** (what to do when result is MISMATCH):
  1. **Check Rust toolchain**: `rustc --version` must match CI's version (currently 1.89.0). Different toolchains produce different binaries.
  2. **Check Anchor version**: `anchor --version` must match CI (currently 0.32.1).
  3. **Check feature flags**: Build must use `--features devnet` (or `--features mainnet` for mainnet). Missing/wrong feature flag = different binary.
  4. **Check Docker image**: `solana-verify` uses a Docker container for deterministic builds. If the Docker image has been updated, the binary hash changes. Pin the Docker image version.
  5. **If still MISMATCH after above checks**: The deployed binary does NOT match source code. This is a **security incident**:
     - Immediately halt all SDK operations against the affected cluster
     - Roll back to the last verified program binary (if deployment history is available)
     - Investigate: check `solana program show` for recent authority changes, check CI logs for unauthorized deploys
     - File incident report with upgrade authority holders

- [x] **Step 3.2**: Add CI verification step to deployment workflow

  **WHAT**: Add a GitHub Actions workflow step that runs `solana-verify` after every program deployment.

  **WHERE**: `.github/workflows/deploy-devnet.yml` (add step after `solana program deploy` at line ~133). NOT `release.yml` — that workflow is for npm package publishing via Changesets, not program deployment.

  **WHY**: Automated verification catches any build environment drift or supply chain issues. Must run in the workflow that actually deploys the program binary.

  **HOW**: Add as a SEPARATE job (not within the deploy job) in `deploy-devnet.yml` — avoids competing with the 20-minute deploy timeout:
  ```yaml
  verify-program:
    needs: deploy  # Only runs after successful deployment
    runs-on: ubuntu-latest
    timeout-minutes: 15  # Separate budget from deploy job
    steps:
      - uses: actions/checkout@v4
      - name: Install solana-verify
        run: cargo install solana-verify --version '>=0.2.0'  # Pin minimum version
      - name: Verify deployed program matches source
        run: |
          set -e  # CRITICAL: fail workflow on mismatch (exit code 1)
          solana-verify verify-from-repo \
            --program-id 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL \
        --library-name phalnx \
        --mount-path programs/phalnx \
        --cluster devnet
  ```

  **RISK**: Low. CI-only, does not affect deployment pipeline. May increase CI time by 3-5 minutes for deterministic build.

  **Acceptance criteria**: After a devnet deploy, the verify step runs and outputs MATCH.

- [x] **Step 3.3**: Document verification in SECURITY.md

  **WHAT**: Add a "Program Verification" section explaining how to verify the deployed bytecode.

  **WHERE**: `SECURITY.md`

  **WHY**: External parties need to know how to verify. This is the standard disclosure for production Solana programs.

  **HOW**: Add section:
  ```markdown
  ## Program Verification

  The deployed Phalnx program can be verified against this source repository:

  ### Prerequisites
  - `cargo install solana-verify`
  - Docker installed and running

  ### Verify
  solana-verify verify-from-repo \
    --program-id 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL \
    --library-name phalnx \
    --mount-path programs/phalnx \
    --cluster <devnet|mainnet>
  ```

  **RISK**: None. Documentation only.

  **Acceptance criteria**: SECURITY.md contains a "Program Verification" section with prerequisites and verification commands.

### Testing for Step 3

- Run `scripts/verify-program.ts --cluster devnet` against current devnet deployment
- Verify output shows MATCH or provides clear error message
- CI workflow dry-run

---

## 4. P0-C: Upgrade Authority Documentation

### Context

The on-chain program has an upgrade authority that can modify the deployed bytecode at any time. The SDK does not inspect whether this authority is a single key, a multisig, or renounced. There is no documentation of the upgrade authority governance plan.

### Finding Source

Rook (Security Auditor) noted: "SDK does not inspect whether the program's upgrade authority is a multisig, single key, or renounced."

### Implementation

- [x] **Step 4.1**: Document upgrade authority governance

  **WHAT**: Create formal documentation of who holds the upgrade authority, the governance plan, and the path to renouncing.

  **WHERE**: New section in `docs/DEPLOYMENT.md` and `SECURITY.md`

  **WHY**: Users, auditors, and integrators need to understand the trust model. A single-key upgrade authority means one person can arbitrarily change program behavior.

  **HOW**: Add to `SECURITY.md`:
  ```markdown
  ## Program Upgrade Authority

  ### Current State (Devnet)
  - **Authority**: Single keypair (deployer)
  - **Governance**: No multisig requirement
  - **Rationale**: Devnet is for development; rapid iteration requires direct deploy

  ### Mainnet Plan (Pre-Launch Requirements)
  1. **Phase 1 (Launch)**: Upgrade authority transferred to Squads V4 multisig (2-of-3)
     - Members: [to be determined -- must be distinct individuals with hardware wallets]
     - All upgrades require 2 of 3 signatures
  2. **Phase 2 (Post-Audit)**: After security audit and 90-day stability period:
     - Option A: Transfer to higher-threshold multisig (3-of-5)
     - Option B: Renounce upgrade authority (program becomes immutable)
  3. **Verification**: Anyone can check the current upgrade authority:
     solana program show 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL

  ### SDK Verification (Optional)
  The SDK does NOT enforce upgrade authority checks because:
  - On devnet, authority changes frequently during development
  - On mainnet, the authority is verifiable by anyone via RPC
  - Baking authority checks into SDK would couple it to a specific governance model
  - Program verification (see above) is a stronger guarantee than authority checks
  ```

  **RISK**: None. Documentation only. The actual authority migration to multisig is an operational step performed at mainnet launch time.

  **Acceptance criteria**: SECURITY.md contains "Program Upgrade Authority" section with Current State, Mainnet Plan, and SDK Verification subsections. `docs/DEPLOYMENT.md` cross-links to SECURITY.md governance section.

- [x] **Step 4.2**: Add upgrade authority check to verify script

  **WHAT**: Extend `scripts/verify-program.ts` (from Step 3.1) to also display the current upgrade authority and warn if it is a single key.

  **WHERE**: `scripts/verify-program.ts`

  **WHY**: Makes the trust model visible during verification.

  **HOW**:
  ```typescript
  // After bytecode verification, also check upgrade authority:
  // spawnSync("solana", ["program", "show", PROGRAM_ID, "--url", rpcUrl, "--output", "json"])
  // Parse JSON output to extract authority field
  // If authority !== "none", print warning:
  //   "WARNING: Program is upgradeable. Authority: <address>"
  //   "Verify this is a multisig before trusting on mainnet."
  ```

  **RISK**: None. Read-only check.

  **Acceptance criteria**: `npx tsx scripts/verify-program.ts --cluster devnet` displays upgrade authority address and warns if it's a single key.

### Testing for Step 4

- Review documentation for completeness
- Run verify script, confirm upgrade authority is displayed
- Manual check: `solana program show 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL --url devnet`

---

## 5. By-Design Decision D1: Self-Declared Leverage

### Finding

Jake (Perps Developer) asked how leverage is verified. The SDK passes `leverage_bps` as an argument to `validate_and_authorize`, and the program checks it against `policy.max_leverage_bps`. But the program does not read Flash Trade position state to verify the actual leverage.

### Justification

This is correct by design and must NOT be changed. The reasoning:

1. **Phalnx is a guardrail, not a position oracle.** Reading Flash Trade position state would require either CPI (consuming CPI depth budget) or remaining_accounts parsing (coupling to Flash Trade's account layout).

2. **CPI depth constraint (max 4).** If `validate_and_authorize` made a CPI to read Flash Trade state, the remaining CPI depth for the actual DeFi instruction would be reduced. The instruction composition pattern (`validate -> DeFi -> finalize`) keeps all three at depth 1.

3. **Protocol-agnostic architecture.** Phalnx supports Jupiter, Flash Trade, Jupiter Lend, Jupiter Earn, Jupiter Borrow, and any future protocol via generic constraints. Adding Flash Trade-specific position reading would break this principle.

4. **The policy limit caps over-declaration.** If the owner sets `max_leverage_bps = 30000` (300x), agents cannot declare leverage above that. However, `leverage_bps` is `Option<u16>` — passing `None` skips the check entirely, and under-declaring (e.g., declaring 1x when opening a 50x position) causes the check to pass. **This means `max_leverage_bps` is advisory, not a hard enforcement.** The real controls are `max_transaction_size_usd` and `max_concurrent_positions`, which bound actual capital outflow. See Appendix E security assessment for full analysis.

5. **The outcome-based spending check in `finalize_session` catches the economic impact.** Even if an agent opens a position with undeclared leverage, the stablecoin balance delta reveals the actual capital commitment, and spending caps enforce limits. The leverage check is defense-in-depth, not the primary control.

### Where to Document

- [x] **Step 5.1**: Add design decision comment in `validate_and_authorize.rs`

  **WHERE**: `programs/phalnx/src/instructions/validate_and_authorize.rs`, around line 430-436 (leverage check)

  **WHAT**: Add a doc comment block explaining this is self-declared and why:
  ```rust
  // 7. Leverage check (for perp actions) -- ALL actions
  // DESIGN DECISION: leverage_bps is self-declared by the agent (via SDK).
  // The program checks it against policy.max_leverage_bps but does NOT
  // read actual position state from Flash Trade or other protocols.
  //
  // Rationale:
  // - Protocol-agnostic: no coupling to Flash Trade account layout
  // - CPI depth: reading position state consumes CPI budget
  // - Outcome-based: finalize_session measures actual stablecoin delta
  // - Advisory only: agent can under-declare or pass None to skip this check.
  //   Spending caps (finalize_session) are the real enforcement, not leverage_bps.
  //
  // Found by: Persona test (Perps Developer "Jake")
  // Decision: By design. Not a bug.
  if let Some(lev) = leverage_bps {
      require!(
          policy.is_leverage_within_limit(lev),
          PhalnxError::LeverageTooHigh
      );
  }
  ```

  **RISK**: None. Comment-only change. Does not require build or test.

---

## 6. By-Design Decision D2: Counter-Only Position Tracking

### Finding

Jake (Perps Developer) asked about margin tracking and liquidation monitoring. The vault tracks `open_positions: u8` as a counter only. It does not store individual position details (entry price, size, liquidation price, PnL).

### Justification

This is correct by design:

1. **Position details are protocol-specific.** Flash Trade positions have different data layouts than Drift positions, which differ from Jupiter perps. Storing position details on-chain would require per-protocol account schemas.

2. **Protocol-agnostic principle.** The on-chain program handles 21 action types across 5+ protocols. Specializing position tracking for one protocol violates the architectural principle that on-chain = guardrails, SDK = protocol intelligence.

3. **Account size constraints.** Position details (entry price, size, direction, liquidation price per position) would add ~50 bytes per position. With `max_concurrent_positions` up to 255, this could exceed the 10,240-byte CPI account creation limit.

4. **`sync_positions` handles counter drift.** When a position is auto-liquidated by the protocol (not through Phalnx), the counter drifts. The `sync_positions` instruction allows the owner to correct this. Individual position tracking would not prevent this drift -- it would make it worse (stale entries).

5. **The SDK resolves position details via RPC.** `state-resolver.ts` and protocol-specific compose modules read actual position state from the chain when needed. This is the right layer for protocol-specific data.

### Where to Document

- [x] **Step 6.1**: Add design decision comment in `vault.rs`

  **WHERE**: `programs/phalnx/src/state/vault.rs`, at the `open_positions` field (line ~44)

  **WHAT**:
  ```rust
  /// Number of currently open positions (for perps tracking).
  /// DESIGN DECISION: Counter-only. Does not store per-position details
  /// (entry price, size, liquidation price). Individual position data is
  /// protocol-specific (Flash Trade vs Drift vs Jupiter perps have different
  /// layouts). The SDK reads position details via RPC. sync_positions
  /// corrects counter drift from auto-liquidation.
  /// Found by: Persona test (Perps Developer "Jake")
  pub open_positions: u8,
  ```

  **RISK**: None. Comment-only.

---

## 7. By-Design Decision D3: No On-Chain Viewer/Delegate Role

### Finding

David (Treasury Manager) wanted a read-only "viewer" role for compliance officers and a "delegate" role for trade desk operators. Currently the program only has two roles: owner (full authority) and agent (execute-only within policy bounds).

### Justification

This is correct by design:

1. **On-chain data is publicly readable.** Every Solana account can be read by anyone via RPC (`getAccountInfo`). There is no concept of "private" on-chain data. A "viewer" role would control nothing -- the data is already public.

2. **Access control is a dashboard-layer concern.** The dashboard (`@agent-shield/dashboard`) should implement role-based access control for its UI. An API key with "viewer" scope cannot modify anything but can read vault state. This is standard fintech architecture (Mercury, Altitude do the same).

3. **Account size bloat.** Adding a `viewers: Vec<ViewerEntry>` field to AgentVault would increase the account size by ~42 bytes per viewer (pubkey + role byte + 1 padding). For 10 viewers, that is 420 bytes of on-chain storage that provides zero on-chain security benefit.

4. **No on-chain enforcement of "read-only".** Solana's runtime does not have read-vs-write account access at the application level. A viewer role would be purely informational -- the program would store it but never check it during instruction execution.

### Where to Document

- [x] **Step 7.1**: Add ADR (Architecture Decision Record) comment in `vault.rs`

  **WHERE**: `programs/phalnx/src/state/vault.rs`, after the `AgentVault` struct definition (after line ~67)

  **WHAT**: Add comment block:
  ```rust
  // ARCHITECTURE DECISION: No on-chain viewer/delegate role
  //
  // The program has two roles: owner (full authority) and agent (execute within policy).
  // There is no "viewer" or "delegate" role because:
  //   1. All Solana account data is publicly readable via RPC.
  //   2. Read-only access control is a dashboard/API concern, not on-chain.
  //   3. Adding viewer entries would bloat account size with zero security benefit.
  //   4. Delegate roles are handled by Squads V4 externally if the owner is a multisig.
  //
  // Found by: Persona test (Treasury Manager "David")
  // Decision: By design. Dashboard RBAC handles this.
  ```

  **RISK**: None. Comment-only.

---

## 8. By-Design Decision D4: No On-Chain Multi-Sig Awareness

### Finding

David (Treasury Manager) wanted 2-of-3 approval for policy changes. The program checks `owner.key == vault.owner` as a single signer check. It has no built-in multi-sig verification.

### Justification

This is correct by design:

1. **Composability with Squads V4.** If `vault.owner` is set to a Squads V4 multisig PDA, then Squads enforces the threshold signing before the transaction reaches the Phalnx program. From Phalnx's perspective, the "owner" signed -- it does not need to know how.

2. **No coupling to a specific multi-sig implementation.** If Phalnx implemented its own multi-sig (or checked for Squads-specific state), it would be coupled to one multi-sig program. Users who prefer Realms, or a future multi-sig standard, would be excluded.

3. **Separation of concerns.** Multi-sig is an authentication concern. Phalnx is an authorization concern. The Solana runtime's signature verification ensures the `Signer<'info>` constraint is met. How that signature was produced (single key, 2-of-3, MPC) is not Phalnx's responsibility.

4. **Timelock already provides governance safety.** PolicyConfig has `timelock_duration` (configurable, enforced on-chain). Combined with Squads multisig on the owner key, this provides two layers of governance: threshold signing + time delay.

### Where to Document

- [x] **Step 8.1**: Add design decision in `docs/ARCHITECTURE.md`

  **CROSS-PLAN DEPENDENCY**: SDK-IMPLEMENTATION-PLAN Step 22 also modifies `docs/ARCHITECTURE.md` (adds Trust Boundaries, Two-Tier Verification, and Jupiter Verifier sections — ~90 lines). Implement this step BEFORE or AFTER SDK Step 22, not in parallel, to avoid merge conflicts. Or coordinate: this step adds a "Multi-Sig Governance" section, SDK Step 22 adds separate sections — as long as they append to different locations, both can proceed.

  **WHERE**: `docs/ARCHITECTURE.md` (add section on governance model)

  **WHAT**: Add section explaining how Squads V4 composes with Phalnx:
  ```markdown
  ### Multi-Sig Governance

  Phalnx does not implement on-chain multi-sig. Instead, it composes
  with external multi-sig programs (recommended: Squads V4).

  **How it works:**
  1. Set `vault.owner` to a Squads V4 multisig PDA
  2. All owner actions (policy changes, agent management, withdrawals)
     require threshold signing through Squads before reaching Phalnx
  3. Phalnx checks `owner.key == vault.owner` -- the Solana runtime
     guarantees this signature is valid

  **Combined with timelock:**
  - Policy changes require timelock_duration to elapse
  - Squads threshold signing adds a second governance layer
  - Result: no single person can change policy without both threshold
    approval AND waiting the timelock period
  ```

  **RISK**: None. Documentation only.

---

## 9. By-Design Decision D5: No Per-Agent P&L On-Chain

### Finding

David (Treasury Manager) wanted to compare bot profitability by looking at per-agent P&L on-chain. The program tracks `lifetime_spend` and `lifetime_tx_count` per agent in AgentSpendOverlay, and `total_deposited_usd` / `total_withdrawn_usd` at the vault level. But it does not track per-agent profit/loss.

### Justification

This is correct by design. Per-agent P&L requires capabilities that conflict with the architecture:

1. **Oracles removed by design.** P&L for non-stablecoin positions requires mark-to-market pricing. Mark-to-market requires oracles (Pyth, Switchboard). Oracles were deliberately removed (~1,500 lines of Rust deleted) as part of the stablecoin-only architecture decision. Reintroducing oracles for P&L tracking would undermine a foundational decision.

2. **Protocol-specific position reading.** To compute P&L for an agent's Flash Trade position, you need to read Flash Trade's position account (entry price, current mark, funding rate accrued). This is different for Drift, Jupiter perps, etc. Protocol-agnostic P&L is a contradiction.

3. **Realized vs unrealized P&L.** On-chain counters can only track realized P&L (when a position is closed and stablecoin flows back). Unrealized P&L requires reading live position state + oracle prices. The vault already tracks realized flows via `total_deposited_usd`, `total_withdrawn_usd`, and `total_volume`.

4. **Per-agent attribution is ambiguous.** If Agent A opens a position and Agent B closes it (both authorized), who gets the P&L? On-chain, there is no concept of "Agent A's position" -- the vault owns the position.

5. **SDK is the right layer.** `state-resolver.ts` already provides `getSpendingHistory()` (144-epoch time series), and `agent-analytics.ts` provides per-agent profiles including spend breakdown. The dashboard can compute P&L by correlating agent activity with token balance changes.

### Where to Document

- [x] **Step 9.1**: Add design decision comment in `agent_spend_overlay.rs`

  **WHERE**: `programs/phalnx/src/state/agent_spend_overlay.rs`, above `lifetime_spend` field (line ~64)

  **WHAT**:
  ```rust
  /// Per-agent cumulative spend in USD base units. Index matches entries[i].
  /// DESIGN DECISION: Tracks spend only, NOT profit/loss.
  /// Per-agent P&L requires oracles (removed by design) and protocol-specific
  /// position reading (violates protocol-agnostic principle). Realized P&L
  /// can be derived in the SDK by correlating agent spend events with vault
  /// balance changes. See agent-analytics.ts for the SDK implementation.
  /// Found by: Persona test (Treasury Manager "David")
  pub lifetime_spend: [u64; MAX_OVERLAY_ENTRIES], // 80 bytes
  ```

  **RISK**: None. Comment-only.

---

## 10. P1-A: Extract Shared Instruction Scan Helper (AUDIT-FIX-PLAN F-8)

> **Source:** Cross-correlation audit (2026-03-25), finding F-8.
> **Risk:** HIGH — most security-critical on-chain code. Own PR required.

### Finding

The spending and non-spending instruction scan paths in `validate_and_authorize.rs` duplicate ~60 lines of identical logic:
- SPL Token Transfer/TransferChecked/Approve blocking (disc 3, 4, 12)
- Token-2022 Transfer/TransferChecked/Approve/TransferCheckedWithFee blocking (disc 3, 4, 12, 26)
- Infrastructure whitelist (ComputeBudget, SystemProgram)
- Protocol allowlist check (`policy.is_protocol_allowed()`)
- Generic constraints verification (`verify_against_entries()` + `strict_mode`)

### Implementation

- [x] **10.0.** Add required import for `Instruction` type to file header:

  **WHAT**: Add `use anchor_lang::solana_program::instruction::Instruction;` to the imports at line 2.

  **WHY**: The existing scan loops use `ix` implicitly typed by `load_instruction_at_checked`'s return type (`solana_program::instruction::Instruction`). The variable never needs a named type annotation. But the new `scan_instruction()` helper function has `ix: &Instruction` in its parameter list, which requires the type to be in scope. Without this import, the code won't compile.

  **WHERE**: `programs/phalnx/src/instructions/validate_and_authorize.rs`, line 2 — change:
  ```rust
  use anchor_lang::solana_program::instruction::get_stack_height;
  ```
  to:
  ```rust
  use anchor_lang::solana_program::instruction::{get_stack_height, Instruction};
  ```

  **RISK**: None. Import-only change.

  **Acceptance criteria**: `anchor build --no-idl` compiles with the new import.

- [x] **10.1.** Extract shared scan logic into a private helper function in `validate_and_authorize.rs` (same file, not a new module — keeps security-critical logic co-located with its callers). Alternative: `instructions/utils.rs` already has `stablecoin_to_usd()` and is imported via `use super::utils::*`. Either location works; same-file is preferred for security reviewability:

```rust
/// Return type for scan_instruction helper. Not pub — internal to this module.
enum ScanAction {
    FoundFinalize,
    Infrastructure,
    PassedSharedChecks,
}

// NOTE: Instruction import added in Step 10.0 above.

fn scan_instruction(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    spl_token_id: &Pubkey,
    compute_budget_id: &Pubkey,
    finalize_hash: &[u8; 8],
    policy: &PolicyConfig,
    loaded_constraints: &Option<InstructionConstraints>,
) -> anchor_lang::Result<ScanAction> {  // anchor_lang::Result, not std::Result
    // Stop at finalize_session
    if ix.program_id == crate::ID && ix.data.len() >= 8 && ix.data[..8] == *finalize_hash {
        return Ok(ScanAction::FoundFinalize);
    }

    // Block SPL Token Transfer/TransferChecked/Approve
    if ix.program_id == *spl_token_id && !ix.data.is_empty() {
        if ix.data[0] == 4 { return Err(error!(PhalnxError::UnauthorizedTokenApproval)); }
        if ix.data[0] == 3 || ix.data[0] == 12 { return Err(error!(PhalnxError::UnauthorizedTokenTransfer)); }
    }

    // Block Token-2022 Transfer/Approve/TransferChecked/TransferCheckedWithFee
    if ix.program_id == TOKEN_2022_PROGRAM_ID && !ix.data.is_empty() {
        if ix.data[0] == 4 { return Err(error!(PhalnxError::UnauthorizedTokenApproval)); }
        if ix.data[0] == 3 || ix.data[0] == 12 || ix.data[0] == 26 { return Err(error!(PhalnxError::UnauthorizedTokenTransfer)); }
    }

    // Whitelist infrastructure programs
    // NOTE: Must use fully-qualified path — the actual code at lines 299, 399 uses
    // anchor_lang::solana_program::system_program::ID, not bare system_program::ID
    if ix.program_id == *compute_budget_id
        || ix.program_id == anchor_lang::solana_program::system_program::ID
    {
        return Ok(ScanAction::Infrastructure);
    }

    // Protocol allowlist
    require!(policy.is_protocol_allowed(&ix.program_id), PhalnxError::ProtocolNotAllowed);

    // Generic constraints
    if let Some(ref constraints) = loaded_constraints {
        let matched = generic_constraints::verify_against_entries(
            &constraints.entries, &ix.program_id, &ix.data, &ix.accounts,
        )?;
        if !matched && constraints.strict_mode {
            return Err(error!(PhalnxError::UnconstrainedProgramBlocked));
        }
    }

    Ok(ScanAction::PassedSharedChecks)
}
```

- [x] **10.2.** Refactor spending scan (lines ~261-357) to use `scan_instruction()`:

  **WHAT**: Replace the inline shared checks in the spending scan with calls to `scan_instruction()`. The spending-only checks (recognized DeFi detection, ProtocolMismatch, defi_ix_count, Jupiter slippage) MUST remain inline after `PassedSharedChecks`.

  **WHY**: The spending path has 4 checks that the non-spending path does NOT have. Accidentally moving these into the shared helper or dropping them during refactoring would create a security regression (allowing multi-DeFi-instruction attacks, protocol mismatch bypasses, or unchecked slippage).

  **HOW**:
  ```rust
  // SPENDING SCAN — after refactoring
  if is_spending {
      let mut defi_ix_count: u8 = 0;
      let mut found_finalize = false;
      let mut scan_idx = current_idx_usize.saturating_add(1);

      while let Ok(ix) = load_instruction_at_checked(scan_idx, &ix_sysvar) {
          match scan_instruction(&ix, &spl_token_id, &compute_budget_id,
              &finalize_hash, &policy, &loaded_constraints)?
          {
              ScanAction::FoundFinalize => {
                  found_finalize = true;
                  break;
              }
              ScanAction::Infrastructure => {
                  // CRITICAL: must `continue` — preserves original line 301 behavior.
                  // Infrastructure programs skip protocol allowlist + constraints checks.
                  scan_idx = scan_idx.saturating_add(1);
                  continue;
              }
              ScanAction::PassedSharedChecks => {
                  // === SPENDING-ONLY CHECKS (NOT in helper — must remain inline) ===

                  // 4. Recognized DeFi: protocol mismatch + slippage verification
                  let is_recognized_defi = ix.program_id == JUPITER_PROGRAM
                      || ix.program_id == FLASH_TRADE_PROGRAM
                      || ix.program_id == JUPITER_LEND_PROGRAM
                      || ix.program_id == JUPITER_EARN_PROGRAM
                      || ix.program_id == JUPITER_BORROW_PROGRAM;

                  if is_recognized_defi {
                      require!(
                          ix.program_id == target_protocol,
                          PhalnxError::ProtocolMismatch
                      );
                      defi_ix_count = defi_ix_count.saturating_add(1);
                  }

                  // Slippage verification on Jupiter V6 swaps
                  if ix.program_id == JUPITER_PROGRAM {
                      jupiter::verify_jupiter_slippage(&ix.data, policy.max_slippage_bps)?;
                  }
              }
          }
          scan_idx = scan_idx.saturating_add(1);
      }

      // 5. DeFi instruction count enforcement
      if is_stablecoin_input {
          require!(defi_ix_count <= 1, PhalnxError::TooManyDeFiInstructions);
      } else {
          require!(defi_ix_count == 1, PhalnxError::TooManyDeFiInstructions);
      }
      require!(found_finalize, PhalnxError::MissingFinalizeInstruction);
  }
  ```

- [x] **10.3.** Refactor non-spending scan (lines ~366-428) to use `scan_instruction()`:

  **WHAT**: Replace the inline shared checks in the non-spending scan with calls to `scan_instruction()`. Non-spending path has NO additional inline checks — it only uses the shared checks.

  **HOW**:
  ```rust
  // NON-SPENDING SCAN — after refactoring
  if !is_spending {
      let mut found_finalize = false;
      let mut idx = current_idx_usize.saturating_add(1);

      while let Ok(ix) = load_instruction_at_checked(idx, &ix_sysvar) {
          match scan_instruction(&ix, &spl_token_id, &compute_budget_id,
              &finalize_hash, &policy, &loaded_constraints)?
          {
              ScanAction::FoundFinalize => {
                  found_finalize = true;
                  break;
              }
              ScanAction::Infrastructure => {
                  // CRITICAL: must `continue` — preserves original line 401 behavior.
                  idx = idx.saturating_add(1);
                  continue;
              }
              ScanAction::PassedSharedChecks => {
                  // Non-spending has no additional checks beyond the shared ones.
              }
          }
          idx = idx.saturating_add(1);
      }

      require!(found_finalize, PhalnxError::MissingFinalizeInstruction);
  }
  ```

- [x] **10.4.** Build and test: `anchor build --no-idl` → `git checkout -- target/idl/ target/types/` → run ALL tests (361 LiteSVM + 20 Surfpool).

**Acceptance criteria for Step 10**: `anchor build --no-idl` succeeds. 361 LiteSVM tests pass. 20 Surfpool tests pass. `git diff` shows only refactored scan logic — no behavioral changes. Line count reduced from ~160 lines to ~90 lines (±20%). All 4 spending-only checks (recognized DeFi, ProtocolMismatch, defi_ix_count, Jupiter slippage) present ONLY in the spending path.

### Scope

**Net:** ~170 lines → ~90 lines. Pure refactor, no behavior change.

### Risk Mitigation

- **Own PR** — not combined with any other changes
- **Full test suite** — 361 LiteSVM + 20 Surfpool must pass with zero failures
- **Line-by-line diff review** — mandatory before merge
- **No new error codes** — reuses existing PhalnxError variants
- **No behavior change** — the helper extracts existing logic, does not add or remove checks
- **Rollback**: If any test fails or post-merge issues surface: `git revert <merge-commit>`, rebuild (`anchor build --no-idl`), redeploy to devnet, re-run full test suite to confirm revert is clean

### Estimated Effort

2-3 hours including build + full test run.

---

## 11. Implementation Order and Dependencies

> **Version note:** Step 10 (scan refactor) added 2026-03-25 from AUDIT-FIX-PLAN F-8. Renumbered sections 11+ accordingly.

```
Step 1c (ARCHITECTURE.md Fix) ──> can start immediately, no deps
  1c Update stale scan descriptions in docs/ARCHITECTURE.md

Step 2 (ALT Migration) ──> DEFERRED TO MAINNET (see MAINNET_DEPLOYMENT_CHECKLIST.md)

Step 3 (Verify Tooling) ──> can start immediately, no code deps
  3.1 verify-program.ts
  3.2 CI workflow step
  3.3 SECURITY.md section

Step 4 (Upgrade Auth Docs) ──> depends on 3.1 (extends verify script)
  4.1 Documentation
  4.2 Extend verify script

Steps 5-9 (By-Design Docs) ──> all independent, can be done in parallel
  5.1 Leverage comment (v&a.rs:430-436 — OUTSIDE scan region, no conflict with Step 10)
  6.1 Position tracking comment (vault.rs:44)
  7.1 Viewer role comment (vault.rs:67)
  8.1 ARCHITECTURE.md governance section
  9.1 Overlay P&L comment (agent_spend_overlay.rs:64)

Step 10 (Scan Refactor) ──> independent, own PR, HIGH RISK
  10.0 Add Instruction import to v&a.rs (prerequisite for 10.1)
  10.1 Extract scan_instruction helper
  10.2 Refactor spending scan (v&a.rs:261-357)
  10.3 Refactor non-spending scan (v&a.rs:366-428)
  10.4 Build + full test suite (361 LiteSVM + 20 Surfpool)
```

**Ordering Note (re-audit verified):** Step 5.1 adds a comment at v&a.rs:430-436 (leverage check), which is AFTER the scan region (lines 261-428) that Step 10 refactors. There is no conflict — Steps 5-9 and Step 10 can be executed in any order.

### Recommended Execution Order

| Phase | Steps | Estimated Effort | Blocker |
|-------|-------|-----------------|---------|
| 0 | 1c | 15 min | None (docs-only, no build needed) |
| 1 | 5.1, 6.1, 7.1, 9.1 | 30 min | None (comment-only, no build needed) |
| 2 | 8.1 | 30 min | None (docs-only) |
| 3 | 3.1, 3.3 | 2 hours | Docker for deterministic builds |
| 4 | 4.1, 4.2 | 1 hour | Depends on 3.1 |
| 5 | 3.2 | 1 hour | CI access |
| 6 | 10.0-10.4 | 2-3 hours | Own PR, full test suite, line-by-line review |
| — | 2.0-2.4 (ALT migration) | DEFERRED | See MAINNET_DEPLOYMENT_CHECKLIST.md |

### WIP Commit Strategy (per CLAUDE.md rule 14)

Each completed phase gets its own WIP commit:
```
[WIP 1/7] docs(architecture): fix stale scan descriptions in ARCHITECTURE.md           ✅ DONE
[WIP 2/7] docs(on-chain): add by-design decision comments for 5 persona findings       ✅ DONE
[WIP 3/7] docs(security): add governance section to ARCHITECTURE.md                    ✅ DONE
[WIP 4/7] feat(scripts): add program bytecode verification tooling                     ✅ DONE
[WIP 5/7] docs(security): document upgrade authority governance plan                    ✅ DONE
[WIP 6/7] ci: add solana-verify step to deploy-devnet workflow                         ✅ DONE
[WIP 7/7] refactor(on-chain): extract shared instruction scan helper (F-8)
ALT migration (Steps 2.0-2.4) → MAINNET_DEPLOYMENT_CHECKLIST.md
```

---

## 12. Testing Strategy

### On-Chain Program Changes

Step 10 (scan helper refactor) is the ONLY step that modifies Rust code in `programs/phalnx/src/`. All other remaining items are scripts, documentation, or CI configuration.

**Step 10 requires the full build-IDL-test cycle:**
```bash
anchor build --no-idl
git checkout -- target/idl/ target/types/
npx ts-mocha -p ./tsconfig.json -t 300000 tests/phalnx.ts  # 361+ LiteSVM tests
# Surfpool tests (20) run separately in CI
```

Steps 1c, 2-9 do NOT require the build-IDL-test cycle (scripts, docs, CI only).

### Verification Tests

| Step | Test Method |
|------|------------|
| 1c | Verify ARCHITECTURE.md no longer mentions "20 instructions" or old line numbers |
| 2.1 | Manual: verify Squads vault exists on devnet |
| 2.2 | `pnpm --filter @phalnx/kit test:devnet` against new ALT |
| 2.3 | Manual: run updated extend script, verify proposal creation |
| 3.1 | Run `npx tsx scripts/verify-program.ts --cluster devnet` |
| 3.2 | CI dry-run (workflow_dispatch) |
| 4.2 | Run verify script, confirm authority output |
| 5-9 | Code review only (comments) |
| 10.0-10.4 | `anchor build --no-idl` + IDL restore + 361 LiteSVM + 20 Surfpool (ALL must pass) |

### Regression Prevention

The existing test suite (361 LiteSVM + 20 Surfpool + 69 devnet) provides comprehensive coverage of all on-chain behavior. Step 10 is a pure refactor with HIGH risk — the full test suite is the regression gate. Steps 2-9 have zero regression risk (no Rust code changes).

---

## Appendix A: Affected Files Summary

| File | Change Type | Steps |
|------|------------|-------|
| `programs/phalnx/src/instructions/validate_and_authorize.rs` | Import + Comment + Refactor | 5.1, 10.0-10.3 |
| `programs/phalnx/src/instructions/finalize_session.rs` | Already done | 1a, 1b |
| `programs/phalnx/src/state/vault.rs` | Comment | 6.1, 7.1 |
| `programs/phalnx/src/state/agent_spend_overlay.rs` | Comment | 9.1 |
| `docs/ARCHITECTURE.md` | Documentation (line numbers + scan description) | 1c, 8.1 |
| `docs/DEPLOYMENT.md` | Documentation | 4.1 |
| `SECURITY.md` | Documentation | 3.3, 4.1 |
| `scripts/verify-program.ts` | New file | 3.1, 4.2 |
| ~~`scripts/create-alt-multisig.ts`~~ | ~~New file~~ | ~~2.1~~ DEFERRED |
| ~~`scripts/migrate-alt-authority.ts`~~ | ~~New file~~ | ~~2.2~~ DEFERRED |
| ~~`scripts/freeze-alt.ts`~~ | ~~New file~~ | ~~2.4~~ DEFERRED |
| ~~`scripts/extend-phalnx-alt.ts`~~ | ~~Modification~~ | ~~2.3~~ DEFERRED |
| `.github/workflows/deploy-devnet.yml` | CI step (verify after deploy) | 3.2 |
| ~~`package.json` (root)~~ | ~~DevDependency~~ | ~~2.0~~ DEFERRED |

## Appendix B: Constants Reference

These constants are NON-NEGOTIABLE and must not be changed by any step in this plan.

| Constant | Value | Source File | Significance |
|----------|-------|-------------|-------------|
| `MAX_AGENTS_PER_VAULT` | 10 | `state/mod.rs:22` | Bounds AgentVault.agents and AgentSpendOverlay.entries |
| `FULL_PERMISSIONS` | `(1u64 << 21) - 1` | `state/mod.rs:25` | 21-bit bitmask for 21 ActionType variants |
| `SESSION_EXPIRY_SLOTS` | 20 | `state/mod.rs:34` | ~8 seconds, Certora-verified |
| `EPOCH_DURATION` | 600 | `state/tracker.rs:6` | 10 min, Certora-verified: 144 x 600 = 86,400 |
| `NUM_EPOCHS` | 144 | `state/tracker.rs:9` | NON-NEGOTIABLE financial granularity |
| `OVERLAY_EPOCH_DURATION` | 3600 | `state/agent_spend_overlay.rs:8` | 1h per agent bucket |
| `OVERLAY_NUM_EPOCHS` | 24 | `state/agent_spend_overlay.rs:11` | 24 x 1h = 24h window |
| `MAX_DEVELOPER_FEE_RATE` | 500 | `state/mod.rs:43` | 5 BPS cap, Certora-verified |
| `PROTOCOL_FEE_RATE` | 200 | `state/mod.rs:40` | 2 BPS, hardcoded |
| `FEE_RATE_DENOMINATOR` | 1,000,000 | `state/mod.rs:37` | Fee calculation base |
| `MAX_ESCROW_DURATION` | 2,592,000 | `state/mod.rs:50` | 30 days in seconds |
| `MAX_SLIPPAGE_BPS` | 5000 | `state/mod.rs:47` | 50% absolute maximum |

## Appendix C: Error Code Budget

Current error codes: 6000-6070 (71 codes). This plan adds ZERO new error codes. All enforcement already exists; the plan addresses documentation, tooling, and operational security.

---

## Appendix D: Verification Audit (v1.1, 2026-03-25)

> Every factual claim in this plan was verified against actual source code. 15/15 claims checked, 14 confirmed, 1 fixed.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | while-let scan pattern at 3 sites | CONFIRMED | v&a.rs:268, v&a.rs:370, finalize.rs:492 |
| 2 | All scan increments use .saturating_add(1) | CONFIRMED | 9 total: v&a.rs:265, 301, 336, 344, 368, 401, 424; finalize.rs:491, 497 |
| 3 | Squads warning at extend-phalnx-alt.ts:162 | CONFIRMED | Exact text match at lines 161-162 |
| 4 | ALT authority address in alt-config.ts | CONFIRMED | Line 25 comment matches |
| 5 | Leverage check at v&a.rs:430-436 | CONFIRMED | Exact line match |
| 6 | open_positions at vault.rs:43-44 | CONFIRMED | Line 44 match |
| 7 | sync_positions instruction exists | CONFIRMED | File exists at instructions/sync_positions.rs |
| 8 | No viewer/delegate fields in AgentVault | CONFIRMED | Only owner + agents fields |
| 9 | lifetime_spend at agent_spend_overlay.rs:65 | CONFIRMED | Line 65 match |
| 10 | total_deposited/withdrawn_usd in vault.rs | CONFIRMED | Lines 56, 60 |
| 11 | Spending scan 261-357, non-spending 366-428 | CONFIRMED | Exact ranges verified |
| 12 | ~60 lines duplicated between scans | CONFIRMED | ~55 lines of shared checks per path |
| 13 | All 12 constants in Appendix B | CONFIRMED | 8 in state/mod.rs, 2 in tracker.rs, 2 in agent_spend_overlay.rs |
| 14 | 71 error codes (6000-6070) | CONFIRMED | 71 `#[msg]` annotations in errors.rs |
| 15 | TOC numbering | FIXED | Added missing sections 12, Appendix A-D |

### v1.1 Corrections Applied

| Issue | Before | After |
|-------|--------|-------|
| Non-spending scan line ref | ~379 | ~366 (actual start of `if !is_spending` block) |
| TOC missing entries | Sections 1-11 only | Added sections 12, Appendix A-D |
| Duplicate section 11 | "Implementation Order" and "Testing Strategy" both numbered 11 | Renumbered to 11 and 12 |
| WIP commit count | 6 | 8 (added Step 10 refactor + Step 2.4 freeze) |

---

## Appendix E: Independent Re-Audit (v1.2, 2026-03-25)

> Independent verification of v1.1 plan by Algorithm agent. 12 findings across 4 severities.

### Findings

| # | Severity | Category | Finding | Fix Applied |
|---|----------|----------|---------|-------------|
| RA-1 | CRITICAL | Factual | Squads V4 import uses `@sqds/sdk` (V3 deprecated). Correct package: `@sqds/multisig` | Step 2.1 HOW rewritten |
| RA-2 | CRITICAL | Missing Step | `docs/ARCHITECTURE.md:47-48` still says "scans up to 20 instructions forward" with old line numbers after Step 1a changes | Added Step 1c |
| RA-3 | HIGH | Misleading | Step 2.2 title says "Transfer ALT authority" but Solana ALTs have no SetAuthority. The HOW correctly describes creating a new ALT | Title and WHAT rewritten |
| RA-4 | HIGH | Factual | Appendix B says "from state/mod.rs" but 4 constants are in different files: EPOCH_DURATION/NUM_EPOCHS in tracker.rs, OVERLAY_* in agent_spend_overlay.rs | Added Source File column |
| RA-5 | MEDIUM | Count | Appendix D header says "14/14" but table has 15 rows | Fixed to 15/15 |
| RA-6 | MEDIUM | Evidence | Appendix D claim #2 lists 5 saturating_add lines but there are 9 total (missed init lines 265, 368, 491 and defi_ix_count at 336) | Updated evidence |
| RA-7 | MEDIUM | Risk Gap | Step 2.4 freeze risk doesn't mention inability to add future protocol addresses | Risk section expanded |
| RA-8 | MEDIUM | Format | No per-step acceptance criteria (SDK plan has them). Implementors lack clear success signal | Added acceptance criteria |
| RA-9 | LOW | Format | No Status Key section (SDK plan has one) | Added Status Key |
| RA-10 | LOW | Stale | Appendix D claim #13 says "12/12 match state/mod.rs" but only 8/12 are in mod.rs | Corrected in Appendix D |
| RA-11 | LOW | Format | Constants table missing Source File column, misdirects implementor to wrong file | Added Source File column |
| RA-12 | LOW | Format | Version header says "14/14 factual claims verified" but should be 15/15 | Fixed in header |

### By-Design Decisions Security Assessment (Independent Pentester Review)

| Decision | Verdict | Fund Theft? | Rationale |
|----------|---------|-------------|-----------|
| D1: Self-Declared Leverage | SOUND WITH CAVEAT | NO | `leverage_bps` is `Option<u16>` — passing `None` skips the check entirely. Agent can declare false leverage. But spending caps bound actual capital outflow, so this is a risk-exposure violation only. `max_transaction_size_usd` + `max_concurrent_positions` are the real controls. Recommend documenting `max_leverage_bps` as advisory, not hard enforcement. |
| D2: Counter-Only Positions | SOUND WITH CAVEAT | NO | Counter drift from external liquidation creates agent DoS until owner syncs. `sync_positions` has no upper-bound validation (`actual_positions` can be 0-255). No agent-exploitable vector exists. Recommend off-chain monitoring for counter drift. |
| D3: No Viewer Role | SOUND | N/A | All Solana accounts publicly readable via RPC. Zero on-chain operations require viewer restriction. Adding roles adds attack surface for zero benefit. |
| D4: No Multisig Awareness | SOUND | NO | PDA signing makes bypass impossible — only the Squads program can produce a signature from its vault PDA. Works with any multisig using standard PDA-as-signer pattern (Squads V4, Realms, custom). Vault owner is immutable after creation (security strength, operational constraint). |
| D5: No Per-Agent P&L | SOUND WITH CAVEAT | NO | Non-stablecoin-to-stablecoin swaps record inflow as "spend" in cap tracking (conservative over-counting). Agent that profitably round-trips SOL could exhaust daily cap despite positive net impact. This is safe by default — prevents cap-washing. `ClosePosition`/`CloseAndSwapPosition` correctly avoid cap consumption (non-spending). |

---

## Appendix F: Second-Pass Re-Audit (v1.3, 2026-03-26)

> Second independent verification after another agent declared v1.2 "10/10 checks pass. Ready to implement." Found 8 additional issues that both the v1.1 audit and the 10/10 review missed.

### Findings

| # | Severity | Category | Finding | Fix Applied |
|---|----------|----------|---------|-------------|
| RB-1 | CRITICAL | Wrong Target | Step 3.2 adds verify step to `release.yml` with `if: steps.deploy.outcome == 'success'`. But `release.yml` is an npm Changesets publish workflow — it never deploys programs. No `deploy` step ID exists. Program deployment is in `deploy-devnet.yml:133`. | Step 3.2 WHERE/HOW rewritten to target `deploy-devnet.yml` |
| RB-2 | HIGH | Missing Step | Step 2.1 imports `@sqds/multisig` but no step installs it. `@sqds/multisig` is not in any `package.json`. Scripts would fail with module not found. | Added Step 2.0 (install devDependency) |
| RB-3 | HIGH | Internal Inconsistency | D1 justification point 4 says "lying about leverage would only restrict their own actions" but Appendix E's security assessment says "passing `None` skips the check entirely" and under-declaring passes the check. The body contradicts the appendix. | D1 point 4 rewritten to align with Appendix E |
| RB-4 | MEDIUM | Missing | Steps 2.3, 4.1, 4.2, 10.1-10.4 lack acceptance criteria. Step 10 is the highest-risk step with none. | Added acceptance criteria to all |
| RB-5 | MEDIUM | Ambiguous | Step 10 doesn't specify where the `scan_instruction()` helper function lives — same file, new module, or shared utils. | Specified: private fn in `validate_and_authorize.rs` |
| RB-6 | MEDIUM | Ambiguous | Step 10 helper return type `Result<ScanAction>` doesn't clarify Anchor vs std Result. | Changed to explicit `anchor_lang::Result<ScanAction>` |
| RB-7 | LOW | Completeness | Appendix A missing `package.json` (root) for Step 2.0 and `deploy-devnet.yml` for Step 3.2 | Added to Appendix A |
| RB-8 | LOW | Dependency | Execution order table missing Step 2.0 in Phase 6 | Added to table |

### What the "10/10" Review Missed

The critical RB-1 finding (wrong CI workflow) would have caused the verify step to never fire in production — it was attached to a workflow that publishes npm packages, not one that deploys program bytecode. This is the kind of issue that only surfaces when you cross-reference the plan against the actual CI configuration files, not just check internal consistency.

---

## Appendix G: Compile-Correctness Audit (v1.4, 2026-03-26)

> All three prior audits checked logic, structure, and external references. None checked whether Step 10's Rust code sketch would actually compile against the existing file's imports and type paths.

### Findings

| # | Severity | Category | Finding | Fix Applied |
|---|----------|----------|---------|-------------|
| RC-1 | HIGH | Won't Compile | Step 10 helper takes `ix: &Instruction` but `Instruction` type is not imported. File only imports `get_stack_height` from `anchor_lang::solana_program::instruction`. The scan loops work without it because `load_instruction_at_checked` returns the type implicitly — but a named function parameter requires the type in scope. | Added Step 10.0: import `Instruction` alongside `get_stack_height`. Changed function signature to use fully-qualified `anchor_lang::solana_program::instruction::Instruction` as defense-in-depth. |
| RC-2 | HIGH | Won't Compile | Helper uses bare `system_program::ID` (line 722) but actual code at v&a.rs:299,399 uses fully-qualified `anchor_lang::solana_program::system_program::ID`. `anchor_lang::prelude::*` does NOT re-export `system_program::ID` (it re-exports `System` for `Program<'info, System>`, not the program ID constant). Code would fail with `cannot find value system_program in this scope`. | Changed helper to use `anchor_lang::solana_program::system_program::ID` matching actual code. |
| RC-3 | INFO | Robustness | Step 10 helper signature uses `ix: &Instruction` (short form) which depends on having the import in scope. Alternative: use fully-qualified type in signature to be import-independent. Plan now shows both approaches. | Function signature updated to fully-qualified type; Step 10.0 adds import for caller convenience. |

### Why Three Prior Audits Missed This

- **v1.1 audit (Appendix D):** Checked factual claims (line numbers, constants, file existence). Did not attempt to compile the code sketch.
- **v1.2 audit (Appendix E):** Checked SDK import package names, CI targets, internal consistency. Noted Anchor's `Deref` impl works for `PolicyConfig` (correct), but didn't check if `Instruction` type was importable.
- **v1.3 audit (Appendix F):** Cross-referenced CI files, added install step, fixed D1 contradiction. Checked `anchor_lang::Result` vs `std::Result` (good catch). But `system_program::ID` vs `anchor_lang::solana_program::system_program::ID` is the same class of issue (path resolution) that went unchecked.

The lesson: **code sketch audits must include import verification**. A function signature that names a type requires that type to be in scope — even if existing code uses the same type implicitly.

---

## Appendix H: Comprehensive Fifth-Pass Audit (v1.5, 2026-03-26)

> Fifth independent verification. Systematic coverage of ALL audit surfaces: TOC integrity, step numbering propagation, WIP commit accuracy, code comment security semantics, cross-reference consistency. Council consulted for Step 5.1 leverage comment correction.

### Findings

| # | Severity | Category | Finding | Fix Applied |
|---|----------|----------|---------|-------------|
| RD-1 | HIGH | Security Misstatement | Step 5.1 code comment says "agents can only under-declare (which restricts them)" — factually inverted. Under-declaring PASSES the check (helps agents). Council unanimously confirmed this must be corrected. | Comment rewritten: "Advisory only — agent can under-declare or pass None to skip" |
| RD-2 | MEDIUM | TOC Duplicate | Line 49 was a duplicate entry for Appendix F (left behind when v1.4 inserted Appendix G) | Removed duplicate, added Appendix H entry |
| RD-3 | MEDIUM | Stale Reference | WIP commit 6/9 says "release workflow" but Step 3.2 was corrected to target deploy-devnet.yml in v1.3 | Changed to "deploy-devnet workflow" |
| RD-4 | MEDIUM | Missing Propagation | Step 10.0 (import prerequisite) added in v1.4 but not propagated to dependency graph, Appendix A, execution order table, or testing strategy | Added 10.0 to all four locations |
| RD-5 | LOW | Redundancy | Code sketch at lines 717-721 has 5-line commented import block that duplicates Step 10.0 | Replaced with single-line reference to Step 10.0 |

### Audit Surface Coverage Matrix

This audit systematically covered surfaces that prior audits did not:

| Surface | v1.1 | v1.2 | v1.3 | v1.4 | v1.5 (this) |
|---------|------|------|------|------|-------------|
| Line number accuracy | ✅ | | | | |
| Constants values/locations | ✅ | ✅ | | | |
| External package names | | ✅ | | | |
| CI workflow targeting | | | ✅ | | |
| Dependency installation | | | ✅ | | |
| Body-appendix consistency | | | ✅ | | |
| Code sketch compilation | | | | ✅ | |
| TOC integrity | | | | | ✅ |
| Step numbering propagation | | | | | ✅ |
| WIP commit message accuracy | | | | | ✅ |
| Code comment security semantics | | | | | ✅ (Council) |
| Cross-reference consistency | | | | | ✅ |

### Council Decision Record

**Question:** Should Step 5.1's leverage comment be corrected from "restricts them" to "advisory"?

**Council Members:** Security Auditor (Rook), Architect (Serena), Engineer (Marcus)

**Vote:** 3-0 unanimous YES. All agreed the comment inverts the security model and must be corrected.

**Adopted phrasing (Rook's):** `// Advisory only: agent can under-declare or pass None to skip this check. Spending caps (finalize_session) are the real enforcement, not leverage_bps.`

---

## Appendix I: Security-Implications Audit (v1.6, 2026-03-26)

> All five prior audits checked whether the plan's claims were correct. None checked what IMPLEMENTING the plan would INTRODUCE. This audit analyzed security regressions, operational gaps, cross-plan dependencies, and real-world implementation risks.

### Findings

| # | Severity | Category | Finding | Fix Applied |
|---|----------|----------|---------|-------------|
| S-1 | HIGH | Security regression | Steps 10.2/10.3 had no code sketches — the spending-only checks (ProtocolMismatch, defi_ix_count, Jupiter slippage) could be accidentally dropped during refactoring | Added full code sketches for 10.2 and 10.3 with inline spending-only checks clearly marked |
| S-2 | HIGH | Security regression | `ScanAction::Infrastructure` return didn't specify caller must `continue` — without it, infrastructure programs would be checked against protocol allowlist and FAIL | Code sketches explicitly show `continue` with comments referencing original line 301/401 behavior |
| S-3 | MEDIUM | TOCTOU | Step 2.2 ALT migration: old ALT's EOA authority remains active during 14-day grace period — the exact vulnerability the migration fixes | Added TOCTOU mitigation: deactivate old ALT immediately or have Squads issue deactivation as first action |
| S-4 | MEDIUM | Irreversible action | Step 2.4 freeze precondition missing: must not freeze while program is upgradeable (new instructions might need new ALT entries) | Added precondition gate: only freeze after upgrade authority renounced. Cross-referenced Step 4.1 |
| O-1 | HIGH | No failure response | Step 3.1 verification tool has no action plan for MISMATCH result | Added 5-point Verification Failure Runbook |
| O-2 | HIGH | Silent failure | Step 3.2 CI step didn't `set -e` or check exit code — mismatch would show green CI | Changed to separate verify job with `set -e`, own 15-min timeout, version-pinned install |
| O-3 | MEDIUM | No rollback | Step 10 (highest-risk step) had no rollback procedure | Added rollback: `git revert`, rebuild, redeploy, re-test |
| O-4 | MEDIUM | Wrong validation | Step 2.2 verified "identical to old ALT" not "matches EXPECTED_ALT_CONTENTS_DEVNET" | Changed acceptance criteria to validate against canonical list via `verifyPhalnxAlt()` |
| D-1 | HIGH | Cross-plan conflict | docs/ARCHITECTURE.md modified by On-Chain Steps 1c+8.1 AND SDK Step 22 — merge conflict guaranteed if parallel | Added cross-reference note to Step 8.1 warning about SDK Step 22 |
| R-1 | MEDIUM | CI timeout | solana-verify install (3-5 min) competes with deploy job's 20-min timeout | Fixed by separating verify into its own CI job with 15-min budget |
| R-2 | LOW | Version drift | `@sqds/multisig` installed without version pin | Should pin: `pnpm add -Dw @sqds/multisig@2.1.4` |

### What All Five Prior Audits Had in Common (Blind Spot Analysis)

All five prior audits asked: **"Is this claim correct?"** None asked: **"If I implement this exactly as written, what could go wrong?"**

| Audit Category | v1.1-v1.5 Coverage | This Audit (v1.6) |
|---|---|---|
| Are line numbers right? | YES | Not checked (already verified 5x) |
| Do imports compile? | YES (v1.4) | Not checked |
| Do CI targets exist? | YES (v1.3) | Extended: does the CI step FAIL on error? |
| Are constants correct? | YES (v1.1) | Not checked |
| Will the refactor drop security checks? | **NO** | **YES — found S-1, S-2** |
| What happens when verification fails? | **NO** | **YES — found O-1, O-2** |
| Do parallel plans conflict? | **NO** | **YES — found D-1** |
| Are irreversible actions gated? | **NO** | **YES — found S-4** |
