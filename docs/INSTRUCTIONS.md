# INSTRUCTIONS.md — Claude Code Guardrails for Sigil

## Role

You are building Sigil, a Solana on-chain program that provides permission controls, spending limits, and audit infrastructure for AI agents interacting with DeFi protocols. You are working with a developer who is proficient in Rust and Anchor. Your job is to write production-quality Solana programs, TypeScript SDKs, tests, and integration code.

---

## Critical Rules — Never Violate These

### Solana-Specific Constraints

1. **CPI depth limit is 4 levels.** Never design instruction flows that nest more than 4 levels of cross-program invocations. The architecture uses instruction composition (multiple instructions in one transaction) rather than CPI wrapping. If you find yourself writing a CPI that calls a program that itself makes a CPI, count the depth carefully.

   > **Note: SIMD-0268** (accepted, pending activation) raises this limit from 4 to 8. The instruction composition pattern remains preferred because: (1) DeFi protocols don't need to know about Sigil — zero coupling means any protocol integration requires only SDK changes, no program changes, (2) the validate/execute/finalize separation provides clean audit boundaries for compliance, and (3) composition is more flexible — new DeFi integrations are SDK-side only, with no program upgrade required.

2. **Compute budget is 1.4M CU max per transaction.** Always request the appropriate compute budget at the start of composed transactions via `ComputeBudgetInstruction::set_compute_unit_limit`. A permission check (~10K CU) + Jupiter swap (~600K CU) + finalize (~10K CU) is fine. But never assume unlimited compute.

3. **Account size limits.** A single Solana account can hold up to 10MB, but larger accounts cost more rent. Keep account sizes small and predictable. Never use unbounded `Vec<T>` without a hard maximum enforced in the program. The `SpendTracker` uses a fixed 144-epoch circular buffer (`#[account(zero_copy)]`, 2,840 bytes) — each epoch bucket covers a 10-minute window, providing rolling 24h spend tracking. All vectors are bounded: max 10 protocols, 10 destinations.

4. **PDA seeds must be deterministic and documented.** Every PDA must have clearly documented seeds. Use this pattern:
   - Vault: `[b"vault", owner.key().as_ref(), vault_id.to_le_bytes().as_ref()]`
   - Policy: `[b"policy", vault.key().as_ref()]`
   - Tracker: `[b"tracker", vault.key().as_ref()]`
   - Session: `[b"session", vault.key().as_ref(), agent.key().as_ref(), token_mint.key().as_ref()]`
   - Token Account: `[b"token_account", vault.key().as_ref(), mint.key().as_ref()]`

5. **Always use checked math.** Never use raw arithmetic operators on u64/u128 values. Use `.checked_add()`, `.checked_sub()`, `.checked_mul()`, `.checked_div()`. Return `SigilError::Overflow` on None.

6. **Always validate all accounts.** Every account passed to an instruction must be validated:
   - PDAs: verify seeds and bump
   - Token accounts: verify owner and mint
   - Signers: verify they actually signed
   - Programs: verify the program ID matches expected (System Program, Token Program, etc.)
   - Anchor's `Account<>` and `#[account()]` constraints handle most of this, but double-check constraint annotations

7. **Rent exemption.** All created accounts must be rent-exempt. Use Anchor's `init` constraint which handles this automatically, but be aware of reallocation scenarios.

8. **Clock usage.** Use `Clock::get()` for timestamps, not a passed-in sysvar account (the sysvar approach is deprecated). For slot-based expiry (SessionAuthority), use `Clock::get()?.slot`.

### Architecture Constraints

9. **Never hold funds in the program's own account.** Funds always live in PDA-controlled Associated Token Accounts or PDA token accounts specific to each vault. The program itself holds no SOL beyond rent.

10. **The owner is the ultimate authority.** The owner can always: withdraw funds, revoke agents, freeze vaults, update policies, close vaults. The agent can only: call `validate_and_authorize` and `finalize_session`. No instruction should allow the agent to modify policies, register new agents, or withdraw to arbitrary destinations.

11. **Sessions are ephemeral and must expire.** SessionAuthority accounts must have a slot-based expiry (e.g., valid for 20 slots / ~8 seconds). If a session isn't finalized, anyone can close expired sessions to reclaim rent. Never leave session accounts hanging indefinitely.

