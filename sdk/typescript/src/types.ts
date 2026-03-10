import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type { Phalnx } from "./idl";

export type { Phalnx };

export const PHALNX_PROGRAM_ID = new PublicKey(
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
);

// Fee constants matching on-chain values
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const PROTOCOL_FEE_RATE = 200; // 2 BPS
export const MAX_DEVELOPER_FEE_RATE = 500; // 5 BPS
export const PROTOCOL_TREASURY = new PublicKey(
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
);

// USD decimals (6) — $500 = 500_000_000
export const USD_DECIMALS = 6;

// Multi-agent constants (matching on-chain values in state/mod.rs)
export const MAX_AGENTS_PER_VAULT = 10;
/** Permission bitmask with all 21 bits set (18 base + 3 escrow ActionType variants) */
export const FULL_PERMISSIONS = (1n << 21n) - 1n;
export const SWAP_ONLY = 1n << 0n;
export const PERPS_ONLY = (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n);
export const TRANSFER_ONLY = 1n << 7n;
export const ESCROW_ONLY = (1n << 18n) | (1n << 19n) | (1n << 20n);

// Escrow constants
export const MAX_ESCROW_DURATION = 2_592_000; // 30 days in seconds

/** Permission bit mapping for each ActionType variant */
const ACTION_PERMISSION_MAP: Record<string, bigint> = {
  swap: 1n << 0n,
  openPosition: 1n << 1n,
  closePosition: 1n << 2n,
  increasePosition: 1n << 3n,
  decreasePosition: 1n << 4n,
  deposit: 1n << 5n,
  withdraw: 1n << 6n,
  transfer: 1n << 7n,
  addCollateral: 1n << 8n,
  removeCollateral: 1n << 9n,
  placeTriggerOrder: 1n << 10n,
  editTriggerOrder: 1n << 11n,
  cancelTriggerOrder: 1n << 12n,
  placeLimitOrder: 1n << 13n,
  editLimitOrder: 1n << 14n,
  cancelLimitOrder: 1n << 15n,
  swapAndOpenPosition: 1n << 16n,
  closeAndSwapPosition: 1n << 17n,
  createEscrow: 1n << 18n,
  settleEscrow: 1n << 19n,
  refundEscrow: 1n << 20n,
};

/** Check if a permission bitmask includes the permission for a given action type */
export function hasPermission(
  permissions: bigint,
  actionType: string,
): boolean {
  const bit = ACTION_PERMISSION_MAP[actionType];
  if (bit === undefined) return false;
  return (permissions & bit) !== 0n;
}

// SpendTracker constants (matching on-chain values)
export const EPOCH_DURATION = 600; // 10 minutes in seconds
export const NUM_EPOCHS = 144; // 144 × 10 min = 24h

// Protocol mode constants (matching on-chain values)
export const PROTOCOL_MODE_ALL = 0;
export const PROTOCOL_MODE_ALLOWLIST = 1;
export const PROTOCOL_MODE_DENYLIST = 2;

// Devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
// Mainnet USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
export const USDC_MINT_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
// Devnet USDT: EJwZgeZrdC8TXTQbQBoL6bfuAnFUQS5S4iC5A2ciQtCK
export const USDT_MINT_DEVNET = new PublicKey(
  "EJwZgeZrdC8TXTQbQBoL6bfuAnFUQS5S4iC5A2ciQtCK",
);
// Mainnet USDT: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
export const USDT_MINT_MAINNET = new PublicKey(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
);

export const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

export function isStablecoinMint(mint: PublicKey): boolean {
  return (
    mint.equals(USDC_MINT_DEVNET) ||
    mint.equals(USDC_MINT_MAINNET) ||
    mint.equals(USDT_MINT_DEVNET) ||
    mint.equals(USDT_MINT_MAINNET)
  );
}

/** Epoch bucket in the zero-copy circular spend tracker */
export type EpochBucket = {
  epochId: BN;
  usdAmount: BN;
};

// Agent entry type for multi-agent vaults
export type AgentEntry = {
  pubkey: PublicKey;
  permissions: BN;
  spendingLimitUsd: BN;
};

// Re-export IDL types for convenience
export type AgentVaultAccount = {
  owner: PublicKey;
  vaultId: BN;
  agents: AgentEntry[];
  feeDestination: PublicKey;
  status: VaultStatus;
  bump: number;
  createdAt: BN;
  totalTransactions: BN;
  totalVolume: BN;
  openPositions: number;
  totalFeesCollected: BN;
  treasuryShard: number;
};

export type PolicyConfigAccount = {
  vault: PublicKey;
  dailySpendingCapUsd: BN;
  maxTransactionSizeUsd: BN;
  protocolMode: number;
  protocols: PublicKey[];
  maxLeverageBps: number;
  canOpenPositions: boolean;
  maxConcurrentPositions: number;
  developerFeeRate: number;
  maxSlippageBps: number;
  timelockDuration: BN;
  allowedDestinations: PublicKey[];
  hasConstraints: boolean;
  hasProtocolCaps: boolean;
  protocolCaps: BN[];
  sessionExpirySlots: BN;
  bump: number;
};

