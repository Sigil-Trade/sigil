use anchor_lang::prelude::*;

#[error_code]
pub enum SigilError {
    #[msg("Vault is not active")]
    VaultNotActive,

    #[msg("Unauthorized: signer is not the registered agent")]
    UnauthorizedAgent,

    #[msg("Unauthorized: signer is not the vault owner")]
    UnauthorizedOwner,

    #[msg("Token is not a supported stablecoin (only USDC and USDT)")]
    UnsupportedToken,

    #[msg("Protocol not allowed by policy")]
    ProtocolNotAllowed,

    #[msg("Transaction exceeds maximum single transaction size")]
    TransactionTooLarge,

    #[msg("Rolling 24h spending cap would be exceeded")]
    SpendingCapExceeded,

    #[msg("Session not authorized")]
    SessionNotAuthorized,

    #[msg("Invalid session: does not belong to this vault")]
    InvalidSession,

    #[msg("Policy configuration invalid: too many allowed protocols")]
    TooManyAllowedProtocols,

    #[msg("Agent already registered for this vault")]
    AgentAlreadyRegistered,

    #[msg("No agent registered for this vault")]
    NoAgentRegistered,

    #[msg("Vault is not frozen (expected frozen for reactivation)")]
    VaultNotFrozen,

    #[msg("Vault is already closed")]
    VaultAlreadyClosed,

    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientBalance,

    #[msg("Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)")]
    DeveloperFeeTooHigh,

    #[msg("Fee destination account invalid")]
    InvalidFeeDestination,

    #[msg("Protocol treasury account does not match expected address")]
    InvalidProtocolTreasury,

    #[msg("Invalid agent: cannot be the zero address")]
    InvalidAgentKey,

    #[msg("Invalid agent: agent cannot be the vault owner")]
    AgentIsOwner,

    #[msg("Arithmetic overflow")]
    Overflow,

    // --- Validation errors ---
    #[msg("Token account does not belong to vault or has wrong mint")]
    InvalidTokenAccount,

    // --- Timelock + Destination errors ---
    #[msg("Timelock period has not expired yet")]
    TimelockNotExpired,

    // TimelockActive removed — the 4 direct-mutation instructions that used it are deleted.
    // All mutations now route through queue/apply with mandatory timelock.
    #[msg("No timelock configured on this vault")]
    NoTimelockConfigured,

    #[msg("Destination not in allowed list")]
    DestinationNotAllowed,

    #[msg("Too many destinations (max 10)")]
    TooManyDestinations,

    #[msg("Invalid protocol mode (must be 1 = ALLOWLIST)")]
    InvalidProtocolMode,

    // --- Transaction validation errors ---
    #[msg("Instruction must be top-level (CPI calls not allowed)")]
    CpiCallNotAllowed,

    #[msg("Transaction must include finalize_session after validate")]
    MissingFinalizeInstruction,

    // --- Stablecoin-only enforcement errors ---
    #[msg("Non-stablecoin swap must return stablecoin (balance did not increase)")]
    NonTrackedSwapMustReturnStablecoin,

    // SwapSlippageExceeded (was 6030) DELETED in Phase 1 Option A demolition —
    // on-chain Jupiter slippage verifier removed. The generic
    // `policy.max_slippage_bps` config primitive is preserved (D-5); runtime
    // slippage enforcement moves to off-chain SDK simulators / Phase 6
    // post-execution assertions.
    //
    // InvalidJupiterInstruction (was 6031) DELETED in Phase 1 Option A demolition —
    // Jupiter swap instruction parser removed entirely.
    #[msg("Top-level SPL Token transfer not allowed between validate and finalize")]
    UnauthorizedTokenTransfer,

    #[msg("Slippage BPS exceeds maximum (5000 = 50%)")]
    SlippageBpsTooHigh,

    #[msg("DeFi instruction program does not match declared target_protocol")]
    ProtocolMismatch,

    #[msg("Spending allows at most one DeFi instruction")]
    TooManyDeFiInstructions,

    // --- Multi-Agent errors ---
    #[msg("Maximum agents per vault reached (limit: 10)")]
    MaxAgentsReached,

    #[msg("Agent lacks permission for this action type")]
    InsufficientPermissions,

    #[msg("Permission bitmask contains invalid bits")]
    InvalidPermissions,

    // --- Instruction constraints errors ---
    #[msg("Invalid constraint configuration: bounds exceeded")]
    InvalidConstraintConfig,

    // --- M1-04 constraints-engine teardown: 10 error variants REMOVED ---
    // ConstraintViolated, InvalidConstraintsPda, InvalidPendingConstraintsPda,
    // UnconstrainedProgramBlocked, ConstraintsNotClosed, BlockedSplOpcode,
    // ConstraintsAlreadyPopulated, OrphanPdaWrongOwner, OrphanPdaPopulated,
    // ErrPendingConstraintsDigestMismatch were removed when the instruction-
    // data-parsing constraints engine was deleted (M1-04 Steps 1-5). The enum
    // was renumbered (positional); subsequent codes shifted down. The kept
    // agnostic post-execution-assertion errors (InvalidConstraintConfig,
    // InvalidConstraintOperator, ZeroCopyVaultMismatch) are RETAINED below.

    // --- Per-agent spend limit errors ---
    #[msg("Agent rolling 24h spend exceeds per-agent spending limit")]
    AgentSpendLimitExceeded,

    #[msg("Per-agent overlay is full; cannot register agent with spending limit")]
    OverlaySlotExhausted,

    #[msg("Agent has per-agent spending limit but no overlay tracking slot")]
    AgentSlotNotFound,

    #[msg("Unauthorized SPL Token Approve between validate and finalize")]
    UnauthorizedTokenApproval,

    #[msg("Session expiry seconds out of range (5-90)")]
    InvalidSessionExpiry,