12. **Spending caps use rolling windows.** The 24-hour spending cap uses a zero-copy 144-epoch circular buffer. Each epoch bucket covers 10 minutes. The rolling total is computed by iterating all 144 buckets and summing those within the 24h window, with proportional boundary correction on the oldest partial epoch (~$0.000001 worst-case rounding). USD amounts are determined by stablecoin identity (USDC/USDT amount / 10^6 = USD). No oracles.

13. **Audit events are mandatory.** Every state-changing instruction must emit an Anchor event. These events are the primary mechanism for off-chain indexing and audit trails. Never skip event emission.

### Code Quality

14. **Follow Anchor conventions.** Use `#[derive(Accounts)]` structs for all instructions. Use `#[account]` for state. Use `#[error_code]` for errors. Use `#[event]` for events. Don't use raw Solana program entrypoints unless absolutely necessary.

15. **One file per instruction.** Each instruction gets its own file in `programs/sigil/src/instructions/`. The file contains the `#[derive(Accounts)]` struct and the handler function. Re-export from `instructions/mod.rs`.

16. **One file per account type.** Each account struct gets its own file in `programs/sigil/src/state/`. Include impl blocks for validation helpers and utility methods on the account structs themselves.

17. **Tests must cover failure cases.** For every instruction, write tests that verify:
    - The happy path works
    - Each error condition is triggered correctly (unauthorized signer, exceeded cap, frozen vault, etc.)
    - Edge cases (exactly at the cap, spending cap rolling window boundary, session expiry boundary)

18. **TypeScript SDK mirrors program structure.** The SDK should have instruction builder functions that match 1:1 with program instructions. Each function returns a `TransactionInstruction` that can be composed into transactions.

19. **No external dependencies in the on-chain program** beyond anchor-lang, anchor-spl, and solana-program. Do not add unnecessary crates. Every byte of program size matters for deployment cost and compute.

20. **Comments explain WHY, not WHAT.** The code should be readable enough that what it does is obvious. Comments should explain design decisions, security considerations, and non-obvious constraints.

### Fee Collection Rules

21. **Fee calculation uses checked math with truncation toward zero.** The formula is `fee = amount.checked_mul(fee_bps as u64).ok_or(Overflow)?.checked_div(10_000).ok_or(Overflow)?`. This truncates fractional lamports toward zero (floor division), which is safe — the protocol never overcharges. Never use floating point. Never round up.

22. **developer_fee_rate is capped at 500 (5 BPS = 0.05%).** The program must reject any `initialize_vault` or `update_policy` call that sets `developer_fee_rate > 500`. This is a hardcoded constant (`MAX_DEVELOPER_FEE_RATE`), not a configurable parameter. It protects users from predatory fee configurations and provides a clear guarantee.

23. **fee_destination is set once at vault creation and never changes.** No instruction should allow modifying `vault.fee_destination` after initialization. This prevents fee redirection attacks. The SDK should hardcode the official Sigil treasury address so all vaults route fees to the same place.

24. **Fees are collected in `validate_and_authorize` (upfront, non-bypassable).** Protocol and developer fees are transferred via CPI during authorization. If the DeFi operation in Instruction 2 fails, the entire transaction reverts atomically and fees are refunded. This ensures fees cannot be bypassed by omitting `finalize_session`.

25. **Zero-fee transactions are valid.** If `fee_bps = 0`, the fee calculation produces `0` and no transfer occurs. The `finalize_session` instruction must handle this gracefully — skip the SPL token transfer CPI entirely when fee is zero, saving compute.

26. **fee_destination token account must be validated.** In `finalize_session`, verify that the `fee_destination_token_account` passed in is actually the Associated Token Account of `vault.fee_destination` for the correct mint. Never trust a user-supplied fee destination account without verification.

---

## Security Guardrails

### Account Validation Checklist

For every instruction, verify:

