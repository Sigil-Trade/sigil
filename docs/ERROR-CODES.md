# Error Codes (6000-6080)

All 81 custom errors defined in `programs/sigil/src/errors.rs`. Use `require!(condition, SigilError::Name)`.

> **Source of truth:** `sdk/kit/src/generated/errors/sigil.ts` — codama-generated from the canonical IDL (`target/idl/sigil.json`). Anchor assigns codes sequentially from 6000 based on enum position. Always verify against the generated file before relying on a specific numeric code.

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
| 6008 | SessionNotAuthorized | Session | finalize_session |
| 6009 | InvalidSession | Session | finalize_session (Anchor `has_one = vault`) |
| 6010 | TooManyAllowedProtocols | Policy | queue_policy_update, apply_policy_update |
| 6011 | AgentAlreadyRegistered | Vault state | register_agent |
| 6012 | NoAgentRegistered | Vault state | reactivate_vault |
| 6013 | VaultNotFrozen | Vault state | reactivate_vault |
| 6014 | VaultAlreadyClosed | Vault state | close_vault |
| 6015 | InsufficientBalance | Vault state | withdraw, agent_transfer |
| 6016 | DeveloperFeeTooHigh | Fee | initialize_vault |
| 6017 | InvalidFeeDestination | Fee | validate_and_authorize, agent_transfer, initialize_vault, create_escrow |
| 6018 | InvalidProtocolTreasury | Fee | validate_and_authorize, agent_transfer, create_escrow |
| 6019 | InvalidAgentKey | Validation | register_agent |
| 6020 | AgentIsOwner | Validation | register_agent |
| 6021 | Overflow | Arithmetic | 20+ files (all checked math) |
| 6022 | InvalidTokenAccount | Validation | validate_and_authorize, finalize_session, agent_transfer (Anchor constraints) |
| 6023 | TimelockNotExpired | Timelock | apply_policy_update, apply_constraints_update |
| 6024 | NoTimelockConfigured | Timelock | queue_policy_update, queue_constraints_update |
| 6025 | DestinationNotAllowed | Policy | validate_and_authorize, agent_transfer |
| 6026 | TooManyDestinations | Policy | queue_policy_update, apply_policy_update |
| 6027 | InvalidProtocolMode | Validation | queue_policy_update, apply_policy_update |
| 6028 | InvalidNonSpendingAmount | Validation | validate_and_authorize |
| 6029 | CpiCallNotAllowed | Security | validate_and_authorize |
| 6030 | MissingFinalizeInstruction | Security | validate_and_authorize |
| 6031 | NonTrackedSwapMustReturnStablecoin | Stablecoin | finalize_session |
| 6032 | SwapSlippageExceeded | Stablecoin | validate_and_authorize (Jupiter verifier) |
| 6033 | InvalidJupiterInstruction | Integration | validate_and_authorize (Jupiter verifier) |
| 6034 | UnauthorizedTokenTransfer | Security | validate_and_authorize |
| 6035 | SlippageBpsTooHigh | Validation | queue_policy_update, apply_policy_update |
| 6036 | ProtocolMismatch | Validation | validate_and_authorize |
| 6037 | TooManyDeFiInstructions | Security | validate_and_authorize |
| 6038 | MaxAgentsReached | Multi-agent | register_agent |
| 6039 | InsufficientPermissions | Multi-agent | validate_and_authorize |
| 6040 | InvalidPermissions | Multi-agent | register_agent, update_agent_permissions |
| 6041 | EscrowNotActive | Escrow | settle_escrow, refund_escrow |
| 6042 | EscrowExpired | Escrow | settle_escrow |
| 6043 | EscrowNotExpired | Escrow | refund_escrow |
| 6044 | InvalidEscrowVault | Escrow | create_escrow, settle_escrow, refund_escrow, close_settled_escrow (Anchor constraints) |
| 6045 | EscrowConditionsNotMet | Escrow | settle_escrow |
| 6046 | EscrowDurationExceeded | Escrow | create_escrow |
| 6047 | InvalidConstraintConfig | Constraints | create_instruction_constraints (via validate_entries) |
| 6048 | ConstraintViolated | Constraints | validate_and_authorize (generic constraints) |
| 6049 | InvalidConstraintsPda | Constraints | apply_constraints_update, queue_constraints_update (Anchor constraints) |
| 6050 | InvalidPendingConstraintsPda | Constraints | cancel_constraints_update, apply_constraints_update (Anchor constraints) |
| 6051 | AgentSpendLimitExceeded | Multi-agent | validate_and_authorize |
| 6052 | OverlaySlotExhausted | Multi-agent | agent_spend_overlay |
| 6053 | AgentSlotNotFound | Multi-agent | validate_and_authorize, agent_spend_overlay |
| 6054 | UnauthorizedTokenApproval | Security | validate_and_authorize |
| 6055 | InvalidSessionExpiry | Validation | validate_and_authorize |
| 6056 | UnconstrainedProgramBlocked | Constraints | validate_and_authorize (generic constraints) |
| 6057 | ProtocolCapExceeded | Spending | validate_and_authorize |
| 6058 | ProtocolCapsMismatch | Validation | queue_policy_update, apply_policy_update |
| 6059 | ActiveEscrowsExist | Vault state | close_vault |
| 6060 | ConstraintsNotClosed | Vault state | close_vault |
| 6061 | PendingPolicyExists | Vault state | close_vault |
| 6062 | AgentPaused | Emergency | validate_and_authorize |
| 6063 | AgentAlreadyPaused | Emergency | pause_agent |
| 6064 | AgentNotPaused | Emergency | unpause_agent |
| 6065 | UnauthorizedPostFinalizeInstruction | Validation | finalize_session |
| 6066 | UnexpectedBalanceDecrease | Security | finalize_session |
| 6067 | TimelockTooShort | Timelock | initialize_vault, queue_policy_update, apply_pending_policy (MIN_TIMELOCK_DURATION = 1800s) |
| 6068 | PolicyVersionMismatch | TOCTOU | validate_and_authorize, agent_transfer (expected_policy_version check) |
| 6069 | PendingAgentPermsExists | Multi-agent | queue_agent_permissions_update |
| 6070 | PendingCloseConstraintsExists | Constraints | queue_close_constraints |
| 6071 | ActiveSessionsExist | Vault state | close_vault (blocks close if any SessionAuthority PDA open) |
| 6072 | PostAssertionFailed | Post-execution | finalize_session (Phase B assertion verification) |
| 6073 | InvalidPostAssertionIndex | Post-execution | finalize_session (assertion entry index out of bounds) |
| 6074 | UnauthorizedPreValidateInstruction | Validation | validate_and_authorize (non-infrastructure instruction before validate) |
| 6075 | SnapshotNotCaptured | Post-execution | finalize_session (delta assertion missing snapshot) |
| 6076 | ConstraintIndexOutOfBounds | Constraints | pack_entries, verify_against_entries_zc (zero-copy bounds) |
| 6077 | InvalidConstraintOperator | Constraints | validate_entries (ConstraintOperator discriminant check) |
| 6078 | ConstraintsVaultMismatch | Constraints | verify_against_entries_zc (zero-copy vault field mismatch) |
| 6079 | ConstraintEntryCountExceeded | Constraints | pack_entries (> MAX_CONSTRAINT_ENTRIES=64) |
| 6080 | BlockedSplOpcode | Security | validate_entries (Spl1 format blocks runtime-enforced SPL opcodes) |

## TS Error Map Coverage

| Location | Codes Mapped |
|----------|-------------|
| `sdk/kit/src/simulation.ts` | 81/81 |
| `sdk/kit/src/agent-errors.ts` | 81/81 + 34 SDK |
| `sdk/kit/src/generated/errors/sigil.ts` | 81/81 (canonical) |
| `target/idl/sigil.json` | 81/81 |