    // --- Per-protocol spend cap errors ---
    //
    // M-5 semantic distinction (audit 2026-05-19): two related-but-distinct
    // protocol-cap error codes exist. Both are protocol-spending failures,
    // but the surface is different:
    //
    // - 6043 `ProtocolCapExceeded` (THIS) — LEGACY counter exhaustion path.
    //   Fires when the per-protocol counter slot bookkeeping itself runs
    //   out of capacity (the `protocol_counters` array slot for the protocol
    //   is exhausted). Pre-Phase-5 this was the ONLY per-protocol error;
    //   off-chain monitors + SDK telemetry pin to this code for that path.
    //   Kept for backward compatibility — do NOT migrate away from this
    //   code at the existing call sites.
    //
    // - 6086 `ErrDailyCapExceeded` (below, in Phase 5 block) — the modern
    //   per-protocol rolling-24h SPEND-CAP path. Fires when the rolling 24h
    //   accumulated USD spend for the protocol PLUS the current transaction
    //   would exceed `policy.protocol_caps[i]`. This is the new amount-
    //   based bound; 6043 is the legacy capacity-based bound.
    #[msg("Per-protocol rolling 24h spending cap would be exceeded — LEGACY counter exhaustion path. New rolling-24h amount-based cap rejections use 6086 ErrDailyCapExceeded")]
    ProtocolCapExceeded,

    #[msg("protocol_caps length must match protocols length when has_protocol_caps is true")]
    ProtocolCapsMismatch,

    // --- Vault cleanup guard errors ---
    #[msg("Pending policy update must be applied or cancelled before closing vault")]
    PendingPolicyExists,

    // --- Emergency response errors ---
    #[msg("Agent is paused and cannot execute actions")]
    AgentPaused,

    #[msg("Agent is already paused")]
    AgentAlreadyPaused,

    #[msg("Agent is not paused")]
    AgentNotPaused,

    // --- Post-finalize instruction check ---
    #[msg("Instructions after finalize_session must be ComputeBudget or SystemProgram only")]
    UnauthorizedPostFinalizeInstruction,

    // --- CPI balance audit ---
    #[msg("Vault balance decreased more than delegated amount — potential CPI attack")]
    UnexpectedBalanceDecrease,

    // --- TOCTOU fix: mandatory timelock + policy versioning ---
    #[msg("Timelock duration below minimum (1800 seconds / 30 minutes)")]
    TimelockTooShort,

    #[msg("Policy version mismatch — policy changed since agent's last RPC read")]
    PolicyVersionMismatch,

    #[msg("Cannot close vault with active sessions (finalize pending sessions first)")]
    ActiveSessionsExist,

    // --- Post-execution assertions (Phase B scaffolding) ---
    #[msg("Post-execution assertion failed: account state did not satisfy constraint")]
    PostAssertionFailed,

    #[msg("Post-assertion constraint references invalid instruction index")]
    InvalidPostAssertionIndex,

    #[msg("Non-infrastructure instruction detected before validate_and_authorize")]
    UnauthorizedPreValidateInstruction,

    #[msg("Delta assertion snapshot was not captured in validate_and_authorize")]
    SnapshotNotCaptured,

    #[msg("Constraint operator value is not a valid ConstraintOperator discriminant")]
    InvalidConstraintOperator,

    /// General-purpose zero-copy / `has_one = vault` key-mismatch guard, used
    /// across the AuditLog paths and ~25 owner/agent handlers (ownership
    /// transfer, deposit/withdraw, register/revoke/pause agent, finalize,
    /// apply_pending_policy, …). The PDA seeds derivation makes the wrong-vault
    /// case unreachable in practice; this variant exists as defense-in-depth.
    /// Variant renamed from `ConstraintsVaultMismatch` in §RP-2 HIGH-3; was
    /// error code 6064 at that fix, renumbered to 6059 in the M1-04 teardown.
    #[msg("Zero-copy account vault key mismatch (defense-in-depth)")]
    ZeroCopyVaultMismatch,

    // --- F-10 audit fix: durable-nonce pre-signing defense ---
    #[msg("Queued update is too old (>MAX_APPLY_AGE_SLOTS / >MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN) — re-queue via the matching queue/initiate ix (queue_policy_update, queue_agent_permissions_update, queue_agent_grant, or initiate_ownership_transfer) to apply. Defends against durable-nonce pre-signing (CH-1 audit 2026-05-23 extended scope to timelocked-admin PDAs).")]
    QueuedUpdateExpired,

    // --- M5: Squads SAP parity — account writability enforcement ---
    /// DEPRECATED (foundation review 2026-06-29): unreachable — writability
    /// enforcement is covered by `ErrProtectedWritable` (6083). Retained for
    /// append-only error-code stability; never renumber or remove.
    #[msg("Account writability flag does not match constraint requirement")]
    AccountWritabilityMismatch,

    // --- M11 SIMD-0296 pad-attack DoS guard ---
    #[msg("Sysvar instruction scan exceeded the per-tx safety bound")]
    SysvarScanBoundExceeded,

    // --- C4 audit fix: async-fulfillment programs ---
    #[msg("Async-fulfillment program is not permitted in V1 (Jupiter Perps, Drift, Drift JIT). Spending cannot be measured because keeper submits the actual transfer in a separate transaction after finalize_session returns.")]
    AsyncFulfillmentNotPermitted,

    // --- Token-2022 ConfidentialTransfer block (M3) ---
    #[msg("Token-2022 ConfidentialTransfer not permitted between validate and finalize")]
    ConfidentialTransferBlocked,

    // --- Token-2022 follow-up blocks (Pentester HIGH/MED) ---
    // Opcodes 35/36/38/42/45 — see validate_and_authorize.rs Token-2022 match arm.
    #[msg("Token-2022 PermanentDelegate not permitted between validate and finalize")]
    PermanentDelegateBlocked,

    #[msg("Token-2022 TransferHook not permitted between validate and finalize")]
    TransferHookBlocked,

    #[msg("Token-2022 destructive-balance ix (opcodes 38/45/46) not permitted between validate and finalize")]
    LamportDrainBlocked,

    // --- Token-2022 third-pass audit additions ---
    #[msg("Token-2022 Batch instruction (opcode 255) is blocked outright — wraps inner instructions and bypasses byte-0 blocklist")]
    BatchInstructionBlocked,

    // --- F-4 audit fix: explicit destination mode ---
    // Phase 2 (Option A default-tightening): only RESTRICTED is permitted.
    // OPEN_WITH_CAP path deleted; #[msg] tightened to reflect new contract.
    #[msg("Invalid destination mode (must be 0 = RESTRICTED)")]
    InvalidDestinationMode,