- [ ] All signers are validated (owner or agent, as appropriate)
- [ ] All PDAs have seeds + bump verified via Anchor constraints
- [ ] All token accounts have correct mint and owner verified
- [ ] The vault status is checked (Active vs Frozen) where relevant
- [ ] The vault's agent matches the signing agent
- [ ] Program IDs for CPIs are hardcoded or verified, never passed as arbitrary accounts
- [ ] Fee destination token account is validated as the correct ATA for vault.fee_destination
- [ ] developer_fee_rate does not exceed MAX_DEVELOPER_FEE_RATE (500)

### Reentrancy Prevention

Solana's runtime prevents reentrancy at the account level (an account can't be passed to two programs simultaneously in a CPI chain). However, within instruction composition (multiple instructions in one transaction), the same accounts CAN be accessed by different instructions. The SessionAuthority pattern prevents replay:

1. `validate_and_authorize` creates a SessionAuthority PDA (init, requires it doesn't already exist)
2. The DeFi instruction executes
3. `finalize_session` closes the SessionAuthority PDA

If step 1 is called twice in the same transaction, the second call fails because the PDA already exists (Anchor `init` constraint). This prevents double-authorization.

### Integer Overflow

All financial calculations MUST use checked arithmetic. Key areas:
- Spending cap accumulation
- Stablecoin-to-USD decimal scaling
- Leverage calculation (basis points math)
- Rolling window timestamp comparison

### Front-Running / MEV

For the MVP, MEV protection is handled at the transaction submission level (Jito bundles) by the SDK, not by the on-chain program. The program itself doesn't need to worry about MEV. Document this clearly — the SDK should include Jito bundle submission as an option.

---

---

## Testing Strategy

### Unit Tests (Anchor/Bankrun)
- Test every instruction in isolation
- Test every error path
- Test policy enforcement edge cases
- Test rolling window arithmetic
- Use `bankrun` for fast local testing where possible

### Integration Tests
- Test full composed transactions (validate → swap → finalize)
- Test with mock Jupiter/Flash Trade programs on localnet
- Test transaction failure scenarios (what happens if the swap fails after authorization?)
- Test concurrent agents on different vaults

### Security Tests
- Attempt to call owner-only instructions as agent (must fail)
- Attempt to authorize actions on a frozen vault (must fail)
- Attempt to reuse a session (must fail)
- Attempt to pass wrong PDA seeds (must fail)
- Attempt to exceed spending caps by splitting into multiple small transactions (must still fail)
- Attempt to pass a fake program ID as Jupiter/Flash Trade (must fail)
- Attempt to set fee_bps > 500 in initialize_vault (must fail with FeeBpsTooHigh)
- Attempt to set fee_bps > 500 in update_policy (must fail with FeeBpsTooHigh)
- Attempt to pass a wrong fee_destination_token_account in finalize_session (must fail)
- Verify fee_amount calculation is correct: amount=10000, fee_bps=3 → fee=3
- Verify fee=0 when fee_bps=0 (no transfer CPI executed)
- Verify fee=0 when amount is too small for fee to round up (amount=100, fee_bps=1 → fee=0)
- Verify vault.total_fees_collected accumulates correctly across multiple transactions

---

## Style Guide

### Rust
- Use `rustfmt` default formatting
- Max line length: 100 characters
- Use `pub(crate)` for internal visibility, `pub` only for the external interface
- Error handling: use `require!()` macro for precondition checks, return `Result<()>` from handlers
- Name instruction handler functions as `handler` within their module (Anchor convention)

### TypeScript
- Use strict TypeScript (`"strict": true`)
- Use `async/await`, never raw promises
- Use `BN` from `@coral-xyz/anchor` for all on-chain number types
- Use `PublicKey` from `@solana/web3.js`, never raw strings for addresses
- Export all public types from `src/index.ts`

### Git
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`
- One logical change per commit
- Tests must pass before committing

---

## What NOT to Build

Do not build any of the following in the initial phases:

- **Token / governance** — No protocol token. No DAO governance. Pure infrastructure.
- **Multi-chain support** — Solana only. No EVM, no cross-chain.
- **Agent framework** — Sigil is middleware, not an agent framework. Don't build agent logic, LLM integration, or decision-making systems.
- **Custodial features** — Never build anything that gives the program or the team custody of user funds.
- **Admin keys / upgradeable program** — The program should be immutable once deployed to mainnet. No admin keys, no upgrade authority in production. During development, use upgrade authority on devnet only.
- **Complex risk models** — Phase 1 risk management is simple: spending caps, asset whitelists, protocol whitelists, leverage limits. No ML models, no VaR calculations, no portfolio optimization.
- **Price oracle integration** — Oracles have been removed entirely. USD tracking uses stablecoin identity (USDC/USDT amount / 10^6 = USD). No Pyth, no Switchboard.
- **Dashboard UI (Phase 1-3)** — The dashboard is Phase 4. Focus on the program, SDK, and agent integrations first.

---

## Reference Resources

- [Anchor Book](https://book.anchor-lang.com/)
- [Solana Cookbook](https://solanacookbook.com/)
- [Solana Program Limitations](https://solana.com/docs/programs/limitations)
- [Jupiter V6 API Docs](https://station.jup.ag/docs/apis/swap-api)
- [Flash Trade SDK](https://github.com/AsgardFi/) — Check for latest repo names
- [Squads Protocol V4](https://github.com/Squads-Protocol/v4)
- [Pyth Network Solana SDK](https://github.com/pyth-network/pyth-sdk-solana)
- [Anchor Events](https://book.anchor-lang.com/anchor_in_depth/events.html)
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [@solana/kit](https://github.com/anza-xyz/solana-web3.js) (the `@solana/kit` package in the web3.js monorepo)
- [Drift Protocol SDK](https://github.com/drift-labs/protocol-v2)
- [LiteSVM](https://github.com/LiteSVM/litesvm)

---

## MCP Server Conventions

> **DEPRECATED (2026-03-20):** The `@usesigil/mcp` package was removed in Phase 0 (nuclear cleanup). MCP tools will be rebuilt in Phase 4 using the new `seal()` API.
> See `SEAL-ARCHITECTURE-PLAN-v5.md` for the planned MCP design: `sigil_seal` for raw instructions, `sigil_swap`/`sigil_lend`/`sigil_perp` for aggregator-backed tools.

---

## @solana/kit SDK

`@usesigil/kit` is the sole SDK — fully Kit-native (`@solana/kit` peer dep), zero `@solana/web3.js` dependency, ESM-only. Primary API is `SigilClient` which wraps `seal()`.

---

## Drift Protocol Integration Constraints

Drift integration follows the same instruction composition pattern as Jupiter and Flash Trade. These constraints are specific to Drift's account model and program design.

### Account Model

Drift uses a complex account model that must be accounted for in transaction composition:

| Account | Description | Required For |
|---------|-------------|-------------|
| `User` | Per-user PDA holding positions and orders | All operations |
| `UserStats` | Per-user stats (fees paid, volume) | All operations |
| `State` | Global Drift protocol state | All operations |
| `PerpMarket` | Per-market configuration and state | Perp operations |
| `SpotMarket` | Per-spot-market state | Spot operations |
| `Oracle` | Price oracle for the market | All operations |

### Instruction Mapping

| Sigil Action | Drift Instruction | ActionType |
|-------------------|-------------------|------------|
| Open perp position | `place_perp_order` | `OpenPosition` |
| Close perp position | `cancel_order` + `place_perp_order` (reduce-only) | `ClosePosition` |
| Modify position | `modify_order` | `IncreasePosition` or `DecreasePosition` |
| Cancel pending order | `cancel_order` | `ClosePosition` |

### Composition Pattern

```
Transaction {
  Instruction 0: SetComputeBudget (1.4M CU — Drift is compute-heavy)
  Instruction 1: Sigil::validate_and_authorize
  Instruction 2: Drift::place_perp_order (or cancel_order, modify_order)
  Instruction 3: Sigil::finalize_session
}
```

### Constraints

1. **Drift User account must be initialized separately.** The vault's Drift User PDA (`[b"user", vault_pda]`) must be created before the first Drift operation. Add a `client.initializeDriftUser()` helper.
2. **Compute budget:** Drift perp orders can consume 400K-800K CU. Always request 1.4M CU for Drift composed transactions.
3. **Oracle staleness:** Drift rejects orders when the oracle price is stale. The SDK should check oracle freshness before composing transactions (pre-flight).
4. **Market index, not market address.** Drift uses market indices (u16) not market addresses. The SDK must map market names ("SOL-PERP") to indices.
5. **Leverage calculation:** Drift leverage is expressed differently than Flash Trade. Convert to BPS for Sigil policy comparison: `leverage_bps = (notional_value / collateral) * 100`.
6. **Position tracking:** Drift allows multiple positions per market. Track `open_positions` as the count of distinct markets with non-zero positions, not the count of orders.

---

## Pre-flight Validation Patterns

Pre-flight validation checks policy constraints client-side BEFORE composing and sending transactions. This saves compute, improves agent UX, and enables smarter decision-making.

### Pattern

```typescript
// Always validate before composing
const check = await client.validateAction({
  vault: vaultPubkey,
  amount: new BN(1_000_000),
  tokenMint: USDC_MINT,
  protocol: JUPITER_PROGRAM_ID,
  actionType: ActionType.Swap,
});

if (!check.allowed) {
  // Handle denial: check.reason, check.details
  // DO NOT compose and send — it will fail on-chain
  return;
}

// Safe to compose and send
const tx = await client.composeSwap({ ... });
```

### Validation Result Type

```typescript
type ValidationResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: ValidationDenialReason;
      details: Record<string, unknown>;
    };

