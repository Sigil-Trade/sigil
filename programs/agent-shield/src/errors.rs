use anchor_lang::prelude::*;

#[error_code]
pub enum AgentShieldError {
    #[msg("Vault is not active")]
    VaultNotActive,

    #[msg("Unauthorized: signer is not the registered agent")]
    UnauthorizedAgent,

    #[msg("Unauthorized: signer is not the vault owner")]
    UnauthorizedOwner,

    #[msg("Token not registered in oracle registry")]
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

    #[msg("Session has expired")]
    SessionExpired,

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

    // --- Delegation + Oracle errors ---
    #[msg("Token delegation approval failed")]
    DelegationFailed,

    #[msg("Token delegation revocation failed")]
    RevocationFailed,

    #[msg("Oracle feed value is too stale")]
    OracleFeedStale,

    #[msg("Cannot parse oracle feed data")]
    OracleFeedInvalid,

    // V1 legacy — not emitted in V2 (kept to preserve error code ordering)
    #[msg("Unpriced token cannot be spent (receive-only)")]
    TokenSpendBlocked,

    #[msg("Token account does not belong to vault or has wrong mint")]
    InvalidTokenAccount,

    #[msg("Oracle-priced token requires feed account in remaining_accounts")]
    OracleAccountMissing,

    #[msg("Oracle price confidence interval too wide")]
    OracleConfidenceTooWide,

    #[msg("Oracle account owner is not a recognized oracle program")]
    OracleUnsupportedType,

    #[msg("Pyth price update not fully verified by Wormhole")]
    OracleNotVerified,

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

    // --- V2 errors ---
    #[msg("Invalid protocol mode (must be 0, 1, or 2)")]
    InvalidProtocolMode,

    #[msg("Oracle registry is full (max 105 entries)")]
    OracleRegistryFull,

    #[msg("Unauthorized: not the oracle registry authority")]
    UnauthorizedRegistryAdmin,

    #[msg("Primary and fallback oracle prices diverge beyond threshold")]
    OraclePriceDivergence,

    #[msg("Both primary and fallback oracle feeds failed")]
    OracleBothFeedsFailed,
}
