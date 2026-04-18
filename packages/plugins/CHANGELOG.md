# @usesigil/plugins

## 8.0.0

### Patch Changes

- Updated dependencies [[`85c64c6`](https://github.com/Sigil-Trade/sigil/commit/85c64c66db7afda16a98c11b885ba7d4d6bb2021)]:
  - @usesigil/kit@0.10.0

## 7.0.0

### Patch Changes

- Updated dependencies [[`2c73c71`](https://github.com/Sigil-Trade/sigil/commit/2c73c710236d248ef51bc875e9bb1ff5dd5e0e92)]:
  - @usesigil/kit@0.8.0

## 6.0.1

### Patch Changes

- Updated dependencies [[`84163f8`](https://github.com/Sigil-Trade/sigil/commit/84163f83c07b1454afc0f7dd0a9bef27cae3ae97)]:
  - @usesigil/kit@0.7.1

## 6.0.0

### Patch Changes

- Updated dependencies [[`bab2ea0`](https://github.com/Sigil-Trade/sigil/commit/bab2ea0583135c147a3c3af10bb15be714814fec)]:
  - @usesigil/kit@0.7.0

## 5.0.0

### Patch Changes

- Updated dependencies [[`06eb0d8`](https://github.com/Sigil-Trade/sigil/commit/06eb0d890aef7e91efa8555909cb1f186e381ccb)]:
  - @usesigil/kit@0.6.0

## 4.0.0

### Patch Changes

- Updated dependencies [[`06e2e3b`](https://github.com/Sigil-Trade/sigil/commit/06e2e3b62ba7a13ee6a11eb9f175311ad114291d)]:
  - @usesigil/kit@0.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [[`1ed3499`](https://github.com/Sigil-Trade/sigil/commit/1ed3499f04e55d97e4906bac9c7dbd8a452e7737)]:
  - @usesigil/kit@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [[`d11d0e3`](https://github.com/Sigil-Trade/sigil/commit/d11d0e34cca1c83d17f6fb144470a5dde332e4e5)]:
  - @usesigil/kit@0.3.0

## 1.0.3

### Patch Changes

- Updated dependencies [[`4209b98`](https://github.com/Sigil-Trade/sigil/commit/4209b98de517acd95fee08be366b8d1b2e03a4b4)]:
  - @usesigil/kit@0.2.3

## 1.0.2

### Patch Changes

- Updated dependencies [[`f9f874c`](https://github.com/Kaleb-Rupe/sigil/commit/f9f874c877979219dc7d5d7d3cd6ef27d0c443c1)]:
  - @usesigil/kit@0.2.2

## 1.0.1

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

- Updated dependencies [[`853f965`](https://github.com/Kaleb-Rupe/sigil/commit/853f965fbd682ff9539b98b87ed5064b49ded5be)]:
  - @usesigil/kit@0.2.1

## 1.0.0

### Patch Changes

- Updated dependencies [[`926bb76`](https://github.com/Kaleb-Rupe/sigil/commit/926bb7683df4533249dd5b61a0a8d048ba62cfd2)]:
  - @usesigil/kit@0.2.0

## 1.0.0

### Minor Changes

- Initial public release of the Sigil SDK — on-chain guardrails for AI agents on Solana.

### Patch Changes

- Updated dependencies []:
  - @usesigil/kit@0.1.0