type ValidationDenialReason =
  | "VaultNotActive"
  | "TokenNotAllowed"
  | "ProtocolNotAllowed"
  | "TransactionTooLarge"
  | "SpendingCapExceeded"
  | "LeverageTooHigh"
  | "TooManyPositions"
  | "PositionOpeningDisallowed"
  | "InsufficientBalance";
```

### Rules

1. **Pre-flight must replicate on-chain logic exactly.** If pre-flight says `allowed: true`, the on-chain `validate_and_authorize` must also succeed (given no state changes between the check and the transaction). Test this invariant.
2. **Pre-flight is advisory, not authoritative.** On-chain state can change between the pre-flight check and transaction submission. Never skip the on-chain check based on pre-flight results.
3. **Fetch accounts efficiently.** Use `getMultipleAccountsInfo` to fetch vault, policy, and tracker in a single RPC call. Don't make 3 separate calls.
4. **Include balance check.** Pre-flight should also verify the vault has sufficient token balance for the requested amount (on-chain doesn't check this — the SPL transfer would fail).
5. **Return actionable details.** When denied, include enough context for the agent to adapt:
   - `SpendingCapExceeded` → `{ spent: 450, cap: 500, requested: 100, remainingBudget: 50 }`
   - `LeverageTooHigh` → `{ requested: 2000, max: 1000 }` (in BPS)
   - `TokenNotAllowed` → `{ requestedToken: "...", allowedTokens: ["...", "..."] }`
6. **Budget helper.** `client.getRemainingBudget(vault)` returns the remaining daily spend capacity as a single number. This is the most common pre-flight query and should be optimized.

---

## Custody Provider Integration Patterns

Sigil works WITH custody providers, not against them. The "dual layer" model: custody providers protect keys (key security), Sigil vaults enforce policies (spending enforcement). These are complementary, not competitive.

### Architecture

```
┌──────────────────────────────────┐
│  Custody Provider                │
│  (Coinbase / Privy / Turnkey)    │
│  - Holds private keys            │
│  - Signs transactions            │
│  - Key rotation, backup, MPC     │
└────────────────┬─────────────────┘
                 │ signed tx
                 ▼
