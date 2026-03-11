# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read docs/PROJECT.md for full specification. Read docs/INSTRUCTIONS.md for all coding rules and guardrails. Read docs/TASKS.md for build progress.**

## Working Methodology

### Thinking Order
1. **Big picture first.** Before touching any file, before writing any code, before making any recommendation — understand the full system. What does this codebase do? What are the architectural boundaries? What are the constraints? What are the goals? Map the territory before you move through it.
2. **Then drill down.** Only after you have a clear macro-level understanding should you examine specific files, functions, or implementations. Never invert this order. If you find yourself diving into details without understanding the surrounding system, stop and zoom out.

### Core Rules

**Never assume.** If anything is unclear, ambiguous, or underspecified — STOP and ask before proceeding. Do not guess at intent, architecture decisions, or expected behavior. Do not infer requirements from naming conventions or patterns alone. Verify. Your confidence must be 100% before you commit to a direction. If it is not, ask questions until it is.

**Use subagents aggressively.** Spin up subagents for every distinct investigation, analysis, or verification task. There is no upper limit — use 5, 20, 100, whatever the problem demands. Run them in the background so the main agent context stays clean and focused. Each subagent should have a clearly scoped task: one question, one investigation, one file analysis per subagent. The main agent's job is to orchestrate, synthesize, and verify — not to do all the work itself.

**Adversarial verification is essential.** Treat every finding — yours or a subagent's — as a hypothesis, not a conclusion. Actively attempt to disprove each finding before accepting it. Ask: "What would make this wrong? What edge case breaks this? What am I not seeing?" Stress-test assumptions. Look for counterexamples. Challenge the reasoning chain. If you cannot disprove a finding after rigorous scrutiny, then and only then accept it as correct.

**Label confidence on every finding.** Use: CONFIRMED (could not disprove), LIKELY (strong evidence but not fully stress-tested), or UNCERTAIN (needs more investigation).

### Output Mode: Report Only (Default)
Unless explicitly told to implement, your output is a verified report only. Do NOT modify, create, or delete any files. Structure reports as:
1. **System Understanding** — Big-picture assessment of the relevant system/context.
2. **Findings** — Each finding with: what you found, the evidence, what you did to try to disprove it, and your confidence level.
3. **Recommendations** — What should be done about each finding, ordered by severity/impact.
4. **Open Questions** — Anything you could not resolve to 100% confidence that needs human input.

No filler. Every sentence should carry information.

### Output Mode: Implementation (When Told to Implement)
- Before implementing anything, state what you are about to change and why. Wait for confirmation if the change is non-trivial.
- Implement one finding at a time. After each change, verify it works before moving to the next.
- Use subagents to validate your own changes — do not self-certify.
- Do not batch multiple unrelated changes into one commit.

### What Never To Do
- Do not skip the big-picture step. Ever.
- Do not accept the first answer you find. Verify it.
- Do not waste main agent context on work a subagent could do.
- Do not present uncertain findings as confirmed. Be honest about confidence levels.

---

## What This Is

Phalnx is a Solana Anchor program (Rust) that sits between AI agent signing keys and DeFi protocols (Jupiter, Flash Trade). It provides PDA vaults with configurable permission policies, spending limits, and audit infrastructure. The developer is proficient in Rust and Anchor — write production-quality code.

**Program ID:** `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`

---

## Reference Skills

Skills are large (20KB–213KB). **Do not read proactively.** See MEMORY.md for the full skill table with sizes and use cases. Path: `.claude/skills/`.

---

## Monorepo & Commands

pnpm workspace with changesets. `pnpm install --frozen-lockfile` · `pnpm -r run build` · `pnpm changeset` for versioning.

```bash
anchor build --no-idl                    # Build (--no-idl required, Anchor 0.32.1)
git checkout -- target/idl/ target/types/ # Restore committed IDL after build
npx ts-mocha -p ./tsconfig.json -t 300000 tests/<file>.ts  # On-chain tests (LiteSVM)
pnpm --filter <package> test             # Package-specific tests
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
| **AgentVault** | `[b"vault", owner, vault_id]` | 610 bytes |
| **PolicyConfig** | `[b"policy", vault]` | 817 bytes |
| **SpendTracker** | `[b"tracker", vault]` | 2,840 bytes (zero-copy) |
| **SessionAuthority** | `[b"session", vault, agent, token_mint]` | Standard |
| **PendingPolicyUpdate** | `[b"pending_policy", vault]` | Standard |
| **EscrowDeposit** | `[b"escrow", source_vault, dest_vault, escrow_id]` | 170 bytes |
| **InstructionConstraints** | `[b"constraints", vault]` | 8,318 bytes |
| **PendingConstraintsUpdate** | `[b"pending_constraints", vault]` | 8,334 bytes |
| **AgentSpendOverlay** | `[b"agent_spend", vault]` | 2,368 bytes (zero-copy) |

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

## Error Codes (6000–6076)

77 error codes. Source of truth: `programs/phalnx/src/errors.rs`. See `docs/ERROR-CODES.md` for full table.
MCP server maps all 77 codes to human-readable suggestions in `packages/mcp/src/errors.ts`.

---

## Code Conventions (Anchor-Specific)

- One file per instruction in `instructions/`, one file per account in `state/`
- `require!()` for preconditions, `require_keys_eq!()` for pubkey comparisons
- `pub(crate)` for internal visibility, `emit!()` on every instruction
- `.ok_or(error!(PhalnxError::Overflow))?` for checked math
- Conventional commits: `feat:`, `fix:`, `test:`, `refactor:`

---

## Current State

Phases 1–5, A, B, C, D, E, F, F.5, G, G.3, H, I, J.1, K, Option C complete. 29 instructions, 9 PDA types, ~1,928 tests passing. See MEMORY.md for details.

---

## Testing

~1,928 tests across 18 suites (1839 CI + 20 Surfpool + 69 devnet).

| Tier | Tool | Speed | When to use |
|------|------|-------|-------------|
| Unit | LiteSVM | ~45s for 325 tests | Policy logic, error paths, security exploits, composed TX with mocks |
| Integration | Surfpool | ~60s for 20 tests | Session expiry, real token balances, CU profiling, time travel |
| Cluster | Devnet | ~5min for 69 tests | End-to-end with deployed program, costs SOL |

Test file list: `scripts/test-counts.json`. Helpers: `tests/helpers/litesvm-setup.ts`, `tests/helpers/surfpool-setup.ts`.
