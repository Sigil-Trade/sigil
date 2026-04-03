---
"@usesigil/kit": patch
"@usesigil/plugins": patch
---

fix: audit fixes — active session guard, agent_transfer TOCTOU, SDK error codes

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
