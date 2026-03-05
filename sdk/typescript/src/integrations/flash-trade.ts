import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Connection,
  Signer,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PerpetualsClient, PoolConfig, Side, Privilege } from "flash-sdk";
import type { Phalnx, ComposeActionParams, ActionType } from "../types";
import { getVaultPDA } from "../accounts";
import { composePermittedAction } from "../composer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLASH_TRADE_PROGRAM_ID = new PublicKey(
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn",
);

export const FLASH_COMPOSABILITY_PROGRAM_ID = new PublicKey(
  "FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm",
);

export const FLASH_FB_NFT_REWARD_PROGRAM_ID = new PublicKey(
  "FBRWDXSLysNbFQk64MQJcpkXP8e4fjezsGabV8jV7d7o",
);

export const FLASH_REWARD_DISTRIBUTION_PROGRAM_ID = new PublicKey(
  "FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME",
);

// Re-export flash-sdk types for consumers
export { Side, Privilege } from "flash-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlashTradeConfig {
  /** Pool name, e.g. "Crypto.1" */
  poolName: string;
  /** Cluster for PoolConfig lookup */
  cluster: "mainnet-beta" | "devnet";
}

export interface ContractOraclePrice {
  price: BN;
  exponent: number;
}

export interface FlashOpenPositionParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  collateralAmount: BN;
  sizeAmount: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  leverageBps: number;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashClosePositionParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  collateralAmount: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashIncreasePositionParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  positionPubKey: PublicKey;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  sizeDelta: BN;
  collateralAmount: BN;
  leverageBps: number;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashDecreasePositionParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  positionPubKey: PublicKey;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  sizeDelta: BN;
  collateralAmount: BN;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashAddCollateralParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  positionPubKey: PublicKey;
  /** Collateral amount to add (with fee included) */
  collateralWithFee: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashRemoveCollateralParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  positionPubKey: PublicKey;
  /** USD value of collateral to remove */
  collateralDeltaUsd: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashTriggerOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  /** Receive token symbol (e.g., "USDC" for TP/SL exits) */
  receiveSymbol: string;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  triggerPrice: ContractOraclePrice;
  deltaSizeAmount: BN;
  isStopLoss: boolean;
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashEditTriggerOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  receiveSymbol: string;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  orderId: number;
  triggerPrice: ContractOraclePrice;
  deltaSizeAmount: BN;
  isStopLoss: boolean;
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashCancelTriggerOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  orderId: number;
  isStopLoss: boolean;
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashLimitOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  /** Reserve token symbol (input token for the order) */
  reserveSymbol: string;
  /** Receive token symbol (output token when order fills) */
  receiveSymbol: string;
  reserveAmount: BN;
  sizeAmount: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  limitPrice: ContractOraclePrice;
  stopLossPrice: ContractOraclePrice;
  takeProfitPrice: ContractOraclePrice;
  leverageBps: number;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashEditLimitOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  reserveSymbol: string;
  receiveSymbol: string;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  orderId: number;
  limitPrice: ContractOraclePrice;
  sizeAmount: BN;
  stopLossPrice: ContractOraclePrice;
  takeProfitPrice: ContractOraclePrice;
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashCancelLimitOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  /** Flash Trade doesn't have a direct cancelLimitOrder; cancellation is
   *  done via editLimitOrder with sizeAmount=0. Alternatively, the
   *  limit order expires or is consumed. For Phalnx, we model this
   *  as a non-spending action using a no-op DeFi instruction placeholder.
   *  The actual cancellation mechanism depends on Flash Trade's API. */
  orderId: number;
  reserveSymbol: string;
  receiveSymbol: string;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  vaultTokenAccount?: PublicKey | null;
}

export interface FlashSwapAndOpenParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  collateralAmount: BN;
  sizeAmount: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  leverageBps: number;
  /** Jupiter swap instructions to convert source token to collateral */
  swapInstructions: TransactionInstruction[];
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashCloseAndSwapParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  targetSymbol: string;
  collateralSymbol: string;
  collateralAmount: BN;
  side: { long: Record<string, never> } | { short: Record<string, never> };
  priceWithSlippage: ContractOraclePrice;
  /** Jupiter swap instructions to convert collateral to target token */
  swapInstructions: TransactionInstruction[];
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface FlashTradeResult {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
}

