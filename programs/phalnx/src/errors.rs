use anchor_lang::prelude::*;

#[error_code]
pub enum PhalnxError {
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

    #[msg("Leverage exceeds maximum allowed")]
    LeverageTooHigh,

    #[msg("Maximum concurrent open positions reached")]
    TooManyPositions,

    #[msg("Cannot open new positions (policy disallows)")]
    PositionOpeningDisallowed,

    #[msg("Session not authorized")]
    SessionNotAuthorized,

    #[msg("Invalid session: does not belong to this vault")]
    InvalidSession,

    #[msg("Vault has open positions, cannot close")]
    OpenPositionsExist,

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

    #[msg("Vault has timelock active — use queue_policy_update instead")]
    TimelockActive,

    #[msg("No timelock configured on this vault")]
    NoTimelockConfigured,

    #[msg("Destination not in allowed list")]
    DestinationNotAllowed,

    #[msg("Too many destinations (max 10)")]
    TooManyDestinations,

    #[msg("Invalid protocol mode (must be 0, 1, or 2)")]
    InvalidProtocolMode,

    // --- Transaction validation errors ---
    #[msg("Non-spending action must have amount = 0")]
    InvalidNonSpendingAmount,

    #[msg("No open positions to close or cancel")]
    NoPositionsToClose,

    #[msg("Instruction must be top-level (CPI calls not allowed)")]
    CpiCallNotAllowed,

    #[msg("Transaction must include finalize_session after validate")]
    MissingFinalizeInstruction,

    // --- Stablecoin-only enforcement errors ---
    #[msg("Non-stablecoin swap must return stablecoin (balance did not increase)")]
    NonTrackedSwapMustReturnStablecoin,

    #[msg("Swap slippage exceeds policy max_slippage_bps or quoted output is zero")]
    SwapSlippageExceeded,

    #[msg("Cannot parse Jupiter swap instruction data")]
    InvalidJupiterInstruction,

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

    // --- Escrow errors ---
    #[msg("Escrow is not in Active status")]
    EscrowNotActive,

    #[msg("Escrow has expired")]
    EscrowExpired,

    #[msg("Escrow has not expired yet")]
    EscrowNotExpired,

    #[msg("Invalid escrow vault")]
    InvalidEscrowVault,

    #[msg("Escrow conditions not met")]
    EscrowConditionsNotMet,

    #[msg("Escrow duration exceeds maximum (30 days)")]
    EscrowDurationExceeded,

    // --- Instruction constraints errors ---
    #[msg("Invalid constraint configuration: bounds exceeded")]
    InvalidConstraintConfig,

    #[msg("Instruction constraint violated")]
    ConstraintViolated,

    #[msg("Invalid constraints PDA: wrong owner or vault")]
    InvalidConstraintsPda,

    #[msg("Invalid pending constraints PDA: wrong owner or vault")]
    InvalidPendingConstraintsPda,

    // --- Per-agent spend limit errors ---
    #[msg("Agent rolling 24h spend exceeds per-agent spending limit")]
    AgentSpendLimitExceeded,

    #[msg("Per-agent overlay is full; cannot register agent with spending limit")]
    OverlaySlotExhausted,

    #[msg("Agent has per-agent spending limit but no overlay tracking slot")]
    AgentSlotNotFound,

    #[msg("Unauthorized SPL Token Approve between validate and finalize")]
    UnauthorizedTokenApproval,

    #[msg("Session expiry slots out of range (10-450)")]
    InvalidSessionExpiry,

    // --- Generic constraints V2 errors ---
    #[msg("Program has no constraint entry and strict mode is enabled")]
    UnconstrainedProgramBlocked,

    // --- Per-protocol spend cap errors ---
    #[msg("Per-protocol rolling 24h spending cap would be exceeded")]
    ProtocolCapExceeded,

    #[msg("protocol_caps length must match protocols length when has_protocol_caps is true")]
    ProtocolCapsMismatch,

    // --- Vault cleanup guard errors ---
    #[msg("Cannot close vault with active escrow deposits")]
    ActiveEscrowsExist,

    #[msg("Instruction constraints must be closed before closing vault")]
    ConstraintsNotClosed,

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
}
