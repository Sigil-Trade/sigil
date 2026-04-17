# Error Codes (6000-6085)

All 85+ custom errors defined in `programs/sigil/src/errors.rs`. Use `require!(condition, SigilError::Name)`.

> **Source of truth:** `programs/sigil/src/errors.rs` — Anchor assigns codes sequentially from 6000 based on enum position. Always verify against the actual enum before relying on a specific numeric code (there was a transitional period where code-to-position mapping drifted in older docs).

| Code | Name | Category | Invoked In |
|------|------|----------|------------|
| 6000 | VaultNotActive | Vault state | validate_and_authorize, finalize_session, withdraw, agent_transfer, freeze_vault, create_escrow |
| 6001 | UnauthorizedAgent | Access control | validate_and_authorize, create_escrow, settle_escrow, refund_escrow, agent_transfer (Anchor constraints) |
| 6002 | UnauthorizedOwner | Access control | 20+ instructions via Anchor `has_one = owner` constraint |
| 6003 | UnsupportedToken | Stablecoin | validate_and_authorize, create_escrow, agent_transfer |
| 6004 | ProtocolNotAllowed | Policy | validate_and_authorize |
| 6005 | TransactionTooLarge | Policy | validate_and_authorize |
| 6006 | SpendingCapExceeded | Spending | validate_and_authorize, agent_transfer, finalize_session, create_escrow |
| 6007 | LeverageTooHigh | Policy | validate_and_authorize |
| 6008 | TooManyPositions | Policy | validate_and_authorize |
| 6009 | PositionOpeningDisallowed | Policy | validate_and_authorize |
| 6010 | SessionNotAuthorized | Session | finalize_session |
| 6011 | InvalidSession | Session | finalize_session (Anchor `has_one = vault`) |
| 6012 | OpenPositionsExist | Vault state | close_vault |
| 6013 | TooManyAllowedProtocols | Policy | update_policy, queue_policy_update, apply_policy_update |
| 6014 | AgentAlreadyRegistered | Vault state | register_agent |
| 6015 | NoAgentRegistered | Vault state | reactivate_vault |
| 6016 | VaultNotFrozen | Vault state | reactivate_vault |
| 6017 | VaultAlreadyClosed | Vault state | close_vault |
| 6018 | InsufficientBalance | Vault state | withdraw, agent_transfer |
| 6019 | DeveloperFeeTooHigh | Fee | initialize_vault |
| 6020 | InvalidFeeDestination | Fee | validate_and_authorize, agent_transfer, initialize_vault, create_escrow |
| 6021 | InvalidProtocolTreasury | Fee | validate_and_authorize, agent_transfer, create_escrow |
| 6022 | InvalidAgentKey | Validation | register_agent |
| 6023 | AgentIsOwner | Validation | register_agent |
| 6024 | Overflow | Arithmetic | 20+ files (all checked math) |
| 6025 | InvalidTokenAccount | Validation | validate_and_authorize, finalize_session, agent_transfer (Anchor constraints) |
| 6026 | TimelockNotExpired | Timelock | apply_policy_update, apply_constraints_update |
| 6027 | TimelockActive | Timelock | update_policy |
| 6028 | NoTimelockConfigured | Timelock | queue_policy_update, queue_constraints_update |
| 6029 | DestinationNotAllowed | Policy | validate_and_authorize, agent_transfer |
| 6030 | TooManyDestinations | Policy | update_policy, queue_policy_update, apply_policy_update |
| 6031 | InvalidProtocolMode | Validation | update_policy, queue_policy_update, apply_policy_update |
| 6032 | InvalidNonSpendingAmount | Validation | validate_and_authorize |
| 6033 | NoPositionsToClose | Vault state | validate_and_authorize |
| 6034 | CpiCallNotAllowed | Security | validate_and_authorize |
| 6035 | MissingFinalizeInstruction | Security | validate_and_authorize |
| 6036 | NonTrackedSwapMustReturnStablecoin | Stablecoin | finalize_session |
| 6037 | SwapSlippageExceeded | Stablecoin | validate_and_authorize (Jupiter verifier) |
| 6038 | InvalidJupiterInstruction | Integration | validate_and_authorize (Jupiter verifier) |
| 6039 | UnauthorizedTokenTransfer | Security | validate_and_authorize |
| 6040 | SlippageBpsTooHigh | Validation | update_policy, queue_policy_update, apply_policy_update |
| 6041 | ProtocolMismatch | Validation | validate_and_authorize |
| 6042 | TooManyDeFiInstructions | Security | validate_and_authorize |
| 6043 | MaxAgentsReached | Multi-agent | register_agent |
| 6044 | InsufficientPermissions | Multi-agent | validate_and_authorize |
| 6045 | InvalidPermissions | Multi-agent | register_agent, update_agent_permissions |
| 6046 | EscrowNotActive | Escrow | settle_escrow, refund_escrow |
| 6047 | EscrowExpired | Escrow | settle_escrow |
| 6048 | EscrowNotExpired | Escrow | refund_escrow |
| 6049 | InvalidEscrowVault | Escrow | create_escrow, settle_escrow, refund_escrow, close_settled_escrow (Anchor constraints) |
| 6050 | EscrowConditionsNotMet | Escrow | settle_escrow |
| 6051 | EscrowDurationExceeded | Escrow | create_escrow |
| 6052 | InvalidConstraintConfig | Constraints | set_instruction_constraints (via validate_entries) |
| 6053 | ConstraintViolated | Constraints | validate_and_authorize (generic constraints) |
| 6054 | InvalidConstraintsPda | Constraints | apply_constraints_update, queue_constraints_update, update_instruction_constraints (Anchor constraints) |
| 6055 | InvalidPendingConstraintsPda | Constraints | cancel_constraints_update, apply_constraints_update (Anchor constraints) |
| 6056 | AgentSpendLimitExceeded | Multi-agent | validate_and_authorize |
| 6057 | OverlaySlotExhausted | Multi-agent | agent_spend_overlay |
| 6058 | AgentSlotNotFound | Multi-agent | validate_and_authorize, agent_spend_overlay |
| 6059 | UnauthorizedTokenApproval | Security | validate_and_authorize |
| 6060 | InvalidSessionExpiry | Validation | validate_and_authorize |
| 6061 | UnconstrainedProgramBlocked | Constraints | validate_and_authorize (generic constraints) |
| 6062 | ProtocolCapExceeded | Spending | validate_and_authorize |
| 6063 | ProtocolCapsMismatch | Validation | update_policy, queue_policy_update, apply_policy_update |
| 6064 | ActiveEscrowsExist | Vault state | close_vault |
| 6065 | ConstraintsNotClosed | Vault state | close_vault |
| 6066 | PendingPolicyExists | Vault state | close_vault |
| 6067 | AgentPaused | Emergency | validate_and_authorize |
| 6068 | AgentAlreadyPaused | Emergency | pause_agent |
| 6069 | AgentNotPaused | Emergency | unpause_agent |
| 6070 | UnauthorizedPostFinalizeInstruction | Validation | finalize_session |
| 6071 | UnexpectedBalanceDecrease | Security | finalize_session |
| 6072 | TimelockTooShort | Timelock | initialize_vault, queue_policy_update, apply_pending_policy (MIN_TIMELOCK_DURATION = 1800s) |
| 6073 | PolicyVersionMismatch | TOCTOU | validate_and_authorize, agent_transfer (expected_policy_version check) |
| 6074 | PendingAgentPermsExists | Multi-agent | queue_agent_permissions_update |
| 6075 | PendingCloseConstraintsExists | Constraints | queue_close_constraints |
| 6076 | ActiveSessionsExist | Vault state | close_vault (blocks close if any SessionAuthority PDA open) |
| 6077 | PostAssertionFailed | Post-execution | finalize_session (Phase B assertion verification) |
| 6078 | InvalidPostAssertionIndex | Post-execution | finalize_session (assertion entry index out of bounds) |
| 6079 | UnauthorizedPreValidateInstruction | Validation | validate_and_authorize (non-infrastructure instruction before validate) |
| 6080 | SnapshotNotCaptured | Post-execution | finalize_session (delta assertion missing snapshot) |
| 6081 | ConstraintIndexOutOfBounds | Constraints | pack_entries, verify_against_entries_zc (zero-copy bounds) |
| 6082 | InvalidConstraintOperator | Constraints | validate_entries (ConstraintOperator discriminant check) |
| 6083 | ConstraintsVaultMismatch | Constraints | verify_against_entries_zc (zero-copy vault field mismatch) |
| 6084 | ConstraintEntryCountExceeded | Constraints | pack_entries (> MAX_CONSTRAINT_ENTRIES=64) |
| 6085 | BlockedSplOpcode | Security | validate_entries (Spl1 format blocks runtime-enforced SPL opcodes) |

