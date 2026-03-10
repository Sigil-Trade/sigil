/**
 * Drift Protocol Adapter
 *
 * Compose functions for integrating Drift perpetuals, spot trading,
 * and lending with Phalnx vault authorization.
 *
 * Uses @drift-labs/sdk instruction getters (getPlacePerpOrderIx, etc.)
 * to obtain raw TransactionInstructions for composition with
 * composePermittedAction().
 *
 * @requires @drift-labs/sdk — optional dependency, loaded lazily
 */

import type {
  PublicKey,
  TransactionInstruction,
  Connection,
  Signer,
} from "@solana/web3.js";
import type { BN, Program } from "@coral-xyz/anchor";
import type { Phalnx, ComposeActionParams } from "../types";
import { composePermittedAction } from "../composer";
import { getVaultPDA } from "../accounts";

// ─── Drift Program ID ────────────────────────────────────────────────────────

/** Drift V2 mainnet program ID */
export const DRIFT_PROGRAM_ID_STR =
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBNtSVAwMHjZi1";

// ─── Precision Constants ─────────────────────────────────────────────────────

/** USDC/quote precision: 10^6 */
export const DRIFT_QUOTE_PRECISION = 1_000_000;
/** Perp base asset precision: 10^9 */
export const DRIFT_BASE_PRECISION = 1_000_000_000;
/** Price precision: 10^6 */
export const DRIFT_PRICE_PRECISION = 1_000_000;

// ─── Market Lookup Tables ────────────────────────────────────────────────────

/** Well-known Drift perp market indexes (mainnet) */
export const DRIFT_PERP_MARKETS: Record<string, number> = {
  "SOL-PERP": 0,
  "BTC-PERP": 1,
  "ETH-PERP": 2,
  "APT-PERP": 3,
  "BONK-PERP": 4,
  "MATIC-PERP": 5,
  "ARB-PERP": 6,
  "DOGE-PERP": 7,
  "BNB-PERP": 8,
  "SUI-PERP": 9,
  "PEPE-PERP": 10,
  "OP-PERP": 11,
  "RNDR-PERP": 12,
  "XRP-PERP": 13,
  "HNT-PERP": 14,
  "INJ-PERP": 15,
  "LINK-PERP": 16,
  "RLB-PERP": 17,
  "PYTH-PERP": 18,
  "TIA-PERP": 19,
  "JTO-PERP": 20,
  "SEI-PERP": 21,
  "AVAX-PERP": 22,
  "WIF-PERP": 23,
  "JUP-PERP": 24,
  "DYM-PERP": 25,
  "W-PERP": 26,
  "TNSR-PERP": 27,
};

/** Well-known Drift spot market indexes (mainnet) */
export const DRIFT_SPOT_MARKETS: Record<string, number> = {
  USDC: 0,
  SOL: 1,
  mSOL: 2,
  wBTC: 3,
  wETH: 4,
  USDT: 5,
  JitoSOL: 6,
  PYTH: 7,
  JTO: 8,
  WIF: 9,
  JUP: 10,
  RNDR: 11,
  W: 12,
  TNSR: 13,
  DRIFT: 14,
};

// ─── Param Types ─────────────────────────────────────────────────────────────

export interface DriftDepositParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  /** Deposit amount in token base units */
  amount: BN;
  /** Spot market index (0 = USDC, 1 = SOL, etc.) */
  marketIndex: number;
  /** Token mint address */
  tokenMint: PublicKey;
  /** Drift sub-account ID (default 0) */
  subAccountId?: number;
  /** Fee destination token account (optional) */
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftWithdrawParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  amount: BN;
  marketIndex: number;
  tokenMint: PublicKey;
  subAccountId?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftPlacePerpOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  /** Perp market index (0 = SOL-PERP, 1 = BTC-PERP, etc.) */
  marketIndex: number;
  /** Order direction */
  side: "long" | "short";
  /** Base asset amount in human units (converted to BASE_PRECISION) */
  amount: BN;
  /** Limit price in human units (converted to PRICE_PRECISION). Omit for market orders. */
  price?: BN;
  /** Order type: "market", "limit", "triggerMarket", "triggerLimit" */
  orderType: "market" | "limit" | "triggerMarket" | "triggerLimit";
  /** Token mint for the collateral (usually USDC) */
  tokenMint: PublicKey;
  subAccountId?: number;
  /** Leverage in basis points (e.g. 50000 = 5x) */
  leverageBps?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftPlaceSpotOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  marketIndex: number;
  side: "long" | "short";
  amount: BN;
  price?: BN;
  orderType: "market" | "limit";
  tokenMint: PublicKey;
  subAccountId?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftCancelOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  orderId: number;
  tokenMint: PublicKey;
  subAccountId?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftModifyOrderParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  orderId: number;
  tokenMint: PublicKey;
  /** New base asset amount (optional) */
  newAmount?: BN;
  /** New price (optional) */
  newPrice?: BN;
  subAccountId?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftSettlePnlParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  marketIndex: number;
  tokenMint: PublicKey;
  subAccountId?: number;
  feeDestinationTokenAccount?: PublicKey;
}

