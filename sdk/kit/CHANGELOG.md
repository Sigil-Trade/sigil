# @usesigil/kit

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