export type PendingPolicyUpdateAccount = {
  vault: PublicKey;
  queuedAt: BN;
  executesAt: BN;
  dailySpendingCapUsd: BN | null;
  maxTransactionAmountUsd: BN | null;
  protocolMode: number | null;
  protocols: PublicKey[] | null;
  maxLeverageBps: number | null;
  canOpenPositions: boolean | null;
  maxConcurrentPositions: number | null;
  developerFeeRate: number | null;
  timelockDuration: BN | null;
  allowedDestinations: PublicKey[] | null;
  bump: number;
};

// Escrow types
export type EscrowStatus =
  | { active: Record<string, never> }
  | { settled: Record<string, never> }
  | { refunded: Record<string, never> };

export type EscrowDepositAccount = {
  sourceVault: PublicKey;
  destinationVault: PublicKey;
  escrowId: BN;
  amount: BN;
  tokenMint: PublicKey;
  createdAt: BN;
  expiresAt: BN;
  status: EscrowStatus;
  conditionHash: number[];
  bump: number;
};

// Constraint types
export type ConstraintOperator =
  | { eq: Record<string, never> }
  | { ne: Record<string, never> }
  | { gte: Record<string, never> }
  | { lte: Record<string, never> }
  | { gteSigned: Record<string, never> }
  | { lteSigned: Record<string, never> }
  | { bitmask: Record<string, never> };

export type DataConstraint = {
  offset: number;
  operator: ConstraintOperator;
  value: number[];
};

export type AccountConstraint = {
  index: number;
  expected: PublicKey;
};

export type ConstraintEntry = {
  programId: PublicKey;
  dataConstraints: DataConstraint[];
  accountConstraints: AccountConstraint[];
};

export type InstructionConstraintsAccount = {
  vault: PublicKey;
  entries: ConstraintEntry[];
  strictMode: boolean;
  bump: number;
};

export type PendingConstraintsUpdateAccount = {
  vault: PublicKey;
  entries: ConstraintEntry[];
  strictMode: boolean;
  queuedAt: BN;
  executesAt: BN;
  bump: number;
};

export type SpendTrackerAccount = {
  vault: PublicKey;
  buckets: EpochBucket[];
  bump: number;
};

export type SessionAuthorityAccount = {
  vault: PublicKey;
  agent: PublicKey;
  authorized: boolean;
  authorizedAmount: BN;
  authorizedToken: PublicKey;
  authorizedProtocol: PublicKey;
  actionType: ActionType;
  expiresAtSlot: BN;
  delegated: boolean;
  delegationTokenAccount: PublicKey;
  outputMint: PublicKey;
  stablecoinBalanceBefore: BN;
  protocolFee: BN;
  developerFee: BN;
  bump: number;
};

// Enum types matching the on-chain representation
export type VaultStatus =
  | { active: Record<string, never> }
  | { frozen: Record<string, never> }
  | { closed: Record<string, never> };

export type ActionType =
  | { swap: Record<string, never> }
  | { openPosition: Record<string, never> }
  | { closePosition: Record<string, never> }
  | { increasePosition: Record<string, never> }
  | { decreasePosition: Record<string, never> }
  | { deposit: Record<string, never> }
  | { withdraw: Record<string, never> }
  | { transfer: Record<string, never> }
  | { addCollateral: Record<string, never> }
  | { removeCollateral: Record<string, never> }
  | { placeTriggerOrder: Record<string, never> }
  | { editTriggerOrder: Record<string, never> }
  | { cancelTriggerOrder: Record<string, never> }
  | { placeLimitOrder: Record<string, never> }
  | { editLimitOrder: Record<string, never> }
  | { cancelLimitOrder: Record<string, never> }
  | { swapAndOpenPosition: Record<string, never> }
  | { closeAndSwapPosition: Record<string, never> }
  | { createEscrow: Record<string, never> }
  | { settleEscrow: Record<string, never> }
  | { refundEscrow: Record<string, never> };

/** Position effect classification */
export type PositionEffect = "increment" | "decrement" | "none";

/** Returns true if the action type spends tokens from the vault */
export function isSpendingAction(actionType: ActionType): boolean {
  const key = Object.keys(actionType)[0];
  return [
    "swap",
    "openPosition",
    "increasePosition",
    "deposit",
    "transfer",
    "addCollateral",
    "placeLimitOrder",
    "swapAndOpenPosition",
    "createEscrow",
  ].includes(key);
}

/** Returns the position effect for an action type */
export function getPositionEffect(actionType: ActionType): PositionEffect {
  const key = Object.keys(actionType)[0];
  if (
    ["openPosition", "swapAndOpenPosition", "placeLimitOrder"].includes(key)
  ) {
    return "increment";
  }
  if (
    ["closePosition", "closeAndSwapPosition", "cancelLimitOrder"].includes(key)
  ) {
    return "decrement";
  }
  return "none";
}

