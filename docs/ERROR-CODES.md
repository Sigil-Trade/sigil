# Error Codes (6000-6117)

All 118 custom errors defined in `programs/sigil/src/errors.rs`. Use `require!(condition, SigilError::Name)`.

Source of truth: `target/idl/sigil.json` (regenerate this file by running `bash scripts/regen-error-codes-doc.sh` after any change to `errors.rs`).

| Code | Name | Message |
| ---- | ---- | ------- |
| 6000 | `VaultNotActive` | Vault is not active |
| 6001 | `UnauthorizedAgent` | Unauthorized: signer is not the registered agent |
| 6002 | `UnauthorizedOwner` | Unauthorized: signer is not the vault owner |
| 6003 | `UnsupportedToken` | Token is not a supported stablecoin (only USDC and USDT) |
| 6004 | `ProtocolNotAllowed` | Protocol not allowed by policy |
| 6005 | `TransactionTooLarge` | Transaction exceeds maximum single transaction size |
| 6006 | `SpendingCapExceeded` | Rolling 24h spending cap would be exceeded |
| 6007 | `SessionNotAuthorized` | Session not authorized |
| 6008 | `InvalidSession` | Invalid session: does not belong to this vault |
| 6009 | `TooManyAllowedProtocols` | Policy configuration invalid: too many allowed protocols |
| 6010 | `AgentAlreadyRegistered` | Agent already registered for this vault |
| 6011 | `NoAgentRegistered` | No agent registered for this vault |
| 6012 | `VaultNotFrozen` | Vault is not frozen (expected frozen for reactivation) |
| 6013 | `VaultAlreadyClosed` | Vault is already closed |
| 6014 | `InsufficientBalance` | Insufficient vault balance for withdrawal |
| 6015 | `DeveloperFeeTooHigh` | Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS) |
| 6016 | `InvalidFeeDestination` | Fee destination account invalid |
| 6017 | `InvalidProtocolTreasury` | Protocol treasury account does not match expected address |
| 6018 | `InvalidAgentKey` | Invalid agent: cannot be the zero address |
| 6019 | `AgentIsOwner` | Invalid agent: agent cannot be the vault owner |
| 6020 | `Overflow` | Arithmetic overflow |
| 6021 | `InvalidTokenAccount` | Token account does not belong to vault or has wrong mint |
| 6022 | `TimelockNotExpired` | Timelock period has not expired yet |
| 6023 | `NoTimelockConfigured` | No timelock configured on this vault |
| 6024 | `DestinationNotAllowed` | Destination not in allowed list |
| 6025 | `TooManyDestinations` | Too many destinations (max 10) |
| 6026 | `InvalidProtocolMode` | Invalid protocol mode (must be 1 = ALLOWLIST) |
| 6027 | `CpiCallNotAllowed` | Instruction must be top-level (CPI calls not allowed) |
| 6028 | `MissingFinalizeInstruction` | Transaction must include finalize_session after validate |
| 6029 | `NonTrackedSwapMustReturnStablecoin` | Non-stablecoin swap must return stablecoin (balance did not increase) |
| 6030 | `UnauthorizedTokenTransfer` | Top-level SPL Token transfer not allowed between validate and finalize |
| 6031 | `SlippageBpsTooHigh` | Slippage BPS exceeds maximum (5000 = 50%) |
| 6032 | `ProtocolMismatch` | DeFi instruction program does not match declared target_protocol |
| 6033 | `TooManyDeFiInstructions` | Spending allows at most one DeFi instruction |
| 6034 | `MaxAgentsReached` | Maximum agents per vault reached (limit: 10) |
| 6035 | `InsufficientPermissions` | Agent lacks permission for this action type |
| 6036 | `InvalidPermissions` | Permission bitmask contains invalid bits |
| 6037 | `InvalidConstraintConfig` | Invalid constraint configuration: bounds exceeded |
| 6038 | `AgentSpendLimitExceeded` | Agent rolling 24h spend exceeds per-agent spending limit |
| 6039 | `OverlaySlotExhausted` | Per-agent overlay is full; cannot register agent with spending limit |
| 6040 | `AgentSlotNotFound` | Agent has per-agent spending limit but no overlay tracking slot |
| 6041 | `UnauthorizedTokenApproval` | Unauthorized SPL Token Approve between validate and finalize |
| 6042 | `InvalidSessionExpiry` | Session expiry seconds out of range (5-90) |
| 6043 | `ProtocolCapExceeded` | Per-protocol rolling 24h spending cap would be exceeded — LEGACY counter exhaustion path. New rolling-24h amount-based cap rejections use 6086 ErrDailyCapExceeded |
| 6044 | `ProtocolCapsMismatch` | protocol_caps length must match protocols length when has_protocol_caps is true |
| 6045 | `PendingPolicyExists` | Pending policy update must be applied or cancelled before closing vault |
| 6046 | `AgentPaused` | Agent is paused and cannot execute actions |
| 6047 | `AgentAlreadyPaused` | Agent is already paused |
| 6048 | `AgentNotPaused` | Agent is not paused |
| 6049 | `UnauthorizedPostFinalizeInstruction` | Instructions after finalize_session must be ComputeBudget or SystemProgram only |
| 6050 | `UnexpectedBalanceDecrease` | Vault balance decreased more than delegated amount — potential CPI attack |
| 6051 | `TimelockTooShort` | Timelock duration below minimum (1800 seconds / 30 minutes) |
| 6052 | `PolicyVersionMismatch` | Policy version mismatch — policy changed since agent's last RPC read |
| 6053 | `ActiveSessionsExist` | Cannot close vault with active sessions (finalize pending sessions first) |
| 6054 | `PostAssertionFailed` | Post-execution assertion failed: account state did not satisfy constraint |
| 6055 | `InvalidPostAssertionIndex` | Post-assertion constraint references invalid instruction index |
| 6056 | `UnauthorizedPreValidateInstruction` | Non-infrastructure instruction detected before validate_and_authorize |
| 6057 | `SnapshotNotCaptured` | Delta assertion snapshot was not captured in validate_and_authorize |
| 6058 | `InvalidConstraintOperator` | Constraint operator value is not a valid ConstraintOperator discriminant |
| 6059 | `ZeroCopyVaultMismatch` | Zero-copy account vault key mismatch (defense-in-depth) |
| 6060 | `QueuedUpdateExpired` | Queued update is too old (>MAX_APPLY_AGE_SLOTS / >MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN) — re-queue via the matching queue/initiate ix (queue_policy_update, queue_agent_permissions_update, queue_agent_grant, or initiate_ownership_transfer) to apply. Defends against durable-nonce pre-signing (CH-1 audit 2026-05-23 extended scope to timelocked-admin PDAs). |
| 6061 | `AccountWritabilityMismatch` | Account writability flag does not match constraint requirement |
| 6062 | `SysvarScanBoundExceeded` | Sysvar instruction scan exceeded the per-tx safety bound |
| 6063 | `AsyncFulfillmentNotPermitted` | Async-fulfillment program is not permitted in V1 (Jupiter Perps, Drift, Drift JIT). Spending cannot be measured because keeper submits the actual transfer in a separate transaction after finalize_session returns. |
| 6064 | `ConfidentialTransferBlocked` | Token-2022 ConfidentialTransfer not permitted between validate and finalize |
| 6065 | `PermanentDelegateBlocked` | Token-2022 PermanentDelegate not permitted between validate and finalize |
| 6066 | `TransferHookBlocked` | Token-2022 TransferHook not permitted between validate and finalize |
| 6067 | `LamportDrainBlocked` | Token-2022 destructive-balance ix (opcodes 38/45/46) not permitted between validate and finalize |
| 6068 | `BatchInstructionBlocked` | Token-2022 Batch instruction (opcode 255) is blocked outright — wraps inner instructions and bypasses byte-0 blocklist |
| 6069 | `InvalidDestinationMode` | Invalid destination mode (must be 0 = RESTRICTED) |
| 6070 | `InvalidCapability` | Invalid agent capability value (must be 0 = Disabled, 1 = Observer, or 2 = Operator) |
| 6071 | `PolicyPreviewMismatch` | Policy preview digest mismatch — caller's signed digest differs from recomputed canonical digest |
| 6072 | `ObserveOnlyModeBlocksExecute` | Vault is in observe_only mode — validate_and_authorize is blocked |
| 6073 | `ActiveVaultRequiresAllowlist` | Active (non-observe_only) vault must have at least one protocol or destination on the allowlist |
| 6074 | `ErrMintNotPinned` | Deposit mint is not a build-time-pinned stablecoin (USDC or USDT) |
| 6075 | `ErrOutsideOperatingHours` | Current UTC hour is outside the policy's operating_hours bitmask |
| 6076 | `ErrCooldownActive` | Agent cooldown period has not elapsed since the last action |
| 6077 | `ErrGraylistFriction` | Destination is graylisted (24h friction window — awaiting promote_graylist_destination or unlock) |
| 6078 | `ErrGraylistFull` | Destination graylist is full (max 10 entries) — wait for an existing entry to unlock or promote |
| 6079 | `ErrToken2022ExtensionForbidden` | Token-2022 mint has a forbidden extension (only MemoTransfer + MetadataPointer allowed) |
| 6080 | `ErrCosignRequired` | Elevated policy mutation requires an owner-signed cosigning session |
| 6081 | `ErrAutoRevoked` | Agent capability auto-revoked after consecutive policy-violation failures; owner must re-enable |
| 6082 | `ErrSandwichIntegrity` | Bundle integrity violation: multiple validate_and_authorize instructions for the same (vault, agent, mint) tuple in one transaction |
| 6083 | `ErrProtectedWritable` | Protected Sigil PDA passed as writable to a foreign instruction between validate and finalize |
| 6084 | `ErrSessionNonceMismatch` | Session nonce mismatch — caller's expected_nonce does not match the session's stored nonce (durable-nonce replay defense) |
| 6085 | `ErrStableFloorViolation` | Stable balance floor violated — combined USDC+USDT balance dropped below policy.stable_balance_floor |
| 6086 | `ErrDailyCapExceeded` | Per-protocol daily spending cap would be exceeded (rolling 24h) |
| 6087 | `ErrRecipientCapExceeded` | Per-recipient daily cap exceeded — recipient outflow would breach policy.per_recipient_daily_cap_usd within the rolling 24h window, or per_recipient array full with no expired slot to evict |
| 6088 | `ErrMintDeltaCapExceeded` | R-1 MintDeltaCap: vault-mint balance decreased by more than max_net_decrease |
| 6089 | `MintDeltaCapMisconfigured` | R-1 MintDeltaCap misconfigured — target account missing, mint mismatch, or owner not vault |
| 6090 | `ErrAtaAuthorityChanged` | R-2 AtaAuthorityPin: vault-owned token account authority changed or account closed/reinitialized mid-sandwich |
| 6091 | `ErrOutputBelowFloor` | R-3 OutputBalanceFloor: post-execution balance increase fell below the configured min_increase floor |
| 6092 | `ErrDeclarationInconsistent` | R-4 DeclarationConsistency: declared recipient/mint does not match CPI account-meta |
| 6093 | `IxMetaCountExceeded` | Foreign instruction exceeded the account-meta processing budget; the bundle is rejected rather than partially inspected |
| 6094 | `ErrPendingOwnershipExists` | An ownership transfer is already pending; cancel it first |
| 6095 | `ErrPendingOwnershipNotReady` | Ownership transfer timelock has not elapsed |
| 6096 | `ErrInvalidFreezeReason` | freeze_reason value out of {{0,1,2}} |
| 6097 | `ErrReactivateCooldownActive` | Reactivate requires 5-minute observation cooldown to elapse |
| 6098 | `ErrInvalidOwnershipTarget` | new_owner cannot be system/program/sysvar addresses (Council ISC-128) |
| 6099 | `ErrTooManyRevokePairs` | freeze_internal MAX_REVOKE_PAIRS = 10 exceeded (Council ISC-136) |
| 6100 | `ErrPostAssertionsNotClosed` | PostExecutionAssertions PDA still active — call close_post_assertions first |
| 6101 | `ErrDestinationIsProtectedPda` | Destination is a Sigil-protected PDA — rejected at queue time |
| 6102 | `ErrIntentDigestMismatch` | AL3 intent-digest mismatch — preview digest does not match executed bundle |
| 6103 | `ErrPendingAgentGrantDigestMismatch` | PendingAgentGrant digest mismatch between queue and apply |
| 6104 | `ErrReactivateCosignRequiredForFullCapability` | Reactivate with FULL_CAPABILITY new agent requires cosign |
| 6105 | `DestinationAccountUnresolvable` | Writable DeFi account could not be resolved in remaining_accounts — destination set incomplete |
| 6106 | `ErrToken2022OutputMintUnresolvable` | Vault-owned Token-2022 output ATA's mint is absent from remaining_accounts or not Token-2022-owned — cannot vet extensions |
| 6107 | `ErrOperatorGrantRequiresTimelock` | OPERATOR grant requires the timelock queue path on this vault — use queue_agent_grant |
| 6108 | `ErrOperatorGrantDelayTooLong` | operator_grant_delay_seconds exceeds the maximum (48h) — would brick grant applicability |
| 6109 | `InvalidOwnerType` | vault.owner_type is not a recognized discriminant (expected 0=EOA or 1=multisig) |
| 6110 | `SpendAccountingUnderflow` | finalize spend accounting underflow: collected fees exceed realized stablecoin outflow |
| 6111 | `ErrMultisigCustodyUnsupported` | Squads multisig ownership custody is not supported in V1 (use a standard EOA owner) |
| 6112 | `ErrOutputNotVaultOwned` | M1: stablecoin-input swap output must land in a vault-owned account and increase (value redirection / unacquired spend rejected) |
| 6113 | `ErrFinalizeMetaUnresolvable` | Finalize completeness: a writable DeFi account meta is absent from remaining_accounts (F-Q1b — omission would dodge per-recipient/output attribution) |
| 6114 | `ErrDeFiInstructionNotAdjacentToFinalize` | The counted DeFi instruction must sit immediately before finalize_session (no interleaved instruction) so finalize's attribution walks bind to the correct instruction |
| 6115 | `ErrUnmeasurableSpend` | Spending session produced no measurable in-transaction vault outcome (no stablecoin movement and no vault-owned acquisition) — async/keeper-settled or unmeasurable; recording 0 spend is rejected |
| 6116 | `ErrProgramDataUnresolvable` | Verified-build gate: the target protocol's ProgramData account is missing/unresolvable while a build hash is armed — cannot vet the deployed build (fail-closed) |
| 6117 | `ErrProgramBuildMismatch` | Verified-build gate: the target protocol's deployed ELF hash does not match the owner-pinned build hash — the on-chain build changed (re-pin via queue_policy_update after re-audit) |