┌──────────────────────────────────┐
│  Sigil Vault (on-chain)    │
│  - Enforces spending caps        │
│  - Token/protocol whitelists     │
│  - Leverage limits               │
│  - Audit trail                   │
└──────────────────────────────────┘
```

### Adapter Pattern

```typescript
interface CustodyAdapter {
  signTransaction(tx: Transaction): Promise<Transaction>;
  getPublicKey(): Promise<PublicKey>;
  getNetwork(): "devnet" | "mainnet-beta";
}

// Usage
const coinbaseAdapter: CustodyAdapter = new CoinbaseAgenticAdapter({ apiKey, walletId });
const client = new SigilClient({ provider, programId })
  .withCustodyProvider(coinbaseAdapter);

// Now client uses Coinbase for signing, Sigil vault for policy
await client.composeSwap({ vault, ... }); // Coinbase signs, vault enforces
```

### Rules

1. **Never require a custody provider SDK as a hard dependency.** Custody adapters are optional peer dependencies. The core SDK works without any custody provider.
2. **Adapter is a thin signing layer.** The adapter only provides `signTransaction` and `getPublicKey`. All policy enforcement, transaction composition, and account management stay in the Sigil SDK.
3. **Vault owner key must match custody provider key.** When using a custody provider, the vault's `owner` pubkey must correspond to the custody provider's key. The adapter signs owner-authority transactions (deposit, withdraw, policy update).
4. **Agent key is separate.** The agent signing key can be a different custody provider, a TEE-generated key, or a standard keypair. The adapter pattern applies to both owner and agent keys independently.
5. **Test with mock adapters.** Create a `MockCustodyAdapter` for testing that wraps a standard Keypair. All adapter tests should use mocks, not live custody provider APIs.

---

## x402 Integration Patterns ✅ (Phase I.1 — Complete)

x402 is the dominant HTTP 402 Payment Required standard for machine-to-machine crypto payments on Solana. Sigil integrates x402 at the SDK level via `shieldedFetch()`.

**Dependency:** `@x402/core` only (NOT `@x402/svm` — conflicts with `@solana/web3.js` v1.x).

### Client-Side x402 Flow (shieldedFetch)

```
1. Agent calls shieldedFetch(wallet, url)
2. SDK makes HTTP request via globalThis.fetch
3. If response is NOT 402 → return as-is
4. If 402 but no PAYMENT-REQUIRED header → return raw 402 (non-x402)
5. Decode PAYMENT-REQUIRED header (base64 → PaymentRequired V2)
6. selectPaymentOption() — find Solana-compatible payment from accepts[]
7. evaluateX402Payment() — pre-check against shield policies (no spend recording)
8. Build SPL TransferChecked instruction → sign via wallet.signTransaction()
   (shield interceptor runs here — records spending, enforces caps)