// ---------------------------------------------------------------------------
// Client Factory
// ---------------------------------------------------------------------------

/**
 * Create a PerpetualsClient from flash-sdk configured for a specific pool.
 *
 * The `provider` should use the vault PDA as the wallet (since the vault
 * owns the token accounts and positions in instruction composition mode).
 */
export function createFlashTradeClient(
  provider: AnchorProvider,
  config?: Partial<FlashTradeConfig>,
): PerpetualsClient {
  return new PerpetualsClient(
    provider,
    FLASH_TRADE_PROGRAM_ID,
    FLASH_COMPOSABILITY_PROGRAM_ID,
    FLASH_FB_NFT_REWARD_PROGRAM_ID,
    FLASH_REWARD_DISTRIBUTION_PROGRAM_ID,
    {},
    false,
  );
}

/**
 * Load pool config for a given pool name and cluster.
 */
export function getPoolConfig(
  poolName: string,
  cluster: "mainnet-beta" | "devnet" = "mainnet-beta",
): PoolConfig {
  return PoolConfig.fromIdsByName(poolName, cluster);
}

// ---------------------------------------------------------------------------
// Composition Functions
// ---------------------------------------------------------------------------

/**
 * Compose a Flash Trade open position through Phalnx.
 *
 * Returns: [ComputeBudget, ValidateAndAuthorize, ...flashIxs, FinalizeSession]
 */