    // --- Phase 2 additions (TA-04 + TA-19) ---
    // Appended at the END of the enum to preserve existing error codes 6000-6069.
    /// 6070 — TA-04: Reserved AgentEntry.capability values 3..=255 explicitly
    /// rejected at register/queue/apply. Replaces the prior silent zero-coerce
    /// behaviour (values >2 were treated as 0 by `has_capability`).
    #[msg("Invalid agent capability value (must be 0 = Disabled, 1 = Observer, or 2 = Operator)")]
    InvalidCapability,

    /// 6071 — TA-19: SHA-256 digest of canonical policy preview encoding does
    /// not match recomputed digest. Indicates owner-signer compromise or
    /// pending-PDA tampering between queue and apply. Hard reject.
    #[msg("Policy preview digest mismatch — caller's signed digest differs from recomputed canonical digest")]
    PolicyPreviewMismatch,

    /// 6072 — TA-19: observe_only vault rejects all `validate_and_authorize`
    /// calls. Owners stand up observe-only vaults to baseline agent behaviour
    /// before opening the execute path.
    #[msg("Vault is in observe_only mode — validate_and_authorize is blocked")]
    ObserveOnlyModeBlocksExecute,

    /// 6073 — F-11 audit fix: an active (non-observe_only) vault must have at
    /// least ONE protocol on the allowlist OR at least ONE destination on the
    /// allowlist. Otherwise the vault is silently inert — accepts deposits but
    /// can never authorize any spending action. observe_only vaults are
    /// explicitly inert by design, so this check is skipped for them.
    #[msg("Active (non-observe_only) vault must have at least one protocol or destination on the allowlist")]
    ActiveVaultRequiresAllowlist,

    // --- Phase 3 (Option A pre-execution guards TA-03/05/06/07/08/09/17) ---
    // Appended at END to preserve existing error codes 6000-6073.
    /// 6074 — TA-03: deposit mint must be a build-time-pinned stablecoin
    /// (USDC or USDT). With `devnet-testing` feature, any mint accepted.
    /// Rejects exotic / hostile / typosquatted mints at the entry point so
    /// downstream balance-delta logic in `finalize_session` cannot be evaded
    /// by depositing a token whose `is_stablecoin_mint` test returns false.
    #[msg("Deposit mint is not a build-time-pinned stablecoin (USDC or USDT)")]
    ErrMintNotPinned,

    /// 6075 — TA-05: operating_hours UTC bitmask rejects the current hour.
    /// `operating_hours` is a 24-bit bitmask (bit `n` = hour `n` UTC). Default
    /// 0xFFFFFF (all 24h enabled); owner narrows for agents that should only
    /// run during business hours / market hours.
    #[msg("Current UTC hour is outside the policy's operating_hours bitmask")]
    ErrOutsideOperatingHours,

    /// 6076 — TA-06: per-agent cooldown active. Per-agent (NOT per-vault per
    /// F-16) — a per-vault cooldown would let one agent's traffic DoS all
    /// other agents on the vault. Stored on `AgentSpendOverlay` per slot;
    /// `last_action_unix` rewritten on successful `validate_and_authorize`.
    #[msg("Agent cooldown period has not elapsed since the last action")]
    ErrCooldownActive,

    /// 6077 — TA-07: first-time-destination 24h graylist friction. New
    /// destinations added to the allowlist enter a graylist with
    /// `unlock_unix = now + 86400`. Until the unlock time elapses (or the
    /// owner promotes the entry via `promote_graylist_destination`), spend
    /// paths reject any tx routing value to that destination.
    #[msg("Destination is graylisted (24h friction window — awaiting promote_graylist_destination or unlock)")]
    ErrGraylistFriction,

    /// 6078 — TA-07: graylist bound exceeded. `destination_graylist` is
    /// bounded ≤10 entries to keep PolicyConfig SIZE deterministic. When
    /// full, additional allowlist adds must wait for an existing entry to
    /// unlock or be promoted.
    #[msg("Destination graylist is full (max 10 entries) — wait for an existing entry to unlock or promote")]
    ErrGraylistFull,

