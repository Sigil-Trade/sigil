import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type { AgentShield } from "./idl";

export type { AgentShield };

export const AGENT_SHIELD_PROGRAM_ID = new PublicKey(
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

// SpendTracker constants (matching on-chain values)
export const EPOCH_DURATION = 600; // 10 minutes in seconds
export const NUM_EPOCHS = 144; // 144 × 10 min = 24h

// Protocol mode constants (matching on-chain values)
export const PROTOCOL_MODE_ALL = 0;
export const PROTOCOL_MODE_ALLOWLIST = 1;
export const PROTOCOL_MODE_DENYLIST = 2;

/** Oracle source types */
export type OracleSource = "pyth" | "switchboard";

/** Oracle registry entry — maps token mint to its oracle feed */
export interface OracleEntry {
  /** Token mint address */
  mint: PublicKey;
  /** Oracle feed account (Pyth PriceUpdateV2 or Switchboard PullFeed).
   *  Pubkey.default = stablecoin (1:1 USD, no oracle read needed). */
  oracleFeed: PublicKey;
  /** Whether this token is a stablecoin (1:1 USD conversion) */
  isStablecoin: boolean;
  /** Optional fallback oracle feed. PublicKey.default = no fallback.
   *  Used when primary is stale/invalid. Cross-checked for divergence. */
  fallbackFeed: PublicKey;
}

/** Epoch bucket in the zero-copy circular spend tracker */
export type EpochBucket = {
  epochId: BN;
  usdAmount: BN;
};

// Re-export IDL types for convenience
export type AgentVaultAccount = {
  owner: PublicKey;
  agent: PublicKey;
  feeDestination: PublicKey;
  vaultId: BN;
  status: VaultStatus;
  bump: number;
  createdAt: BN;
  totalTransactions: BN;
  totalVolume: BN;
  openPositions: number;
  totalFeesCollected: BN;
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
  timelockDuration: BN;
  allowedDestinations: PublicKey[];
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

export type OracleRegistryAccount = {
  authority: PublicKey;
  entries: OracleEntry[];
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
  | { transfer: Record<string, never> };

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
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
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
  timelockDuration?: BN | null;
  allowedDestinations?: PublicKey[] | null;
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
  timelockDuration?: BN | null;
  allowedDestinations?: PublicKey[] | null;
}

export interface AgentTransferParams {
  amount: BN;
  vaultTokenAccount: PublicKey;
  tokenMintAccount: PublicKey;
  destinationTokenAccount: PublicKey;
  feeDestinationTokenAccount?: PublicKey | null;
  protocolTreasuryTokenAccount?: PublicKey | null;
  oracleFeedAccount?: PublicKey;
  /** Fallback oracle feed account (optional, for cross-validation) */
  fallbackOracleFeedAccount?: PublicKey;
}

export interface AuthorizeParams {
  actionType: ActionType;
  tokenMint: PublicKey;
  amount: BN;
  targetProtocol: PublicKey;
  leverageBps?: number | null;
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
  /** Oracle feed account for oracle-priced tokens (Pyth or Switchboard) */
  oracleFeedAccount?: PublicKey;
  /** Fallback oracle feed account (optional, for cross-validation) */
  fallbackOracleFeedAccount?: PublicKey;
}

export interface InitializeOracleRegistryParams {
  entries: OracleEntry[];
}

export interface UpdateOracleRegistryParams {
  entriesToAdd: OracleEntry[];
  mintsToRemove: PublicKey[];
}