export async function composeFlashTradeOpen(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashOpenPositionParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  // Get raw Flash Trade instructions
  const { instructions: flashIxs, additionalSigners } =
    await perpClient.openPosition(
      params.targetSymbol,
      params.collateralSymbol,
      params.priceWithSlippage,
      params.collateralAmount,
      params.sizeAmount,
      params.side as any,
      poolConfig,
      Privilege.None,
      undefined, // tokenStakeAccount
      undefined, // userReferralAccount
      true, // skipBalanceChecks
    );

  // Get collateral token mint from pool config
  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { openPosition: {} },
    tokenMint,
    amount: params.collateralAmount,
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    leverageBps: params.leverageBps,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade close position through Phalnx.
 * Non-spending: amount = 0 (collateral returns TO the vault).
 * Position effect: decrement.
 */
export async function composeFlashTradeClose(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashClosePositionParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.closePosition(
      params.targetSymbol,
      params.collateralSymbol,
      params.priceWithSlippage,
      params.side as any,
      poolConfig,
      Privilege.None,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { closePosition: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade increase position through Phalnx.
 */
export async function composeFlashTradeIncrease(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashIncreasePositionParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.increaseSize(
      params.targetSymbol,
      params.collateralSymbol,
      params.positionPubKey,
      params.side as any,
      poolConfig,
      params.priceWithSlippage,
      params.sizeDelta,
      Privilege.None,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { increasePosition: {} },
    tokenMint,
    amount: params.collateralAmount,
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    leverageBps: params.leverageBps,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade decrease position through Phalnx.
 * Non-spending: amount = 0 (collateral returns TO the vault).
 */
export async function composeFlashTradeDecrease(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashDecreasePositionParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.decreaseSize(
      params.targetSymbol,
      params.collateralSymbol,
      params.side as any,
      params.positionPubKey,
      poolConfig,
      params.priceWithSlippage,
      params.sizeDelta,
      Privilege.None,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { decreasePosition: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

// ---------------------------------------------------------------------------
// Collateral Management
// ---------------------------------------------------------------------------

/**
 * Compose a Flash Trade add collateral through Phalnx.
 * Spending: amount = collateralWithFee (fees + delegation apply).
 */
export async function composeFlashTradeAddCollateral(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashAddCollateralParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.addCollateral(
      params.collateralWithFee,
      params.targetSymbol,
      params.collateralSymbol,
      params.side as any,
      params.positionPubKey,
      poolConfig,
      true, // skipBalanceChecks
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { addCollateral: {} },
    tokenMint,
    amount: params.collateralWithFee,
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade remove collateral through Phalnx.
 * Non-spending: amount = 0 (no fees, no delegation).
 */
export async function composeFlashTradeRemoveCollateral(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashRemoveCollateralParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.removeCollateral(
      params.collateralDeltaUsd,
      params.targetSymbol,
      params.collateralSymbol,
      params.side as any,
      params.positionPubKey,
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { removeCollateral: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

// ---------------------------------------------------------------------------
// Trigger Orders (TP/SL)
// ---------------------------------------------------------------------------

/**
 * Compose a Flash Trade place trigger order (TP/SL) through Phalnx.
 * Non-spending: amount = 0.
 */
export async function composeFlashTradePlaceTriggerOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashTriggerOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.placeTriggerOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.receiveSymbol,
      params.side as any,
      params.triggerPrice,
      params.deltaSizeAmount,
      params.isStopLoss,
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { placeTriggerOrder: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade edit trigger order through Phalnx.
 * Non-spending: amount = 0.
 */
export async function composeFlashTradeEditTriggerOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashEditTriggerOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.editTriggerOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.receiveSymbol,
      params.side as any,
      params.orderId,
      params.triggerPrice,
      params.deltaSizeAmount,
      params.isStopLoss,
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { editTriggerOrder: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade cancel trigger order through Phalnx.
 * Non-spending: amount = 0.
 */
export async function composeFlashTradeCancelTriggerOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashCancelTriggerOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.cancelTriggerOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.side as any,
      params.orderId,
      params.isStopLoss,
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { cancelTriggerOrder: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

// ---------------------------------------------------------------------------
// Limit Orders
// ---------------------------------------------------------------------------

/**
 * Compose a Flash Trade place limit order through Phalnx.
 * Spending: amount = collateralAmount (fees + delegation apply).
 * Position effect: increment (collateral committed on-chain).
 */
export async function composeFlashTradePlaceLimitOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashLimitOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.placeLimitOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.reserveSymbol,
      params.receiveSymbol,
      params.side as any,
      params.limitPrice,
      params.reserveAmount,
      params.sizeAmount,
      params.stopLossPrice,
      params.takeProfitPrice,
      poolConfig,
      true, // skipBalanceChecks
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { placeLimitOrder: {} },
    tokenMint,
    amount: params.reserveAmount,
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    leverageBps: params.leverageBps,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade edit limit order through Phalnx.
 * Non-spending: amount = 0.
 */
export async function composeFlashTradeEditLimitOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashEditLimitOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.editLimitOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.reserveSymbol,
      params.receiveSymbol,
      params.side as any,
      params.orderId,
      params.limitPrice,
      params.sizeAmount,
      params.stopLossPrice,
      params.takeProfitPrice,
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { editLimitOrder: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a Flash Trade cancel limit order through Phalnx.
 * Non-spending: amount = 0. Position effect: decrement.
 */
export async function composeFlashTradeCancelLimitOrder(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashCancelLimitOrderParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  // Flash Trade doesn't have a direct cancelLimitOrder; we use
  // editLimitOrder with sizeAmount=0 to effectively cancel.
  const zeroBN = new BN(0);
  const zeroPrice: ContractOraclePrice = { price: zeroBN, exponent: 0 };
  const { instructions: flashIxs, additionalSigners } =
    await perpClient.editLimitOrder(
      params.targetSymbol,
      params.collateralSymbol,
      params.reserveSymbol,
      params.receiveSymbol,
      params.side as any,
      params.orderId,
      zeroPrice, // limitPrice
      zeroBN, // sizeAmount = 0 to cancel
      zeroPrice, // stopLossPrice
      zeroPrice, // takeProfitPrice
      poolConfig,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { cancelLimitOrder: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions: flashIxs,
    success: true,
    vaultTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

// ---------------------------------------------------------------------------
// Cross-Collateral (Swap + Position)
// ---------------------------------------------------------------------------

/**
 * Compose a swap-then-open-position through Phalnx.
 * Spending: amount = collateralAmount. Position effect: increment.
 *
 * The caller provides pre-built Jupiter swap instructions that convert
 * the source token to the position's collateral token.
 */
export async function composeFlashTradeSwapAndOpen(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashSwapAndOpenParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.openPosition(
      params.targetSymbol,
      params.collateralSymbol,
      params.priceWithSlippage,
      params.collateralAmount,
      params.sizeAmount,
      params.side as any,
      poolConfig,
      Privilege.None,
      undefined,
      undefined,
      true,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  // Swap instructions execute before the Flash Trade open
  const defiInstructions = [...params.swapInstructions, ...flashIxs];

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { swapAndOpenPosition: {} },
    tokenMint,
    amount: params.collateralAmount,
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    leverageBps: params.leverageBps,
    defiInstructions,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

/**
 * Compose a close-position-then-swap through Phalnx.
 * Non-spending: amount = 0 (collateral returns TO the vault).
 * Position effect: decrement.
 *
 * The caller provides pre-built Jupiter swap instructions that convert
 * the position's collateral back to a target token.
 */
export async function composeFlashTradeCloseAndSwap(
  program: Program<Phalnx>,
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  params: FlashCloseAndSwapParams,
): Promise<FlashTradeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { instructions: flashIxs, additionalSigners } =
    await perpClient.closePosition(
      params.targetSymbol,
      params.collateralSymbol,
      params.priceWithSlippage,
      params.side as any,
      poolConfig,
      Privilege.None,
    );

  const collateralToken = poolConfig.getTokenFromSymbol(
    params.collateralSymbol,
  );
  const tokenMint = collateralToken.mintKey;

  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(tokenMint, vault, true);

  // Flash Trade close first, then swap output
  const defiInstructions = [...flashIxs, ...params.swapInstructions];

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { closeAndSwapPosition: {} },
    tokenMint,
    amount: new BN(0),
    targetProtocol: FLASH_TRADE_PROGRAM_ID,
    defiInstructions,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    program.provider.connection,
  );
  return { instructions, additionalSigners };
}

// ---------------------------------------------------------------------------
// Degen Mode Validation (Client-Side Advisory)
// ---------------------------------------------------------------------------

/** Known Degen Mode tokens (SOL, BTC, ETH) */
const DEGEN_MODE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // SOL
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // BTC (Wormhole)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (Wormhole)
]);

const DEGEN_MODE_THRESHOLD_BPS = 12500; // 125x
const MAX_LEVERAGE_BPS = 50000; // 500x

/**
 * Client-side validation for Degen Mode (125x+ leverage).
 * Returns null if valid, or an error message string if invalid.
 *
 * This is advisory — the on-chain max_leverage_bps policy is the real
 * enforcement. But client-side checks prevent wasted transactions.
 */
export function validateDegenMode(
  leverageBps: number,
  tokenMint: PublicKey,
  actionType: ActionType,
): string | null {
  if (leverageBps <= DEGEN_MODE_THRESHOLD_BPS) return null;

  if (leverageBps > MAX_LEVERAGE_BPS) {
    return `Leverage ${leverageBps} BPS exceeds maximum ${MAX_LEVERAGE_BPS} BPS (500x)`;
  }

  if (!DEGEN_MODE_MINTS.has(tokenMint.toBase58())) {
    return `Degen Mode (>${DEGEN_MODE_THRESHOLD_BPS / 100}x) only available for SOL, BTC, ETH`;
  }

  const key = Object.keys(actionType)[0];
  if (
    [
      "placeLimitOrder",
      "editLimitOrder",
      "placeTriggerOrder",
      "editTriggerOrder",
    ].includes(key)
  ) {
    return `Degen Mode does not support ${key}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transaction Builder
// ---------------------------------------------------------------------------

/**
 * Build a complete VersionedTransaction for a Flash Trade operation.
 * The transaction is NOT signed — caller must sign with the agent keypair
 * and any additionalSigners.
 */
export async function composeFlashTradeTransaction(
  connection: Connection,
  payer: PublicKey,
  result: FlashTradeResult,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: result.instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}