// SDK param types for instruction builders
export interface InitializeVaultParams {
  vaultId: BN;
  dailySpendingCapUsd: BN;
  maxTransactionSizeUsd: BN;
  /** Protocol mode: 0=all allowed, 1=allowlist, 2=denylist. Default: 0 */
  protocolMode?: number;
  /** Protocol pubkeys for allowlist/denylist (ignored when mode=0) */
  protocols?: PublicKey[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
  feeDestination: PublicKey;
  developerFeeRate?: number;
  maxSlippageBps?: number;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  protocolCaps?: BN[];
}

export interface UpdatePolicyParams {
  dailySpendingCapUsd?: BN | null;
  maxTransactionSizeUsd?: BN | null;
  protocolMode?: number | null;
  protocols?: PublicKey[] | null;
  maxLeverageBps?: number | null;
  canOpenPositions?: boolean | null;
  maxConcurrentPositions?: number | null;
  developerFeeRate?: number | null;
  maxSlippageBps?: number | null;
  timelockDuration?: BN | null;
  allowedDestinations?: PublicKey[] | null;
  sessionExpirySlots?: BN | null;
  hasProtocolCaps?: boolean | null;
  protocolCaps?: BN[] | null;
}

export interface QueuePolicyUpdateParams {
  dailySpendingCapUsd?: BN | null;
  maxTransactionAmountUsd?: BN | null;
  protocolMode?: number | null;
  protocols?: PublicKey[] | null;
  maxLeverageBps?: number | null;
  canOpenPositions?: boolean | null;
  maxConcurrentPositions?: number | null;
  developerFeeRate?: number | null;
  maxSlippageBps?: number | null;
  timelockDuration?: BN | null;
  allowedDestinations?: PublicKey[] | null;
  sessionExpirySlots?: BN | null;
  hasProtocolCaps?: boolean | null;
  protocolCaps?: BN[] | null;
}

export interface AgentTransferParams {
  amount: BN;
  vaultTokenAccount: PublicKey;
  tokenMintAccount: PublicKey;
  destinationTokenAccount: PublicKey;
  feeDestinationTokenAccount?: PublicKey | null;
  protocolTreasuryTokenAccount?: PublicKey | null;
}

export interface AuthorizeParams {
  actionType: ActionType;
  tokenMint: PublicKey;
  amount: BN;
  targetProtocol: PublicKey;
  leverageBps?: number | null;
  /** Output stablecoin token account (for post-swap balance verification) */
  outputStablecoinAccount?: PublicKey;
}

export interface ComposeActionParams {
  vault: PublicKey;
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  actionType: ActionType;
  tokenMint: PublicKey;
  amount: BN;
  targetProtocol: PublicKey;
  leverageBps?: number | null;
  /** The DeFi instruction(s) to sandwich between validate and finalize */
  defiInstructions: import("@solana/web3.js").TransactionInstruction[];
  /** Whether the finalize step should report success (default: true) */
  success?: boolean;
  /** Vault's PDA-owned token account for the spend token (required for delegation) */
  vaultTokenAccount: PublicKey;
  /** Optional: fee destination token account */
  feeDestinationTokenAccount?: PublicKey | null;
  /** Optional: protocol treasury token account for protocol fee */
  protocolTreasuryTokenAccount?: PublicKey | null;
  /** Output stablecoin token account (for post-swap balance verification) */
  outputStablecoinAccount?: PublicKey;
  /** Optional: constraints PDA to pass as remaining account */
  constraintsPda?: PublicKey;
}

// Escrow param types
export interface CreateEscrowParams {
  escrowId: BN;
  amount: BN;
  expiresAt: BN;
  conditionHash: number[];
  tokenMint: PublicKey;
  sourceVault: PublicKey;
  destinationVault: PublicKey;
  sourceVaultAta: PublicKey;
  protocolTreasuryAta?: PublicKey | null;
  feeDestinationAta?: PublicKey | null;
}

export interface SettleEscrowParams {
  proof: Buffer;
  escrow: PublicKey;
  destinationVault: PublicKey;
  sourceVault: PublicKey;
  escrowAta: PublicKey;
  destinationVaultAta: PublicKey;
  tokenMint: PublicKey;
}

export interface RefundEscrowParams {
  escrow: PublicKey;
  sourceVault: PublicKey;
  escrowAta: PublicKey;
  sourceVaultAta: PublicKey;
  tokenMint: PublicKey;
}

// Constraint param types
export interface CreateConstraintsParams {
  entries: ConstraintEntry[];
  strictMode?: boolean;
}

export interface UpdateConstraintsParams {
  entries: ConstraintEntry[];
  strictMode?: boolean;
}

export interface QueueConstraintsUpdateParams {
  entries: ConstraintEntry[];
  strictMode?: boolean;
}
