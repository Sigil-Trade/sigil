use anchor_lang::prelude::*;

#[error_code]
pub enum PhalnxError {
    #[msg("Vault is not active")]
    VaultNotActive,

    #[msg("Unauthorized: signer is not the registered agent")]
    UnauthorizedAgent,

    #[msg("Unauthorized: signer is not the vault owner")]
    UnauthorizedOwner,

    #[msg("Token is not a recognized stablecoin")]
    TokenNotRegistered,

    #[msg("Protocol not allowed by policy")]
    ProtocolNotAllowed,

    #[msg("Transaction exceeds maximum single transaction size")]
    TransactionTooLarge,

    #[msg("Daily spending cap would be exceeded")]
    DailyCapExceeded,

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

    // --- Flash Trade expansion errors ---
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

    #[msg("Jupiter slippage exceeds policy max_slippage_bps or quoted_out is zero")]
    SlippageTooHigh,

    #[msg("Cannot parse Jupiter swap instruction data")]
    InvalidJupiterInstruction,

    #[msg("Cannot parse Flash Trade instruction data")]
    InvalidFlashTradeInstruction,

    #[msg("Flash Trade priceWithSlippage is zero")]
    FlashTradePriceZero,

    #[msg("Top-level SPL Token transfer not allowed between validate and finalize")]
    DustDepositDetected,

    #[msg("Cannot parse Jupiter Lend instruction data")]
    InvalidJupiterLendInstruction,

    #[msg("Slippage BPS exceeds maximum (5000 = 50%)")]
    SlippageBpsTooHigh,

    #[msg("DeFi instruction program does not match declared target_protocol")]
    ProtocolMismatch,

    #[msg("Non-stablecoin swap allows exactly one DeFi instruction")]
    TooManyDeFiInstructions,

    // --- Multi-Agent errors (Workstream A) ---
    #[msg("Maximum agents per vault reached (limit: 10)")]
    MaxAgentsReached,

    #[msg("Agent lacks permission for this action type")]
    InsufficientPermissions,

    #[msg("Permission bitmask contains invalid bits")]
    InvalidPermissions,

    // --- Escrow errors (Workstream B) ---
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

    // --- Instruction constraints errors (6055-6062) ---
    #[msg("Invalid constraint configuration: bounds exceeded")]
    InvalidConstraintConfig,

    #[msg("Instruction constraint violated")]
    ConstraintViolated,

    #[msg("Invalid constraints PDA: wrong owner or vault")]
    InvalidConstraintsPda,

    #[msg("No pending constraints update to apply or cancel")]
    NoPendingConstraintsUpdate,

    #[msg("A pending constraints update already exists")]
    PendingConstraintsUpdateExists,

    #[msg("Constraints update timelock has not expired")]
    ConstraintsUpdateNotExpired,

    #[msg("Invalid pending constraints PDA: wrong owner or vault")]
    InvalidPendingConstraintsPda,

    #[msg("Pending constraints update has expired and is stale")]
    ConstraintsUpdateExpired,
}