    /// 6079 — TA-08: Token-2022 extension blocked. Deposit allowlists exactly
    /// 2 extensions (MemoTransfer, MetadataPointer). Anything else — including
    /// NonTransferable (F-Q4 removed it: a mint a vault acquires but could
    /// never move out is a custody trap) and future-added extensions — rejects
    /// with this code. Forward-secure: unknown extension type IDs reject (do
    /// not skip).
    #[msg(
        "Token-2022 mint has a forbidden extension (only MemoTransfer + MetadataPointer allowed)"
    )]
    ErrToken2022ExtensionForbidden,

    /// 6080 — TA-09: cosign required for elevated policy mutations. Raising
    /// daily_spending_cap_usd, raising max_transaction_size_usd, expanding
    /// allowed_destinations / allowed_protocols, lowering stable_balance_floor,
    /// or pre-graylist-bypass adds require an owner-signed session co-signature
    /// alongside the owner. Scope: any session signed by the owner within the
    /// vault's validity window (D-2 default).
    #[msg("Elevated policy mutation requires an owner-signed cosigning session")]
    ErrCosignRequired,

    /// 6081 — TA-17: agent auto-revoked after `auto_revoke_threshold`
    /// consecutive policy-violation failures. Only on-chain policy-violation
    /// codes (6074-6091) count; external causes (CU exhaustion, nonce desync,
    /// auth errors) do NOT increment. Owner re-enables via existing
    /// `queue_agent_permissions_update`.
    #[msg("Agent capability auto-revoked after consecutive policy-violation failures; owner must re-enable")]
    ErrAutoRevoked,

    // --- Phase 4 (bundle integrity TA-10 + TA-11 + AC-10) ---
    // Appended at END to preserve existing error codes 6000-6081.
    /// 6082 — TA-10: sandwich-integrity uniqueness. At most ONE
    /// `validate_and_authorize` instruction may exist per (vault, agent,
    /// mint) tuple per transaction. Multiple validates against the same
    /// tuple would let an attacker stage a second authorization sandwich
    /// inside the first (using the second session's expanded capability)
    /// before the first finalize revokes the SPL delegation. Reject at the
    /// entry guard.
    #[msg("Bundle integrity violation: multiple validate_and_authorize instructions for the same (vault, agent, mint) tuple in one transaction")]
    ErrSandwichIntegrity,

    /// 6083 — TA-11: writable Sigil-owned PDA in a foreign instruction
    /// between validate and finalize. The DYNAMIC seed-prefix family check
    /// derives every protected PDA family from `PROTECTED_SEED_PREFIXES`
    /// and rejects when a foreign instruction passes any such PDA with
    /// `is_writable=true`. Per F-20 + F-30, the on-chain `account.owner`
    /// check provides defense-in-depth against discriminator-spoofing
    /// from attacker-deployed programs.
    #[msg("Protected Sigil PDA passed as writable to a foreign instruction between validate and finalize")]
    ErrProtectedWritable,

    /// 6084 — AC-10: session nonce mismatch. The caller's `expected_nonce`
    /// argument does not match the session's stored nonce. Closes the
    /// durable-nonce pre-signing replay class for in-flight sessions
    /// (per Audit #1 C-1). Phase 8 ownership-transfer replay protection
    /// (M-5) reuses the same field semantics.
    #[msg("Session nonce mismatch — caller's expected_nonce does not match the session's stored nonce (durable-nonce replay defense)")]
    ErrSessionNonceMismatch,

    // --- Phase 5 (post-execution invariants TA-12 + TA-13 + TA-14) ---
    // Appended at END to preserve existing error codes 6000-6084.
    /// 6085 — TA-12: combined USDC+USDT vault balance dropped below the
    /// owner-configured `policy.stable_balance_floor` after a finalize.
    /// This is the HARD reserve — no combination of attacks (CPI drain,
    /// per-protocol cap bypass, fee inflation) may drain the vault below
    /// this line. Asserted after the CPI balance audit so the floor is
    /// the final post-execution invariant.
    ///
    /// Floor uses 6-decimal USDC face value (e.g. `$100 = 100_000_000`).
    /// Default 0 = no reserve (existing vault behavior preserved). Bound
    /// by TA-19 at canonical digest position 18 (owner-signed).
    #[msg("Stable balance floor violated — combined USDC+USDT balance dropped below policy.stable_balance_floor")]
    ErrStableFloorViolation,

    /// 6086 — TA-13: per-protocol daily cap exceeded. Wired into
    /// `finalize_session` since Phase 2 (`policy.has_protocol_caps` +
    /// `policy.protocol_caps[i]`) but no dedicated error code existed —
    /// callers got the generic `ProtocolCapExceeded`. Phase 5 ratifies
    /// the existing enforcement with a distinct code so callers can
    /// distinguish "rolling 24h per-protocol cap" from the legacy
    /// "global protocol counter exhausted" case.
    ///
    /// NOTE: kept as a distinct variant rather than reusing
    /// `ProtocolCapExceeded` because off-chain monitors + SDK telemetry
    /// already pin to that older code for the legacy slot-exhaustion
    /// path. The two semantics are intentionally separate.
    ///
    /// M-5 semantic clarification (audit 2026-05-19): see also doc comment
    /// on 6043 `ProtocolCapExceeded`. The TL;DR distinction:
    ///   - 6043 = LEGACY counter capacity exhaustion (per-protocol slot
    ///     in the `protocol_counters` array is full).
    ///   - 6086 = modern rolling-24h amount-based spending bound exceeded
    ///     (`policy.protocol_caps[i]` would be breached).
    /// Off-chain monitors that gauge user-facing "you spent too much on
    /// protocol X" should pin to 6086; monitors that detect bookkeeping
    /// pressure / migration needs should pin to 6043.
    #[msg("Per-protocol daily spending cap would be exceeded (rolling 24h)")]
    ErrDailyCapExceeded,

    /// 6087 — TA-14: per-recipient daily cap exceeded. The fixed-size
    /// `tracker.per_recipient` array (≤10 entries, bounded per F-14)
    /// tracks rolling 24h spend per recipient pubkey (resolved from the
    /// SPL TokenAccount.owner of the destination meta — NOT the ATA
    /// pubkey). When a single recipient's 24h outflow would exceed
    /// `policy.per_recipient_daily_cap_usd`, reject.
    ///
    /// Eviction policy is AGE-BASED, never LRU. When the array is full
    /// and a new recipient appears, eviction is permitted ONLY for
    /// entries whose 24h window has already elapsed. If every slot is
    /// still within its 24h window, the call rejects with this code —
    /// preventing churn-eviction (an attacker recycling slots to bypass
    /// the cap by paying many distinct recipients).
    ///
    /// Bound by TA-19 at canonical digest position 19 (owner-signed).
    #[msg("Per-recipient daily cap exceeded — recipient outflow would breach policy.per_recipient_daily_cap_usd within the rolling 24h window, or per_recipient array full with no expired slot to evict")]
    ErrRecipientCapExceeded,

    // --- Phase 6 (Maestro borrows R-1/R-2/R-3/R-4) ---
    // Appended at END to preserve existing error codes 6000-6087.
    /// 6088 — R-1 MintDeltaCap: combined balance of vault-owned ATAs for the
    /// configured mint dropped by more than `max_net_decrease` between
    /// `validate_and_authorize` (pre-snap sum) and `finalize_session` (post sum).
    ///
    /// Two enforcement shapes:
    ///   - `scope=0`: vault-wide. Snapshot sums all derived ATAs (SPL classic
    ///     + Token-2022) for `(vault, mint)`. Catches multi-ATA drains that
    ///     a per-account constraint would miss.
    ///   - `scope=1`: single account in entry's `target_account`. Cheaper
    ///     when the caller knows the exact account to bound.
    ///
    /// Pairs with R-2 (AtaAuthorityPin) per F-18 to close the
    /// close+drain+recreate evasion — R-1 catches the balance change, R-2
    /// catches the authority change.
    #[msg("R-1 MintDeltaCap: vault-mint balance decreased by more than max_net_decrease")]
    ErrMintDeltaCapExceeded,

    /// 6089 — R-1 MintDeltaCap: entry's accounts couldn't be resolved at
    /// validate time. Common shapes:
    ///   - `scope=1` and target_account not present in remaining_accounts
    ///   - target_account's mint field doesn't match the configured mint
    ///   - target_account isn't owned by the vault
    ///
    /// Distinct from ErrMintDeltaCapExceeded because this is a configuration
    /// or caller-side bug (recoverable by fixing the caller), not an attack
    /// signal (which fires ErrMintDeltaCapExceeded at finalize).
    #[msg("R-1 MintDeltaCap misconfigured — target account missing, mint mismatch, or owner not vault")]
    MintDeltaCapMisconfigured,

    /// 6090 — R-2 AtaAuthorityPin: a vault-owned token account had its
    /// authority changed during the sandwich, or was closed and not
    /// reinstated as a vault-owned account before finalize. Detected by
    /// reading bytes 32..64 of the post-CPI token account data and
    /// comparing to `vault.key().to_bytes()`. Also fires when the account
    /// is closed (data length < 64) or its owner program is no longer
    /// SPL Token or Token-2022.
    ///
    /// Pairs with `ErrMintDeltaCapExceeded` to close F-18 close-and-recreate
    /// — R-1 sees the balance drop, R-2 sees the authority flip.
    #[msg("R-2 AtaAuthorityPin: vault-owned token account authority changed or account closed/reinitialized mid-sandwich")]
    ErrAtaAuthorityChanged,

    /// 6091 — R-3 OutputBalanceFloor: a token account that was supposed to
    /// receive at least `min_increase` units of its mint during the sandwich
    /// did not. Snapshot taken at `validate_and_authorize` against
    /// `target_account.amount` (u64 LE at bytes 64..72), finalize requires
    /// `(post - pre) >= aux_value`.
    ///
    /// Counter to "dust-fill" attacks where the agent obtains delegation
    /// authority then runs a swap that returns 1 lamport — R-3 forces the
    /// caller to declare the floor below which the swap is "no value
    /// returned" and rejects.
    #[msg("R-3 OutputBalanceFloor: post-execution balance increase fell below the configured min_increase floor")]
    ErrOutputBelowFloor,

    /// 6092 — R-4 DeclarationConsistency: the (recipient, mint) pair
    /// declared on a post-assertion entry doesn't match the SPL token
    /// account at the configured CPI account-meta index of the DeFi
    /// instruction.
    ///
    /// Fires when ANY of the following hold at finalize:
    ///   - The DeFi instruction at `current_ix_index - 1` cannot be loaded.
    ///   - `account_meta_index` is out of bounds for the DeFi metas.
    ///   - The meta's pubkey isn't present in remaining_accounts.
    ///   - The resolved account isn't owned by SPL Token or Token-2022.
    ///   - The account's mint (bytes 0..32) ≠ entry.expected_value[0..32].
    ///   - The account's owner (bytes 32..64) ≠ entry.target_account.
    ///
    /// Closes the "declaration dishonesty" attack: agent declares
    /// "recipient: alice" to satisfy a destination-allowlist check, then
    /// inserts attacker_ata into the CPI metas. The recipient who would
    /// receive funds (attacker_ata.owner) ≠ alice, so R-4 rejects.
    #[msg("R-4 DeclarationConsistency: declared recipient/mint does not match CPI account-meta")]
    ErrDeclarationInconsistent,

    // --- Audit 2026-05-19 (P1 HIGH fixes) ---
    // Appended at END to preserve existing error codes 6000-6092.
    /// 6093 — account-meta processing budget exceeded (HARD REJECT, not a
    /// silent truncate — this preserves the H-1 closure where a hostile account
    /// hidden beyond a truncation point would escape inspection). Two callers
    /// share this code, each with its own cap:
    /// - `destination_check::enforce_destination_allowlist` rejects when the DeFi
    ///   ix carries more than `MAX_DESTINATION_WRITABLE_METAS` (24) WRITABLE
    ///   metas, or more than `MAX_DESTINATION_CHECK_TOTAL_METAS` (64) total metas
    ///   (F-Q1a: writable is the security-relevant/CU-relevant set; oversized
    ///   routes atomically revert, they are never reshaped to fit);
    /// - `agent_transfer` reuses it for its `MAX_STABLE_FLOOR_WALK_ITERATIONS`
    ///   (16) floor-walk bound.
    #[msg("Foreign instruction exceeded the account-meta processing budget; the bundle is rejected rather than partially inspected")]
    IxMetaCountExceeded,

    // --- Phase 8 (ownership transfer + freeze hardening) ---
    // Appended at END to preserve existing error codes 6000-6093.
    /// 6094 — Phase 8 ownership transfer: a queued ownership transfer for
    /// this vault already exists. Owner must `cancel_ownership_transfer`
    /// before queueing a new target. Prevents a phished owner from quietly
    /// chaining multiple pending transfers and racing the timelock with
    /// whichever target apply()s first.
    ///
    /// DEPRECATED (foundation review 2026-06-29): unreachable — a second
    /// queue attempt collides on Anchor's `init` of the PendingOwnershipTransfer
    /// PDA, which surfaces first. Retained for append-only error-code
    /// stability; never renumber or remove.
    #[msg("An ownership transfer is already pending; cancel it first")]
    ErrPendingOwnershipExists,

    /// 6095 — Phase 8 ownership transfer: `apply_ownership_transfer` was
    /// invoked before the timelock window elapsed. Mirrors policy/agent-
    /// permissions timelock semantics — a phished owner has the full
    /// `policy.timelock_duration` window to cancel before the transfer
    /// can land.
    #[msg("Ownership transfer timelock has not elapsed")]
    ErrPendingOwnershipNotReady,

    /// 6096 — Phase 8 freeze hardening (audit lineage: F19 cached-deser +
    /// F-RP3-2 sibling drift): caller-provided `freeze_reason` byte is
    /// outside the {0,1,2} enum range. Rejecting unknown discriminants is
    /// forward-secure — a future-added FreezeReason variant a tampered SDK
    /// might pre-sign will reject hard on today's program.
    #[msg("freeze_reason value out of {{0,1,2}}")]
    ErrInvalidFreezeReason,

    /// 6097 — Phase 8 reactivate cooldown: `reactivate_vault` requires the
    /// 5-minute observation window after `frozen_at_timestamp` to elapse
    /// before the vault can return to Active. Closes F-RP3-1 (phished owner
    /// freeze→reactivate→full-capability replay in one transaction).
    #[msg("Reactivate requires 5-minute observation cooldown to elapse")]
    ErrReactivateCooldownActive,

    /// 6098 — Phase 8 ownership transfer (Council ISC-128): `new_owner`
    /// cannot be a system/program/sysvar address. Closes the foot-gun where
    /// a phished owner signs a transfer to a non-signing address (e.g.
    /// SystemProgram::ID, Pubkey::default(), known sysvar pubkeys) and
    /// permanently bricks the vault. Forward-only; expansion to additional
    /// banned discriminants is non-breaking.
    #[msg("new_owner cannot be system/program/sysvar addresses (Council ISC-128)")]
    ErrInvalidOwnershipTarget,

    /// 6099 — Phase 8 freeze_internal (Council ISC-136): caller passed more
    /// than `MAX_REVOKE_PAIRS = 10` (session_pda, vault_token_account) pairs
    /// in `remaining_accounts`. The 10-pair cap matches `MAX_AGENTS_PER_VAULT`
    /// (one active session per agent ceiling) and bounds CU consumption of
    /// the auto-revoke walker. Excess pairs are rejected hard rather than
    /// silently dropped so callers immediately see the capacity error.
    #[msg("freeze_internal MAX_REVOKE_PAIRS = 10 exceeded (Council ISC-136)")]
    ErrTooManyRevokePairs,

    /// 6100 — H-3 close (audit 2026-05-21): `close_vault` rejects if
    /// `policy.has_post_assertions != 0` because the 672-byte
    /// `PostExecutionAssertions` zero-copy PDA must be drained via
    /// `close_post_assertions` first — otherwise it would be orphaned
    /// (post-close vault cannot reinit; the PDA's rent becomes
    /// unreclaimable). Symmetric class to the SFH-01 (Phase 8) pending_owner
    /// / pending_agent_grant drain bug already fixed via inline drain logic
    /// in close_vault. Post-assertions has its own dedicated close handler
    /// (`close_post_assertions.rs`) so a require!() guard is the closer
    /// pattern match.
    #[msg("PostExecutionAssertions PDA still active — call close_post_assertions first")]
    ErrPostAssertionsNotClosed,

    /// 6101 — H-4 close (audit 2026-05-21, Bucket 1): `queue_policy_update`
    /// rejects if any entry in `allowed_destinations` is the address of a
    /// Sigil-owned protected PDA for this vault. Closes the owner-self-foot-
    /// gun where a phished owner allowlists a Sigil PDA (e.g. `vault`,
    /// `policy`, `pending_owner`), enabling an agent to lock funds at the
    /// PDA via a token transfer the destination check would otherwise
    /// approve. Validation covers the 13 single-seed vault-keyed protected
    /// PDAs from `PROTECTED_SEED_PREFIXES`. Multi-seed PDAs (session,
    /// pending_agent_perms) are not enumerated at queue time because they
    /// require an extra seed (agent) the attacker is less likely to social-
    /// engineer alongside the destination spoof; TA-11 still rejects them
    /// at execute time.
    #[msg("Destination is a Sigil-protected PDA — rejected at queue time")]
    ErrDestinationIsProtectedPda,

    /// 6102 — D-1 close (Bucket 2, audit 2026-05-21): AL3 on-chain intent-
    /// digest verifier rejected the bundle. `validate_and_authorize` accepts
    /// `expected_intent_digest: [u8; 32]` from the caller (TS SDK computes
    /// SHA-256 over the canonical SealInput at preview time) and recomputes
    /// the same digest from the sibling DeFi instruction introspected via
    /// the instructions sysvar. Mismatch = prompt-injection or in-flight
    /// tamper between preview and execute; reject before any CPI. Bundled
    /// with D-6 "SIG1" magic prefix at intent_version=2.
    #[msg("AL3 intent-digest mismatch — preview digest does not match executed bundle")]
    ErrIntentDigestMismatch,

    /// 6103 — M-5 close (Bucket 2, PEN-CROSS-3): apply_agent_grant rejected
    /// because the recomputed digest of pending content does not match the
    /// digest stored at queue time. Defense-in-depth against discriminator-
    /// collision overwrite of `PendingAgentGrant` content between queue
    /// and apply.
    #[msg("PendingAgentGrant digest mismatch between queue and apply")]
    ErrPendingAgentGrantDigestMismatch,

    /// 6104 — D-5 close (Bucket 2, F-RP3-1): `reactivate_vault` rejected
    /// because the operation grafts a new agent at FULL_CAPABILITY without
    /// the required cosign signature. Closes the phished-owner foot-gun
    /// where freeze→reactivate(new_agent=ATTACKER, FULL_CAPABILITY) in one
    /// transaction silently elevates an attacker-controlled agent. Cosign
    /// pubkey is configured via `policy.cosign_session_pubkey`.
    ///
    /// DEPRECATED (foundation review 2026-06-29): unreachable as a distinct
    /// code — the reactivate cosign gate still fires, but it raises the shared
    /// `ErrCosignRequired` (6080). Retained for append-only error-code
    /// stability; never renumber or remove.
    #[msg("Reactivate with FULL_CAPABILITY new agent requires cosign")]
    ErrReactivateCosignRequiredForFullCapability,

    /// 6105 — F-Q1a destination COMPLETENESS invariant, enforced in
    /// `validate_and_authorize` via `enforce_destination_allowlist`. A writable,
    /// non-vault account meta of the sandwiched DeFi instruction (introspected
    /// from the instructions sysvar) could NOT be resolved in validate's
    /// `remaining_accounts`, so the guard cannot classify it (token vs non-token)
    /// or read its owner byte. The SDK `seal()` *satisfier* passes every writable
    /// account of the DeFi ix into validate's `remaining_accounts`; an unresolved
    /// writable meta is rejected FAIL-CLOSED rather than silently skipped
    /// (replacing the prior fail-open `None => continue` branch). This makes the
    /// validate-side destination set fully visible. NOTE: the per-recipient cap
    /// and stable-balance floor run in `finalize_session`, which carries its OWN
    /// `remaining_accounts`; `seal()` feeds finalize the same writable set (so
    /// those controls are live on the honest seal() path), but finalize does not
    /// yet INDEPENDENTLY fail-closed on omission — a raw-tx caller could omit a
    /// meta from finalize and shrink per-recipient/floor attribution. That is
    /// bounded by the global/per-tx magnitude cap (vault-balance delta, NOT
    /// omittable) and tracked as F-Q1b/M2 (full-bundle binding). The model is
    /// WHERE+MAGNITUDE only — a non-allowlisted *resolved* destination is a
    /// transient route hop (skip), never a hard reject (hard WHERE is decidable
    /// only on the single-recipient `agent_transfer` path).
    #[msg("Writable DeFi account could not be resolved in remaining_accounts — destination set incomplete")]
    DestinationAccountUnresolvable,

    /// 6106 — F-Q4: a WRITABLE, VAULT-OWNED, Token-2022 token account appeared
    /// in a DeFi instruction (a swap delivering tokens into a vault ATA), but
    /// either its mint account was not passed in `remaining_accounts`, or the
    /// account at that mint pubkey is not owned by the Token-2022 program. The
    /// `seal()` satisfier feeds the mint of every vault-owned Token-2022 output
    /// ATA so the forward-secure extension allowlist can run; a missing or decoy
    /// mint is FAIL-CLOSED here (the swap reverts) rather than allowing a token
    /// whose extensions (PermanentDelegate / TransferHook / ConfidentialTransfer)
    /// could later drain or hide the vault's holding out-of-band.
    #[msg("Vault-owned Token-2022 output ATA's mint is absent from remaining_accounts or not Token-2022-owned — cannot vet extensions")]
    ErrToken2022OutputMintUnresolvable,

    /// 6107 — F-Q6: an OPERATOR-class agent grant was attempted INSTANTLY via
    /// `register_agent` on a vault that does NOT carry >=2 authorization
    /// factors at zero delay — a single-key vault, a cosign-required-but-
    /// unbound vault, or any vault with a configured
    /// `operator_grant_delay_seconds > 0`. Such grants MUST route through the
    /// timelocked `queue_agent_grant` → `apply_agent_grant` path (the time-
    /// delay substitutes for the missing 2nd factor). Not an attack — the SDK
    /// should switch to the queue path.
    #[msg("OPERATOR grant requires the timelock queue path on this vault — use queue_agent_grant")]
    ErrOperatorGrantRequiresTimelock,

    /// 6108 — F-Q6: `operator_grant_delay_seconds` supplied to
    /// `queue_policy_update` exceeds `MAX_OPERATOR_GRANT_DELAY` (48h). A larger
    /// delay could exceed the apply-time freshness ceiling and leave an
    /// OPERATOR grant permanently unapplyable (a tier-2 liveness brick), so it
    /// is rejected at configuration time.
    #[msg(
        "operator_grant_delay_seconds exceeds the maximum (48h) — would brick grant applicability"
    )]
    ErrOperatorGrantDelayTooLong,

    /// 6109 — F-Q6: `vault.owner_type` held a value outside the recognized
    /// discriminants (0 = EOA, 1 = multisig) at an OPERATOR-grant read site.
    /// Only reachable via state corruption (the field is program-set to {0,1});
    /// rejected explicitly rather than operating on corrupted authority state
    /// (mirrors the TA-04 `InvalidCapability` reserved-value contract).
    #[msg("vault.owner_type is not a recognized discriminant (expected 0=EOA or 1=multisig)")]
    InvalidOwnerType,

    /// 6110 — F-Q9 (audit 2026-06-01, G12): in `finalize_session`, the collected
    /// fees exceeded the realized stablecoin outflow (`fees_collected >
    /// total_decrease`). Fees are CPI'd OUT before the DeFi leg, so the realized
    /// outflow MUST include them — a fee larger than the outflow is an accounting
    /// impossibility (the DeFi leg net-RETURNED stablecoin on a stablecoin-INPUT
    /// path). Previously `saturating_sub` silently zeroed `actual_spend` here,
    /// masking the anomaly and — with `ceil_fee`'s round-up — letting small spends
    /// round to 0 and skip the caps. Now rejected fail-closed rather than
    /// under-counting the spend. Certora conservation proof tracked for M2.
    ///
    /// DEPRECATED (foundation review 2026-06-29): unreachable post-C-1 — fees
    /// are now ADDED to the measured spend at finalize, never subtracted from
    /// it, so this underflow branch can no longer be taken. Retained for
    /// append-only error-code stability; never renumber or remove.
    #[msg(
        "finalize spend accounting underflow: collected fees exceed realized stablecoin outflow"
    )]
    SpendAccountingUnderflow,

    /// 6111 — H-1 close (audit 2026-06-11): Squads V4 multisig ownership custody
    /// is DISABLED in V1. Transferring vault ownership to a Squads multisig is
    /// architecturally incompatible with Sigil's top-level-only (`reject_cpi!`)
    /// model: a Squads multisig acts on external programs ONLY by CPI from
    /// `vault_transaction_execute` (the vault PDA signs via `invoke_signed`),
    /// but every Sigil owner instruction rejects any CPI — so a multisig owner
    /// could neither complete the accept nor operate the vault afterward, and
    /// the prior path could brick the vault by setting an unsignable account as
    /// owner. `initiate_ownership_transfer` rejects `is_multisig_target = true`
    /// and `accept_ownership_transfer_multisig` rejects unconditionally.
    /// Deferred to a future release (CPI-aware or Sigil-native M-of-N) + re-audit.
    #[msg("Squads multisig ownership custody is not supported in V1 (use a standard EOA owner)")]
    ErrMultisigCustodyUnsupported,

    /// 6112 — M1 output-ownership closure (2026-06-17): on the stablecoin-input
    /// spending path, an acquiring swap MUST land its output in a VAULT-OWNED
    /// token account whose balance strictly INCREASES. Fires when the declared
    /// output account is missing from remaining_accounts, not vault-owned, holds
    /// the wrong mint, or did not increase — i.e. the agent tried to redirect the
    /// swap output to its own (or any non-vault) account, or to spend without
    /// acquiring anything back. GENERIC: no protocol knowledge; checks only
    /// vault-ownership + balance increase of the pinned output (no price/oracle).
    #[msg("M1: stablecoin-input swap output must land in a vault-owned account and increase (value redirection / unacquired spend rejected)")]
    ErrOutputNotVaultOwned,

    /// 6113 — F-Q1b/M2 finalize-side completeness closure (2026-06-21): on a
    /// spending finalize (run_outcome_check && actual_spend > 0), every WRITABLE
    /// non-vault account meta of the counted DeFi instruction MUST be resolvable
    /// in finalize's `remaining_accounts`, exactly as validate enforces F-Q1a
    /// (DestinationAccountUnresolvable 6105). Without this, a raw-tx caller could
    /// pass all metas to validate (passing F-Q1a) then OMIT an output/recipient
    /// leg from finalize, silently shrinking the per-recipient-cap and output
    /// attribution (a dual-output CLMM close leaks the un-pinned leg). Fail-closed
    /// rather than silently skip. GENERIC: re-derived from the instructions sysvar
    /// (runtime truth), no protocol knowledge.
    #[msg("Finalize completeness: a writable DeFi account meta is absent from remaining_accounts (F-Q1b — omission would dodge per-recipient/output attribution)")]
    ErrFinalizeMetaUnresolvable,

    /// 6114 — F-Q1b adjacency (audit 2026-06-22): the single counted DeFi
    /// instruction of a spending sandwich MUST sit IMMEDIATELY before
    /// finalize_session — no ComputeBudget/System (or any other) instruction
    /// between them. finalize derives the DeFi ix positionally as
    /// current_index - 1 for its completeness check, the per-recipient cap, and
    /// the stable-floor walk; validate permits ComputeBudget/System ixs to
    /// interleave (classified Infrastructure), so without this a raw-tx caller
    /// could submit [validate, DeFi, noop, finalize] — making current_index - 1
    /// point at the inert ix so all three attribution walks operate on the WRONG
    /// instruction and pass vacuously (the dual-output leak F-Q1b targets stays
    /// open, and the per-recipient cap silently un-enforces). Enforced at validate,
    /// whose scan already locates both the DeFi ix and finalize. The honest seal()
    /// sandwich always places finalize immediately after the DeFi ix, so this never
    /// rejects a legitimate composition.
    #[msg("The counted DeFi instruction must sit immediately before finalize_session (no interleaved instruction) so finalize's attribution walks bind to the correct instruction")]
    ErrDeFiInstructionNotAdjacentToFinalize,

    /// 6115 — require-measurable-outcome (audit 2026-06-22): a SPENDING session
    /// (run_outcome_check: non-expired, output_mint set) MUST produce a measurable
    /// in-transaction vault outcome — either actual_spend > 0 (stablecoin
    /// measurably left/returned) OR an acquiring swap whose pinned vault-owned
    /// output INCREASED (M1). Fires when neither holds: the session moved no
    /// measurable stablecoin AND declared no acquiring output. Because the
    /// allowlist + async denylist are top-level-instruction-scoped and
    /// program-ID-only (post-M1-04), an owner-allowlisted CPI-capable or
    /// multi-mode program can defer the real transfer to a later block, where
    /// finalize measures 0 and the session would otherwise settle on the dust
    /// fee without binding the caps. Rejecting closes that cap-accounting slip.
    /// VALUE-BLIND: no oracle / no position valuation — it requires only that
    /// SOME measurable vault-owned delta exist in-tx. Exempt: non-spending /
    /// expired sessions. (Unbounded async drain additionally needs owner-granted
    /// surviving custody = position-world; Sigil's agent delegation is revoked
    /// same-tx.)
    #[msg("Spending session produced no measurable in-transaction vault outcome (no stablecoin movement and no vault-owned acquisition) — async/keeper-settled or unmeasurable; recording 0 spend is rejected")]
    ErrUnmeasurableSpend,

    /// 6116 — Item 3 verified-build gate (2026-06-22): the target protocol has a
    /// non-zero `protocol_hashes` entry armed in PolicyConfig, but its
    /// BPFLoaderUpgradeable `ProgramData` account could not be resolved for the
    /// hash check. Fires when: the ProgramData account is ABSENT from
    /// `validate_and_authorize`'s `remaining_accounts` (the SDK `seal()` satisfier
    /// must supply it whenever a hash is armed), is not the canonical
    /// `find_program_address([target_program_id], BPFLoaderUpgradeable)` PDA, is
    /// not owned by BPFLoaderUpgradeable, or is too small to contain an ELF past
    /// the 45-byte ProgramData header. FAIL-CLOSED: an armed gate that cannot read
    /// the deployed build rejects rather than silently authorizing the target —
    /// closing the upgrade-TOCTOU (allowlist a program → it is upgraded to a drain
    /// → pure-pubkey allowlisting keeps authorizing).
    #[msg("Verified-build gate: the target protocol's ProgramData account is missing/unresolvable while a build hash is armed — cannot vet the deployed build (fail-closed)")]
    ErrProgramDataUnresolvable,

    /// 6117 — Item 3 verified-build gate (2026-06-22): the target protocol's
    /// armed `protocol_hashes` entry does NOT match the SHA-256 of its currently
    /// deployed ELF (the bytes of its BPFLoaderUpgradeable `ProgramData` account
    /// past the 45-byte header). The on-chain build changed since the owner pinned
    /// it — either a legitimate upgrade the owner has not re-approved, or a
    /// malicious upgrade to a drain contract. Reject before any CPI; the owner
    /// re-pins the new hash via `queue_policy_update` once they have re-audited the
    /// new build. VALUE-BLIND: no oracle / no price — pure byte-equality of the
    /// owner-attested build hash against the live deployed build.
    #[msg("Verified-build gate: the target protocol's deployed ELF hash does not match the owner-pinned build hash — the on-chain build changed (re-pin via queue_policy_update after re-audit)")]
    ErrProgramBuildMismatch,

    /// 6118 — F-1 fix (timelock-brick close, 2026-06-30): an
    /// `initialize_vault` / `queue_policy_update` (or the apply-time re-check)
    /// supplied a `timelock_duration` greater than `MAX_TIMELOCK_DURATION`
    /// (172_800s / 48h). The symmetric ceiling to `TimelockTooShort`. A timelock
    /// above the cap could fail to mature inside the policy-apply freshness
    /// window (`MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN`), leaving the queued policy
    /// update PERMANENTLY unapplyable — a tier-2 liveness brick. Enforced at
    /// every timelock write site so the brick is unsettable; the cap is pinned
    /// (compile-time assert) to the apply window so the two cannot drift.
    #[msg("Timelock duration exceeds the maximum (MAX_TIMELOCK_DURATION = 172_800s / 48h) — a longer timelock could never mature inside the policy-apply freshness window (brick); choose a value <= 48h")]
    TimelockTooLong,
}