## Changes from Previous (77 codes → 72 codes)

**Renamed (4):**
- 6003: TokenNotRegistered → UnsupportedToken
- 6006: DailyCapExceeded → SpendingCapExceeded
- 6037: SlippageTooHigh → SwapSlippageExceeded
- 6039: DustDepositDetected → UnauthorizedTokenTransfer (also renumbered from 6041)

**Removed (7 dead codes):**
- InvalidFlashTradeInstruction (was 6039) — Flash Trade verifier removed
- FlashTradePriceZero (was 6040) — Flash Trade verifier removed
- InvalidJupiterLendInstruction (was 6042) — Jupiter Lend verifier removed
- NoPendingConstraintsUpdate (was 6058) — Anchor handles implicitly
- PendingConstraintsUpdateExists (was 6059) — Anchor `init` handles implicitly
- ConstraintsUpdateNotExpired (was 6060) — Uses TimelockNotExpired (6026) instead
- ConstraintsUpdateExpired (was 6062) — Reserved, never implemented

All codes >= 6039 have been renumbered.

## TS Error Map Coverage

| Location | Codes Mapped |
|----------|-------------|
| `sdk/kit/src/simulation.ts` | 72/72 |
| `sdk/kit/src/agent-errors.ts` | 72/72 + 34 SDK |
| `sdk/kit/src/generated/errors/sigil.ts` | 72/72 |
| `target/idl/sigil.json` | 72/72 |
