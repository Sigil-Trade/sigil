/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with: `pnpm --filter @usesigil/kit run gen:error-types`
 * Source of truth: target/idl/sigil.json (errors[])
 * Verified in CI by: scripts/verify-error-drift.ts
 *
 * This file is the compile-time coupling between:
 *   - Rust `#[error_code]` enum in programs/sigil/src/errors.rs
 *   - Anchor-generated IDL in target/idl/sigil.json
 *   - TypeScript assertion helpers in ./expect.ts
 *
 * If any of the three drift, CI fails.
 */

// ────────────────────────────────────────────────────────────────
// Sigil program errors (6000-6080)
// ────────────────────────────────────────────────────────────────

export const SIGIL_ERRORS = {
  VaultNotActive: 6000,
  UnauthorizedAgent: 6001,
  UnauthorizedOwner: 6002,
  UnsupportedToken: 6003,
  ProtocolNotAllowed: 6004,
  TransactionTooLarge: 6005,
  SpendingCapExceeded: 6006,
  LeverageTooHigh: 6007,
  SessionNotAuthorized: 6008,
  InvalidSession: 6009,
  TooManyAllowedProtocols: 6010,
  AgentAlreadyRegistered: 6011,
  NoAgentRegistered: 6012,
  VaultNotFrozen: 6013,
  VaultAlreadyClosed: 6014,
  InsufficientBalance: 6015,
  DeveloperFeeTooHigh: 6016,
  InvalidFeeDestination: 6017,
  InvalidProtocolTreasury: 6018,
  InvalidAgentKey: 6019,
  AgentIsOwner: 6020,
  Overflow: 6021,
  InvalidTokenAccount: 6022,
  TimelockNotExpired: 6023,
  NoTimelockConfigured: 6024,
  DestinationNotAllowed: 6025,
  TooManyDestinations: 6026,
  InvalidProtocolMode: 6027,
  InvalidNonSpendingAmount: 6028,
  CpiCallNotAllowed: 6029,
  MissingFinalizeInstruction: 6030,
  NonTrackedSwapMustReturnStablecoin: 6031,
  SwapSlippageExceeded: 6032,
  InvalidJupiterInstruction: 6033,
  UnauthorizedTokenTransfer: 6034,
  SlippageBpsTooHigh: 6035,
  ProtocolMismatch: 6036,
  TooManyDeFiInstructions: 6037,
  MaxAgentsReached: 6038,
  InsufficientPermissions: 6039,
  InvalidPermissions: 6040,
  EscrowNotActive: 6041,
  EscrowExpired: 6042,
  EscrowNotExpired: 6043,
  InvalidEscrowVault: 6044,
  EscrowConditionsNotMet: 6045,
  EscrowDurationExceeded: 6046,
  InvalidConstraintConfig: 6047,
  ConstraintViolated: 6048,
  InvalidConstraintsPda: 6049,
  InvalidPendingConstraintsPda: 6050,
  AgentSpendLimitExceeded: 6051,
  OverlaySlotExhausted: 6052,
  AgentSlotNotFound: 6053,
  UnauthorizedTokenApproval: 6054,
  InvalidSessionExpiry: 6055,
  UnconstrainedProgramBlocked: 6056,
  ProtocolCapExceeded: 6057,
  ProtocolCapsMismatch: 6058,
  ActiveEscrowsExist: 6059,
  ConstraintsNotClosed: 6060,
  PendingPolicyExists: 6061,
  AgentPaused: 6062,
  AgentAlreadyPaused: 6063,
  AgentNotPaused: 6064,
  UnauthorizedPostFinalizeInstruction: 6065,
  UnexpectedBalanceDecrease: 6066,
  TimelockTooShort: 6067,
  PolicyVersionMismatch: 6068,
  PendingAgentPermsExists: 6069,
  PendingCloseConstraintsExists: 6070,
  ActiveSessionsExist: 6071,
  PostAssertionFailed: 6072,
  InvalidPostAssertionIndex: 6073,
  UnauthorizedPreValidateInstruction: 6074,
  SnapshotNotCaptured: 6075,
  ConstraintIndexOutOfBounds: 6076,
  InvalidConstraintOperator: 6077,
  ConstraintsVaultMismatch: 6078,
  ConstraintEntryCountExceeded: 6079,
  BlockedSplOpcode: 6080,
} as const;