9. Encode signed tx as PAYMENT-SIGNATURE header
10. Retry fetch with PAYMENT-SIGNATURE header
11. Parse PAYMENT-RESPONSE header from settlement
12. Return response with x402 metadata attached
```

**Key design decisions:**
- **Client NEVER settles.** Client signs payment and retries. The x402 API server calls the facilitator to settle.
- **Double-evaluation avoidance:** `evaluateX402Payment()` is pre-check only (no spend recording). The actual enforcement + recording happens in `signTransaction()`.
- **Loop prevention:** Checks for existing `PAYMENT-SIGNATURE` header before any policy evaluation (prevents infinite retry loops).
- **Hardened wallet path:** Uses `agent_transfer` instruction (not composition pattern) because fee collection requires vault PDA signer seeds that delegation cannot provide.

### x402 V2 Header Format

```typescript
// PAYMENT-REQUIRED header (base64-encoded JSON):
interface PaymentRequired {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];  // Array of payment options
}

interface PaymentRequirements {
  scheme: string;        // e.g., "exact"
  network: string;       // e.g., "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  asset: string;         // Token mint (e.g., USDC)
  amount: string;        // Amount in base units
  payTo: string;         // Recipient address
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}
```

### SDK API

```typescript
import { shieldedFetch, createShieldedFetch } from '@usesigil/kit/x402';

// Direct usage
const res = await shieldedFetch(wallet, 'https://api.example.com/paid', { connection });
if (res.x402?.paid) {
  console.log(`Paid ${res.x402.amountPaid} to ${res.x402.payTo}`);
}

// Wallet-bound factory
const fetch = createShieldedFetchForWallet(wallet, { connection });
const res = await fetch('https://api.example.com/paid');

// Convenience method on ShieldedWallet
const res = await wallet.fetch('https://api.example.com/paid');

