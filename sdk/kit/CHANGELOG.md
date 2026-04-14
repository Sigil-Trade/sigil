# @usesigil/kit

## 0.2.3

### Patch Changes

- [#203](https://github.com/Sigil-Trade/sigil/pull/203) [`4209b98`](https://github.com/Sigil-Trade/sigil/commit/4209b98de517acd95fee08be366b8d1b2e03a4b4) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 1 SDK convenience layer (trivial items):
  - **S19** — Export `toUsdNumber` (renamed from private `usdToNumber`) and add inverse `fromUsdNumber` with NaN/Infinity `TypeError` guard plus magnitude `RangeError` guard at the documented precision ceiling. Also export `FROM_USD_NUMBER_MAX` so consumers can pre-validate without redefining the constant. `toUsdNumber` now throws `RangeError` on negative input to make its "non-negative" precondition a runtime contract instead of a docstring-only hint.
  - **S5** — Replace 5 `:any` callback params in `dashboard/reads.ts` with concrete types (`SecurityCheck`, `Alert`, `SpendingBreakdown["byProtocol"][number]`, `unknown`).
  - **S7** — Add optional `type?: ActivityType` filter to `ActivityFilters`; applied in `getActivity`. Also fixes the post-ActionType-elimination silent-failure where `mapCategory` could not produce `open_position`/`close_position` for v6 events: `positionEffect` is now plumbed through and used as the primary discriminator.
  - **S8** — Add client-side bounds validation to `queuePolicyUpdate`: `approvedApps.length ≤ MAX_ALLOWED_PROTOCOLS` and `maxConcurrentPositions` via existing `requireU8` (0-255, on-chain u8 type). New `MAX_ALLOWED_PROTOCOLS` constant exported from the SDK's main entry.

  **S8 scope note:** Pre-validation intentionally covers only these 2 fields plus existing `timelock`/`dailyCap`/`maxPerTrade`/`developerFeeRate` checks. Other bounded `queuePolicyUpdate` fields (`allowedDestinations` length, `protocolCaps` length-match with protocols, `maxSlippageBps`, `sessionExpirySlots` range) remain on-chain-only — the SDK JSDoc now enumerates which fields are pre-validated vs on-chain-only.

  **Tests added:** 7 queuePolicyUpdate validation tests (approvedApps length boundary both sides, maxConcurrentPositions u8 overflow / negative / non-integer / boundary), 1 toUsdNumber negative-guard test, 1 fromUsdNumber exact-boundary RangeError test.

## 0.2.2

### Patch Changes

- [#174](https://github.com/Kaleb-Rupe/sigil/pull/174) [`f9f874c`](https://github.com/Kaleb-Rupe/sigil/commit/f9f874c877979219dc7d5d7d3cd6ef27d0c443c1) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Remove external protocol bindings (Flash Trade, Kamino) from SDK source and npm package

  Moved 108,700 lines of Codama-generated external protocol code out of `src/generated/protocols/` into a gitignored `generated-protocols/` directory. These files were never imported at runtime and were inflating the published package. The SDK's public API is unchanged — `seal()`, `createVault()`, instruction builders, and all exports remain identical. Protocol bindings can be regenerated locally via `pnpm codama:all`.

## 0.2.1

### Patch Changes

- [#171](https://github.com/Kaleb-Rupe/sigil/pull/171) [`853f965`](https://github.com/Kaleb-Rupe/sigil/commit/853f965fbd682ff9539b98b87ed5064b49ded5be) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix: audit fixes — active session guard, agent_transfer TOCTOU, SDK error codes

  **On-chain program changes:**
  - H-1: Add `active_sessions: u8` counter to AgentVault (SIZE 634→635). Incremented in `validate_and_authorize`, decremented in `finalize_session`. `close_vault` now requires `active_sessions == 0` — prevents vault closure while SPL delegation is active. New error: `ActiveSessionsExist` (6075).
  - M-1: Add `expected_policy_version: u64` parameter to `agent_transfer` with on-chain TOCTOU check via `PolicyVersionMismatch` (6072). Matches existing pattern in `validate_and_authorize`.
  - M-3: Document per-protocol cap simple-window limitation on `get_protocol_spend` and `record_protocol_spend`.

  **SDK changes (@usesigil/kit):**
  - Fix pre-existing error code off-by-1: removed ghost `TimelockActive` entry at code 6027 (deleted from on-chain program but still in SDK), renumbered 44 entries to match IDL.
  - Add 5 missing error codes: `TimelockTooShort` (6071), `PolicyVersionMismatch` (6072), `PendingAgentPermsExists` (6073), `PendingCloseConstraintsExists` (6074), `ActiveSessionsExist` (6075).
  - Fix `extractErrorCode()` bounds: `<= 6069` → `<= 6075`.
  - Codama regeneration: `agentTransfer` instruction gains `expectedPolicyVersion`, `validateAndAuthorize` vault now writable, `AgentVault` gains `activeSessions`.

  **Plugins (@usesigil/plugins):**
  - Patch for compatibility with updated `@usesigil/kit` types.

## 0.2.0

### Minor Changes

- [#169](https://github.com/Kaleb-Rupe/sigil/pull/169) [`926bb76`](https://github.com/Kaleb-Rupe/sigil/commit/926bb7683df4533249dd5b61a0a8d048ba62cfd2) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add OwnerClient DX convenience layer at `@usesigil/kit/dashboard`. Provides stateless, JSON-serializable owner-side vault management with 6 read functions, 23 mutations, and vault discovery. All amounts are raw bigint with toJSON() for MCP/REST serialization.

## 0.1.0

### Minor Changes

- Initial public release of the Sigil SDK — on-chain guardrails for AI agents on Solana.