export interface DriftComposeResult {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
}

// ─── Lazy SDK Import ─────────────────────────────────────────────────────────
// @drift-labs/sdk is an optional dependency — loaded dynamically to avoid
// forcing all SDK consumers to install it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _driftSdk: any = null;

async function getDriftSdk(): Promise<any> {
  if (!_driftSdk) {
    try {
      // Dynamic require to avoid TypeScript checking optional dependency at compile time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _driftSdk = require("@drift-labs/sdk");
    } catch {
      throw new Error(
        "@drift-labs/sdk is required for Drift integration. Install it: pnpm add @drift-labs/sdk",
      );
    }
  }
  return _driftSdk;
}

// ─── DriftClient Cache ───────────────────────────────────────────────────────

let _cachedDriftClient: any | null = null;
let _cachedConnection: Connection | null = null;

/**
 * Get or create a DriftClient instance. Cached per connection.
 * Uses BulkAccountLoader for efficient account fetching.
 */
export async function getDriftClient(
  connection: Connection,
  wallet: any,
): Promise<any> {
  if (_cachedDriftClient && _cachedConnection === connection) {
    return _cachedDriftClient;
  }

  const sdk = await getDriftSdk();
  sdk.initialize({ env: "mainnet-beta" as any });

  const client = new sdk.DriftClient({
    connection,
    wallet,
    env: "mainnet-beta" as any,
    accountSubscription: {
      type: "polling",
      accountLoader: new sdk.BulkAccountLoader(connection, "confirmed", 5000),
    },
  });

  await client.subscribe();
  _cachedDriftClient = client;
  _cachedConnection = connection;
  return client;
}