/**
 * Union of valid Sigil error names.
 *
 * A typo on the author's side (`expectSigilError(err, { name: 'UnuthorizedAgent' })`)
 * fails tsc. This is the compile-time safety net.
 */
export type SigilErrorName = keyof typeof SIGIL_ERRORS;

/**
 * Union of valid Sigil error codes.
 */
export type SigilErrorCode = (typeof SIGIL_ERRORS)[SigilErrorName];

/**
 * Conditional type: given a name, produce its code.
 * Used to couple `{name, code}` at the type level.
 */
export type SigilErrorCodeFor<N extends SigilErrorName> =
  (typeof SIGIL_ERRORS)[N];

// ────────────────────────────────────────────────────────────────
// Anchor framework errors (2000-5999, commonly-asserted subset)
// Source: https://github.com/coral-xyz/anchor/blob/v0.32.1/lang/src/error.rs
// ────────────────────────────────────────────────────────────────

export const ANCHOR_FRAMEWORK_ERRORS = {
  // 2000-2999: Instruction-level
  InstructionMissing: 100,
  InstructionFallbackNotFound: 101,
  InstructionDidNotDeserialize: 102,
  InstructionDidNotSerialize: 103,

  // 2000-2999: IDL-level
  IdlInstructionStub: 1000,
  IdlInstructionInvalidProgram: 1001,
  IdlAccountNotEmpty: 1002,

  // 2000-2999: Constraint
  ConstraintMut: 2000,
  ConstraintHasOne: 2001,
  ConstraintSigner: 2002,
  ConstraintRaw: 2003,
  ConstraintOwner: 2004,
  ConstraintRentExempt: 2005,
  ConstraintSeeds: 2006,
  ConstraintExecutable: 2007,
  ConstraintState: 2008,
  ConstraintAssociated: 2009,
  ConstraintAssociatedInit: 2010,
  ConstraintClose: 2011,
  ConstraintAddress: 2012,
  ConstraintZero: 2013,
  ConstraintTokenMint: 2014,
  ConstraintTokenOwner: 2015,
  ConstraintMintMintAuthority: 2016,
  ConstraintMintFreezeAuthority: 2017,
  ConstraintMintDecimals: 2018,
  ConstraintSpace: 2019,
  ConstraintAccountIsNone: 2020,
  ConstraintTokenTokenProgram: 2021,
  ConstraintMintTokenProgram: 2022,
  ConstraintAssociatedTokenTokenProgram: 2023,

  // 3000-3999: Account
  AccountDiscriminatorAlreadySet: 3000,
  AccountDiscriminatorNotFound: 3001,
  AccountDiscriminatorMismatch: 3002,
  AccountDidNotDeserialize: 3003,
  AccountDidNotSerialize: 3004,
  AccountNotEnoughKeys: 3005,
  AccountNotMutable: 3006,
  AccountOwnedByWrongProgram: 3007,
  InvalidProgramId: 3008,
  InvalidProgramExecutable: 3009,
  AccountNotSigner: 3010,
  AccountNotSystemOwned: 3011,
  AccountNotInitialized: 3012,
  AccountNotProgramData: 3013,
  AccountNotAssociatedTokenAccount: 3014,
  AccountSysvarMismatch: 3015,
  AccountReallocExceedsLimit: 3016,
  AccountDuplicateReallocs: 3017,

  // 4000-4999: State
  StateInvalidAddress: 4000,

  // 5000-5999: Misc
  DeclaredProgramIdMismatch: 4100,
  TryingToInitPayerAsProgramAccount: 4101,
  InvalidNumericConversion: 4102,

  Deprecated: 5000,
} as const;

/**
 * Union of Anchor framework error names (the commonly-asserted subset).
 */
export type AnchorFrameworkName = keyof typeof ANCHOR_FRAMEWORK_ERRORS;

export type AnchorFrameworkCodeFor<N extends AnchorFrameworkName> =
  (typeof ANCHOR_FRAMEWORK_ERRORS)[N];

// ────────────────────────────────────────────────────────────────
// Metadata (exported for drift-check + diagnostics)
// ────────────────────────────────────────────────────────────────

/** Total number of Sigil error codes. */
export const SIGIL_ERROR_COUNT: number = Object.keys(SIGIL_ERRORS).length;

/** First (inclusive) Sigil error code. */
export const SIGIL_ERROR_MIN: number = 6000;

/** Last (inclusive) Sigil error code currently defined. */
export const SIGIL_ERROR_MAX: number = Math.max(...Object.values(SIGIL_ERRORS));
