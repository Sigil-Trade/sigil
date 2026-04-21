# Error Codes (6000-6074)

All 75 custom errors defined in `programs/sigil/src/errors.rs`. Use `require!(condition, SigilError::Name)`.

Source of truth: `target/idl/sigil.json` (regenerate this file with `node scripts/regen-error-codes-doc.js` after any change to `errors.rs`).

| Code | Name                                  | Message                                                                         |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 6000 | `VaultNotActive`                      | Vault is not active                                                             |
| 6001 | `UnauthorizedAgent`                   | Unauthorized: signer is not the registered agent                                |
| 6002 | `UnauthorizedOwner`                   | Unauthorized: signer is not the vault owner                                     |
| 6003 | `UnsupportedToken`                    | Token is not a supported stablecoin (only USDC and USDT)                        |
| 6004 | `ProtocolNotAllowed`                  | Protocol not allowed by policy                                                  |
| 6005 | `TransactionTooLarge`                 | Transaction exceeds maximum single transaction size                             |
| 6006 | `SpendingCapExceeded`                 | Rolling 24h spending cap would be exceeded                                      |
| 6007 | `SessionNotAuthorized`                | Session not authorized                                                          |
| 6008 | `InvalidSession`                      | Invalid session: does not belong to this vault                                  |
| 6009 | `TooManyAllowedProtocols`             | Policy configuration invalid: too many allowed protocols                        |
| 6010 | `AgentAlreadyRegistered`              | Agent already registered for this vault                                         |
| 6011 | `NoAgentRegistered`                   | No agent registered for this vault                                              |
| 6012 | `VaultNotFrozen`                      | Vault is not frozen (expected frozen for reactivation)                          |
| 6013 | `VaultAlreadyClosed`                  | Vault is already closed                                                         |
| 6014 | `InsufficientBalance`                 | Insufficient vault balance for withdrawal                                       |
| 6015 | `DeveloperFeeTooHigh`                 | Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)                    |
| 6016 | `InvalidFeeDestination`               | Fee destination account invalid                                                 |
| 6017 | `InvalidProtocolTreasury`             | Protocol treasury account does not match expected address                       |
| 6018 | `InvalidAgentKey`                     | Invalid agent: cannot be the zero address                                       |
| 6019 | `AgentIsOwner`                        | Invalid agent: agent cannot be the vault owner                                  |
| 6020 | `Overflow`                            | Arithmetic overflow                                                             |
| 6021 | `InvalidTokenAccount`                 | Token account does not belong to vault or has wrong mint                        |
| 6022 | `TimelockNotExpired`                  | Timelock period has not expired yet                                             |
| 6023 | `NoTimelockConfigured`                | No timelock configured on this vault                                            |
| 6024 | `DestinationNotAllowed`               | Destination not in allowed list                                                 |
| 6025 | `TooManyDestinations`                 | Too many destinations (max 10)                                                  |
| 6026 | `InvalidProtocolMode`                 | Invalid protocol mode (must be 0, 1, or 2)                                      |
| 6027 | `CpiCallNotAllowed`                   | Instruction must be top-level (CPI calls not allowed)                           |
| 6028 | `MissingFinalizeInstruction`          | Transaction must include finalize_session after validate                        |
| 6029 | `NonTrackedSwapMustReturnStablecoin`  | Non-stablecoin swap must return stablecoin (balance did not increase)           |
| 6030 | `SwapSlippageExceeded`                | Swap slippage exceeds policy max_slippage_bps or quoted output is zero          |
| 6031 | `InvalidJupiterInstruction`           | Cannot parse Jupiter swap instruction data                                      |
| 6032 | `UnauthorizedTokenTransfer`           | Top-level SPL Token transfer not allowed between validate and finalize          |
| 6033 | `SlippageBpsTooHigh`                  | Slippage BPS exceeds maximum (5000 = 50%)                                       |
| 6034 | `ProtocolMismatch`                    | DeFi instruction program does not match declared target_protocol                |
| 6035 | `TooManyDeFiInstructions`             | Spending allows at most one DeFi instruction                                    |
| 6036 | `MaxAgentsReached`                    | Maximum agents per vault reached (limit: 10)                                    |
| 6037 | `InsufficientPermissions`             | Agent lacks permission for this action type                                     |
| 6038 | `InvalidPermissions`                  | Permission bitmask contains invalid bits                                        |
| 6039 | `EscrowNotActive`                     | Escrow is not in Active status                                                  |
| 6040 | `EscrowExpired`                       | Escrow has expired                                                              |
| 6041 | `EscrowNotExpired`                    | Escrow has not expired yet                                                      |
| 6042 | `InvalidEscrowVault`                  | Invalid escrow vault                                                            |
| 6043 | `EscrowConditionsNotMet`              | Escrow conditions not met                                                       |
| 6044 | `EscrowDurationExceeded`              | Escrow duration exceeds maximum (30 days)                                       |
| 6045 | `InvalidConstraintConfig`             | Invalid constraint configuration: bounds exceeded                               |
| 6046 | `ConstraintViolated`                  | Instruction constraint violated                                                 |
| 6047 | `InvalidConstraintsPda`               | Invalid constraints PDA: wrong owner or vault                                   |
| 6048 | `InvalidPendingConstraintsPda`        | Invalid pending constraints PDA: wrong owner or vault                           |
| 6049 | `AgentSpendLimitExceeded`             | Agent rolling 24h spend exceeds per-agent spending limit                        |
| 6050 | `OverlaySlotExhausted`                | Per-agent overlay is full; cannot register agent with spending limit            |
| 6051 | `AgentSlotNotFound`                   | Agent has per-agent spending limit but no overlay tracking slot                 |
| 6052 | `UnauthorizedTokenApproval`           | Unauthorized SPL Token Approve between validate and finalize                    |
| 6053 | `InvalidSessionExpiry`                | Session expiry slots out of range (10-450)                                      |
| 6054 | `UnconstrainedProgramBlocked`         | Program has no constraint entry and strict mode is enabled                      |
| 6055 | `ProtocolCapExceeded`                 | Per-protocol rolling 24h spending cap would be exceeded                         |
| 6056 | `ProtocolCapsMismatch`                | protocol_caps length must match protocols length when has_protocol_caps is true |
| 6057 | `ActiveEscrowsExist`                  | Cannot close vault with active escrow deposits                                  |
| 6058 | `ConstraintsNotClosed`                | Instruction constraints must be closed before closing vault                     |
| 6059 | `PendingPolicyExists`                 | Pending policy update must be applied or cancelled before closing vault         |
| 6060 | `AgentPaused`                         | Agent is paused and cannot execute actions                                      |
| 6061 | `AgentAlreadyPaused`                  | Agent is already paused                                                         |
| 6062 | `AgentNotPaused`                      | Agent is not paused                                                             |
| 6063 | `UnauthorizedPostFinalizeInstruction` | Instructions after finalize_session must be ComputeBudget or SystemProgram only |
| 6064 | `UnexpectedBalanceDecrease`           | Vault balance decreased more than delegated amount — potential CPI attack       |
| 6065 | `TimelockTooShort`                    | Timelock duration below minimum (1800 seconds / 30 minutes)                     |
| 6066 | `PolicyVersionMismatch`               | Policy version mismatch — policy changed since agent's last RPC read            |
| 6067 | `ActiveSessionsExist`                 | Cannot close vault with active sessions (finalize pending sessions first)       |
| 6068 | `PostAssertionFailed`                 | Post-execution assertion failed: account state did not satisfy constraint       |
| 6069 | `InvalidPostAssertionIndex`           | Post-assertion constraint references invalid instruction index                  |
| 6070 | `UnauthorizedPreValidateInstruction`  | Non-infrastructure instruction detected before validate_and_authorize           |
| 6071 | `SnapshotNotCaptured`                 | Delta assertion snapshot was not captured in validate_and_authorize             |
| 6072 | `InvalidConstraintOperator`           | Constraint operator value is not a valid ConstraintOperator discriminant        |
| 6073 | `ConstraintsVaultMismatch`            | Zero-copy constraints account has wrong vault                                   |
| 6074 | `BlockedSplOpcode`                    | SPL opcode is blocked at runtime and cannot be used in constraints              |

---

## TS Error Map Coverage

All 75 codes mapped in:

- `sdk/kit/src/simulation.ts` (diagnostic suggestions)
- `sdk/kit/src/agent-errors.ts` (structured `AgentError` with category + retryability)
- `sdk/kit/src/generated/errors/sigil.ts` (Codama-generated hex constants)
- `sdk/kit/src/testing/errors/names.generated.ts` (IDL-driven canonical map)
- `tests/helpers/strict-errors.ts` (inlined LiteSVM shim — verified by CI drift check)

Drift between sources is caught by `pnpm run verify:error-drift` in CI.