// ─── Helper: Build Order Params ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDriftOrderType(sdk: any, type: string): any {
  switch (type) {
    case "market":
      return sdk.OrderType.MARKET;
    case "limit":
      return sdk.OrderType.LIMIT;
    case "triggerMarket":
      return sdk.OrderType.TRIGGER_MARKET;
    case "triggerLimit":
      return sdk.OrderType.TRIGGER_LIMIT;
    default:
      throw new Error(`Unknown Drift order type: ${type}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDriftDirection(sdk: any, side: "long" | "short"): any {
  return side === "long"
    ? sdk.PositionDirection.LONG
    : sdk.PositionDirection.SHORT;
}

// ─── Compose Functions ───────────────────────────────────────────────────────

/**
 * Compose a Drift deposit instruction wrapped in Phalnx validate/finalize.
 * ActionType: deposit (spending)
 */
export async function composeDriftDeposit(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftDepositParams,
): Promise<DriftComposeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  // Get DriftClient for instruction building
  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const depositIx = await driftClient.getDepositInstruction(
    params.amount,
    params.marketIndex,
    vaultTokenAccount,
    params.subAccountId ?? 0,
    false,
    false,
  );

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { deposit: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: driftProgramId,
    defiInstructions: [depositIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift withdrawal instruction wrapped in Phalnx validate/finalize.
 * ActionType: withdraw (non-spending)
 */
export async function composeDriftWithdraw(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftWithdrawParams,
): Promise<DriftComposeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const withdrawIx = await driftClient.getWithdrawInstruction(
    params.amount,
    params.marketIndex,
    vaultTokenAccount,
    false,
    params.subAccountId ?? 0,
  );

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { withdraw: {} },
    tokenMint: params.tokenMint,
    amount: new (await import("@coral-xyz/anchor")).BN(0), // non-spending
    targetProtocol: driftProgramId,
    defiInstructions: [withdrawIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift perp order instruction wrapped in Phalnx validate/finalize.
 * ActionType: openPosition (spending)
 */
export async function composeDriftPlacePerpOrder(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftPlacePerpOrderParams,
): Promise<DriftComposeResult> {
  const sdk = await getDriftSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const orderParams = {
    orderType: buildDriftOrderType(sdk, params.orderType),
    marketIndex: params.marketIndex,
    direction: buildDriftDirection(sdk, params.side),
    baseAssetAmount: params.amount,
    price: params.price ?? new (await import("@coral-xyz/anchor")).BN(0),
    marketType: sdk.MarketType.PERP,
  };

  const perpOrderIx = await driftClient.getPlacePerpOrderIx(orderParams);

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { openPosition: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: driftProgramId,
    leverageBps: params.leverageBps ?? null,
    defiInstructions: [perpOrderIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift spot order instruction wrapped in Phalnx validate/finalize.
 * ActionType: swap (spending)
 */
export async function composeDriftPlaceSpotOrder(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftPlaceSpotOrderParams,
): Promise<DriftComposeResult> {
  const sdk = await getDriftSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const orderParams = {
    orderType: buildDriftOrderType(sdk, params.orderType),
    marketIndex: params.marketIndex,
    direction: buildDriftDirection(sdk, params.side),
    baseAssetAmount: params.amount,
    price: params.price ?? new (await import("@coral-xyz/anchor")).BN(0),
    marketType: sdk.MarketType.SPOT,
  };

  const spotOrderIx = await driftClient.getPlaceSpotOrderIx(orderParams);

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { swap: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: driftProgramId,
    defiInstructions: [spotOrderIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift cancel order instruction wrapped in Phalnx validate/finalize.
 * ActionType: cancelLimitOrder (non-spending)
 */
export async function composeDriftCancelOrder(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftCancelOrderParams,
): Promise<DriftComposeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const cancelIx = await driftClient.getCancelOrderIx(params.orderId);

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { cancelLimitOrder: {} },
    tokenMint: params.tokenMint,
    amount: new (await import("@coral-xyz/anchor")).BN(0), // non-spending
    targetProtocol: driftProgramId,
    defiInstructions: [cancelIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift modify order instruction wrapped in Phalnx validate/finalize.
 * ActionType: editLimitOrder (non-spending)
 */
export async function composeDriftModifyOrder(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftModifyOrderParams,
): Promise<DriftComposeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  const modifyParams: Record<string, any> = {};
  if (params.newAmount) modifyParams.baseAssetAmount = params.newAmount;
  if (params.newPrice) modifyParams.price = params.newPrice;

  const modifyIx = await driftClient.getModifyOrderIx(
    params.orderId,
    modifyParams,
  );

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { editLimitOrder: {} },
    tokenMint: params.tokenMint,
    amount: new (await import("@coral-xyz/anchor")).BN(0), // non-spending
    targetProtocol: driftProgramId,
    defiInstructions: [modifyIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}

/**
 * Compose a Drift settle PnL instruction wrapped in Phalnx validate/finalize.
 * ActionType: closePosition (non-spending)
 */
export async function composeDriftSettlePnl(
  program: Program<Phalnx>,
  connection: Connection,
  params: DriftSettlePnlParams,
): Promise<DriftComposeResult> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const driftClient = await getDriftClient(connection, {
    publicKey: vault,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any) => txs,
  });

  // settlePnl uses the user account PDA
  const userAccountPublicKey = await driftClient.getUserAccountPublicKey(
    params.subAccountId ?? 0,
  );

  const settleIx = await driftClient.getSettlePNLIx(
    userAccountPublicKey,
    params.marketIndex,
  );

  const driftProgramId = new (await import("@solana/web3.js")).PublicKey(
    DRIFT_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { closePosition: {} },
    tokenMint: params.tokenMint,
    amount: new (await import("@coral-xyz/anchor")).BN(0), // non-spending
    targetProtocol: driftProgramId,
    defiInstructions: Array.isArray(settleIx) ? settleIx : [settleIx],
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions, additionalSigners: [] };
}