// Dry run (check if payment would be required, without paying)
const res = await shieldedFetch(wallet, url, { connection, dryRun: true });
```

### Rules

1. **x402 payments use `Transfer` action type** (not `Swap`). The `inferActionType()` function in `inscribe.ts` detects pure SPL transfer transactions.
2. **Uses x402 V2 format exclusively.** Parses `PaymentRequired` with `accepts[]` array, selects Solana-compatible option via `selectPaymentOption()`.
3. **Policy check happens before payment.** If spending cap exceeded or token not allowed, throws `ShieldDeniedError` before any transfer.
4. **Only 1 retry after payment.** Loop prevention check fires before policy evaluation to prevent infinite retries.
5. **Token decimals:** Looked up via `getTokenInfo()` from registry, defaults to 6 (USDC).
6. **`maxTimeoutSeconds` enforced.** Rejects if elapsed time exceeds the payment requirement's timeout.

---

## Emergency Close Pattern (Phase L — REMOVED, REDESIGN PLANNED)

> **Note:** The original EmergencyCloseAuth PDA was deliberately removed because it introduced an unintentional attack vector. A safer redesign is planned for a future phase. For now, risk-reducing actions (ClosePosition, DecreasePosition, RemoveCollateral, CloseAndSwapPosition) are inherently cap-exempt via `is_spending()` returning false — they never count against the spending cap, so agents can always close positions regardless of cap usage.

---

## Position Counter Reconciliation (Phase L)

Vault position counters can drift when Flash Trade keepers execute trigger orders (TP/SL) or fill limit orders outside Sigil's session pattern. The reconciliation flow corrects this:

### Flow

```
1. Keeper fills limit order → Flash Trade position changes
2. Sigil vault.open_positions is now wrong
3. SDK calls countFlashTradePositions() → derives PDAs, counts live positions
4. SDK calls reconcilePositions() → compares counter, returns sync instruction if needed
5. Owner signs sync_positions instruction → counter corrected
```

### Rules

1. **Owner-only.** Only the vault owner can sync positions. Prevents griefing by third parties.
2. **Client-side verification.** The SDK verifies the actual position count by reading Flash Trade position PDAs. The on-chain instruction trusts the owner's provided count.
3. **Both directions.** Counter can be synced up (missed opens) or down (missed closes).
4. **Idempotent.** Syncing when already correct is a no-op (emits event with old == new).

---

## Flash Trade Advanced Order Patterns (Phase L)

### Order Types

| MCP Tool | Flash Trade Operation | ActionType | Spending? |
|----------|----------------------|------------|-----------|
| `shield_open_position` | Market order open | `OpenPosition` | Yes (collateral) |
| `shield_close_position` | Market order close | `ClosePosition` | No |
| `shield_place_limit_order` | Limit order | `OpenPosition` | Yes (reserve) |
| `shield_cancel_limit_order` | Cancel limit | `ClosePosition` | No |
| `shield_place_trigger_order` | TP/SL order | — | No (uses existing position) |
| `shield_cancel_trigger_order` | Cancel TP/SL | — | No |
| `shield_add_collateral` | Add collateral | `IncreasePosition` | Yes |
| `shield_remove_collateral` | Remove collateral | `DecreasePosition` | No |
| `shield_sync_positions` | Reconcile counter | — | No (owner-only) |

### Rules

1. **Keeper-executed orders bypass sessions.** Flash Trade keepers fill limit orders and execute trigger orders without going through `validate_and_authorize`. Position counter drift is expected — use `sync_positions` to correct.
2. **Non-spending actions must have amount = 0.** `ClosePosition` and `DecreasePosition` don't spend from the vault — enforced by `InvalidNonSpendingAmount` error.
3. **Limit order reserve counts as spending.** When placing a limit order, the reserve amount (collateral locked) is tracked against spending caps.
4. **Trigger orders don't count as new spending.** TP/SL orders use existing position collateral — no additional spend tracking.

---

## Identity Provider Integration Patterns

The trust score interface is **protocol-agnostic**. Sigil does not depend on any specific identity protocol. Instead, it defines a generic interface that any identity provider can implement.

### Currently Verified Providers

| Provider | What It Provides | Integration Path |
|----------|-----------------|-----------------|
| **Visa Trusted Agent Protocol** | Agent identity via Visa rails (RFC 9421 HTTP Message Signatures) | Read Visa TAP attestation account on-chain |
| **Civic Gateway tokens** | Identity verification via Civic Pass (KYC/KYB) | Read Civic gateway token state |
| **KYAPay JWT** | JWT-based agent identity (`sub`=agent pubkey, `iss`=policy authority, `cap`=spending limit) | Verify JWT signature, map claims to PolicyConfig fields |
| **ERC-8004** | Cross-chain agent identity (live Ethereum mainnet Jan 2026, 3 registries) | Read via Wormhole Queries (feasibility TBD) |

### Trust Score Interface

```typescript
interface TrustScoreProvider {
  /** Read trust score from on-chain account */
  getTrustScore(agent: PublicKey): Promise<TrustScore>;
  /** The program ID of the identity provider */
  programId: PublicKey;
}

interface TrustScore {
  score: number;     // 0-10000 (BPS scale)
  tier: TrustTier;   // Unverified | Basic | Verified | Established
  provider: string;  // "visa-tap" | "civic" | custom
  expiresAt: number; // Unix timestamp
}
```

### Rules

1. **Never reference unverified protocols as concrete dependencies.** Do not use SAID Protocol, Identity Prism, or MoltLaunch as specific dependency references. Use the generic `TrustScoreProvider` interface instead.
2. **Trust score is always optional.** If no trust score account is provided to `validate_and_authorize`, fall back to the base spending cap (1x multiplier). Zero-config default.
3. **Trust tiers are protocol-agnostic.** The tier multiplier (Unverified=1x, Basic=1.5x, Verified=2x, Established=3x) applies regardless of which identity provider supplied the score.
4. **Verify the identity provider's program ID.** When reading a trust score account, verify it was created by a recognized identity provider program, not a spoofed account.

---

## Server-Side x402 Paywall Patterns (Phase O.1 — Planned)

Sigil handles both SENDING x402 payments (via `shieldedFetch()`) and RECEIVING them (via `@usesigil/paywall` middleware). The paywall enables developers to monetize their AI agent APIs.

### Architecture

```
Agent (client) → shieldedFetch() → API Server
                                      ↓
                              @usesigil/paywall middleware
                                      ↓
                              Returns 402 with PAYMENT-REQUIRED header
                                      ↓
Agent pays → retries with X-PAYMENT → middleware verifies → forwards to handler
```

### Rules

1. **Paywall is a separate npm package.** `@usesigil/paywall` is not part of the SDK. It depends on `@x402/core` for header format and facilitator interaction.
2. **Express/Hono compatible.** Middleware adapter pattern: `app.use('/api/paid/*', shieldPaywall({ asset: USDC, amount: '0.01', payTo: treasury }))`.
3. **Facilitator settles.** The paywall does NOT settle on-chain directly. It delegates settlement to an x402 facilitator (Coinbase, Cloudflare, or self-hosted).
4. **Policy verification is optional.** Paywall can optionally verify that the payer has an active Sigil vault (read-only check). This adds trust: "this agent operates under policy constraints."
5. **Token2022 aware.** When accepting Token2022 tokens, account for transfer fees in the payment amount.

---

## Lifetime Spending Cap & Agent Expiration Patterns (Phase M.5 — Planned)

### Lifetime Cap

Adds `lifetime_spending_cap_usd: u64` to PolicyConfig. 0 = unlimited (default). Check in `validate_and_authorize`: `vault.total_volume + usd_amount <= policy.lifetime_spending_cap_usd`. Uses the existing `total_volume` field on AgentVault (already cumulative).

### Agent Expiration

Adds `agent_expires_at: i64` to AgentVault. 0 = never expires (default). Check in `validate_and_authorize`: `agent_expires_at == 0 || clock.unix_timestamp < agent_expires_at`. Set during `register_agent` with optional parameter. Updateable by owner.

### Rules

1. **Zero means unlimited/never.** Both fields default to 0. This maintains backward compatibility with existing vaults.
2. **Lifetime cap is non-resettable.** The `total_volume` counter on AgentVault is monotonically increasing. The owner can raise the cap but cannot reset the counter.
3. **Agent expiration is refreshable.** Owner can call `register_agent` or a new `update_agent_expiry` to extend the timestamp.
4. **Expired agent cannot be used.** Once expired, the agent must be re-registered (potentially with a new key) or the expiration extended by the owner.
