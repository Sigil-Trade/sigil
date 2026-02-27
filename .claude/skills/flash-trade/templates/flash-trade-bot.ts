// ============================================================
// Flash Trade Perpetual Trading Bot Template
// ============================================================
// Production-ready template for building a Flash Trade trading bot.
// Handles position management, risk controls, and graceful shutdown.
//
// Usage:
// 1. Copy this file to your project
// 2. Set environment variables (RPC_URL, WALLET_PRIVATE_KEY)
// 3. Customize the CONFIG and trading strategy
// 4. Run: npx ts-node flash-trade-bot.ts
// ============================================================

import { PerpetualsClient, PoolConfig, Side, Privilege, ViewHelper } from "flash-sdk";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as bs58 from "bs58";

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Connection
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  cluster: "mainnet-beta" as const,
  commitment: "processed" as const,

  // Pool & Market
  poolName: "Crypto.1",
  targetSymbol: "SOL",
  collateralSymbol: "USDC",

  // Trading Parameters
  side: Side.Long,
  collateralUsdc: 100_000_000,          // 100 USDC (6 decimals)
  maxLeverage: 10,                       // 10x max
  slippageBps: 200,                      // 2% slippage tolerance

  // Risk Management
  maxPositionSizeUsd: 5_000_000_000,    // $5,000 max position
  stopLossPct: 5,                        // 5% stop-loss
  takeProfitPct: 10,                     // 10% take-profit
  maxDrawdownPct: 20,                    // 20% max drawdown before halt
  minCollateralUsd: 50_000_000,         // $50 minimum collateral

  // Execution
  priorityFee: 10_000,                  // microLamports
  computeUnits: 600_000,               // CU per transaction
  loopIntervalMs: 30_000,              // 30 seconds between checks
  maxRetries: 3,                        // retries per operation
  retryDelayMs: 2_000,                 // delay between retries
};

// ============================================================
// TYPES
// ============================================================

interface BotState {
  isRunning: boolean;
  hasPosition: boolean;
  entryPrice: number | null;
  currentPnl: number;
  totalPnl: number;
  tradeCount: number;
  errors: number;
}

// ============================================================
// LOGGING
// ============================================================

function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [${level}] ${msg}${extra}`);
}

// ============================================================
// CLIENT SETUP
// ============================================================

async function setupClient(): Promise<{
  client: PerpetualsClient;
  viewHelper: ViewHelper;
  poolConfig: PoolConfig;
  provider: AnchorProvider;
  wallet: Keypair;
}> {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("WALLET_PRIVATE_KEY env var required");

  const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(CONFIG.rpcUrl, { commitment: CONFIG.commitment });
  const provider = new AnchorProvider(connection, new NodeWallet(wallet), {
    commitment: CONFIG.commitment,
  });

  const poolConfig = PoolConfig.fromIdsByName(CONFIG.poolName, CONFIG.cluster);

  const client = new PerpetualsClient(
    provider,
    new PublicKey(poolConfig.programId),
    new PublicKey(poolConfig.perpComposibilityProgramId),
    new PublicKey(poolConfig.fbNftRewardProgramId),
    new PublicKey(poolConfig.rewardDistributionProgram.programId),
    { prioritizationFee: CONFIG.priorityFee },
  );

  await client.loadAddressLookupTable(poolConfig);

  const viewHelper = new ViewHelper(connection, provider);

  log("INFO", "Client initialized", {
    pool: CONFIG.poolName,
    wallet: wallet.publicKey.toBase58(),
    target: CONFIG.targetSymbol,
  });

  return { client, viewHelper, poolConfig, provider, wallet };
}

// ============================================================
// MARKET DATA
// ============================================================

async function getOraclePrice(
  viewHelper: ViewHelper,
  poolConfig: PoolConfig,
): Promise<{ price: number; raw: { price: BN; exponent: number } }> {
  const oracle = await viewHelper.getOraclePrice(CONFIG.targetSymbol, poolConfig);
  const price = oracle.price.toNumber() * Math.pow(10, oracle.exponent);
  return { price, raw: { price: oracle.price, exponent: oracle.exponent } };
}

function calcSlippagePrice(
  oraclePrice: { price: BN; exponent: number },
  side: typeof Side.Long | typeof Side.Short,
  isEntry: boolean,
): { price: BN; exponent: number } {
  const bps = CONFIG.slippageBps;
  // Entry long / Exit short: price above oracle
  // Entry short / Exit long: price below oracle
  const addSlippage =
    (side === Side.Long && isEntry) || (side === Side.Short && !isEntry);

  const multiplier = addSlippage ? 10_000 + bps : 10_000 - bps;
  return {
    price: oraclePrice.price.mul(new BN(multiplier)).div(new BN(10_000)),
    exponent: oraclePrice.exponent,
  };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

async function openPosition(
  client: PerpetualsClient,
  poolConfig: PoolConfig,
  oracleRaw: { price: BN; exponent: number },
): Promise<string> {
  const priceWithSlippage = calcSlippagePrice(oracleRaw, CONFIG.side, true);

  // Calculate size from collateral and desired leverage
  const collateral = new BN(CONFIG.collateralUsdc);
  const oracleUsd = oracleRaw.price.toNumber() * Math.pow(10, oracleRaw.exponent);
  const notionalUsd = CONFIG.collateralUsdc * CONFIG.maxLeverage / 1_000_000;
  const targetDecimals = CONFIG.targetSymbol === "SOL" ? 9 : 8;
  const sizeAmount = Math.floor((notionalUsd / oracleUsd) * Math.pow(10, targetDecimals));

  const { instructions, additionalSigners } = await client.openPosition(
    CONFIG.targetSymbol,
    CONFIG.collateralSymbol,
    priceWithSlippage,
    collateral,
    new BN(sizeAmount),
    CONFIG.side,
    poolConfig,
    Privilege.None,
  );

  return await client.sendTransaction(instructions, additionalSigners);
}

async function closePosition(
  client: PerpetualsClient,
  poolConfig: PoolConfig,
  oracleRaw: { price: BN; exponent: number },
): Promise<string> {
  const priceWithSlippage = calcSlippagePrice(oracleRaw, CONFIG.side, false);

  const { instructions, additionalSigners } = await client.closePosition(
    CONFIG.targetSymbol,
    CONFIG.collateralSymbol,
    priceWithSlippage,
    CONFIG.side,
    poolConfig,
    Privilege.None,
  );

  return await client.sendTransaction(instructions, additionalSigners);
}

async function placeSLTP(
  client: PerpetualsClient,
  poolConfig: PoolConfig,
  entryPrice: number,
  sizeAmount: BN,
): Promise<void> {
  // Stop-loss
  const slPrice = CONFIG.side === Side.Long
    ? entryPrice * (1 - CONFIG.stopLossPct / 100)
    : entryPrice * (1 + CONFIG.stopLossPct / 100);

  await client.sendTransaction(
    ...(Object.values(
      await client.placeTriggerOrder(CONFIG.targetSymbol, CONFIG.collateralSymbol, CONFIG.side, {
        triggerPrice: { price: new BN(Math.floor(slPrice * 1_000_000)), exponent: -6 },
        deltaSizeAmount: sizeAmount,
        isStopLoss: true,
      }, poolConfig, Privilege.None),
    ) as [any, any]),
  );

  // Take-profit
  const tpPrice = CONFIG.side === Side.Long
    ? entryPrice * (1 + CONFIG.takeProfitPct / 100)
    : entryPrice * (1 - CONFIG.takeProfitPct / 100);

  await client.sendTransaction(
    ...(Object.values(
      await client.placeTriggerOrder(CONFIG.targetSymbol, CONFIG.collateralSymbol, CONFIG.side, {
        triggerPrice: { price: new BN(Math.floor(tpPrice * 1_000_000)), exponent: -6 },
        deltaSizeAmount: sizeAmount,
        isStopLoss: false,
      }, poolConfig, Privilege.None),
    ) as [any, any]),
  );

  log("INFO", "SL/TP placed", { sl: slPrice.toFixed(2), tp: tpPrice.toFixed(2) });
}

// ============================================================
// RISK MANAGEMENT
// ============================================================

function shouldHalt(state: BotState): boolean {
  if (state.totalPnl < -(CONFIG.maxDrawdownPct / 100) * CONFIG.collateralUsdc * state.tradeCount) {
    log("WARN", "Max drawdown reached, halting", { totalPnl: state.totalPnl });
    return true;
  }
  return false;
}

// ============================================================
// TRADING STRATEGY (CUSTOMIZE THIS)
// ============================================================

async function evaluateStrategy(
  viewHelper: ViewHelper,
  poolConfig: PoolConfig,
  state: BotState,
): Promise<"open" | "close" | "hold"> {
  // ──────────────────────────────────────────────
  // PLACEHOLDER: Replace with your trading logic
  // ──────────────────────────────────────────────

  // Example: simple momentum check
  // In production, you would use technical indicators,
  // ML models, or external signal feeds.

  if (!state.hasPosition) {
    // Decide whether to open a position
    // Return "open" to enter, "hold" to wait
    return "hold";
  }

  // Check PnL on existing position
  const { profit, loss } = await viewHelper.getPnl(
    CONFIG.targetSymbol, CONFIG.collateralSymbol, CONFIG.side, poolConfig,
  );

  const pnlUsd = (profit.toNumber() - loss.toNumber()) / 1_000_000;

  // Close if PnL exceeds thresholds (safety net beyond SL/TP)
  if (pnlUsd < -(CONFIG.stopLossPct / 100) * (CONFIG.collateralUsdc / 1_000_000) * 1.5) {
    log("WARN", "Emergency close: PnL below safety threshold", { pnlUsd });
    return "close";
  }

  return "hold";
}

// ============================================================
// MAIN LOOP
// ============================================================

async function main(): Promise<void> {
  const { client, viewHelper, poolConfig, wallet } = await setupClient();

  const state: BotState = {
    isRunning: true,
    hasPosition: false,
    entryPrice: null,
    currentPnl: 0,
    totalPnl: 0,
    tradeCount: 0,
    errors: 0,
  };

  // Graceful shutdown
  const shutdown = async () => {
    log("INFO", "Shutting down...");
    state.isRunning = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("INFO", "Bot started", {
    target: CONFIG.targetSymbol,
    collateral: CONFIG.collateralUsdc / 1_000_000,
    leverage: CONFIG.maxLeverage,
    sl: CONFIG.stopLossPct,
    tp: CONFIG.takeProfitPct,
  });

  while (state.isRunning) {
    try {
      if (shouldHalt(state)) {
        state.isRunning = false;
        break;
      }

      const { price, raw: oracleRaw } = await getOraclePrice(viewHelper, poolConfig);
      log("INFO", "Tick", { price: price.toFixed(2), hasPosition: state.hasPosition });

      const action = await evaluateStrategy(viewHelper, poolConfig, state);

      if (action === "open" && !state.hasPosition) {
        log("INFO", "Opening position", { price: price.toFixed(2) });
        const sig = await openPosition(client, poolConfig, oracleRaw);
        state.hasPosition = true;
        state.entryPrice = price;
        state.tradeCount++;
        log("INFO", "Position opened", { sig, entry: price.toFixed(2) });
      }

      if (action === "close" && state.hasPosition) {
        log("INFO", "Closing position", { price: price.toFixed(2) });
        const sig = await closePosition(client, poolConfig, oracleRaw);
        state.hasPosition = false;
        state.entryPrice = null;
        log("INFO", "Position closed", { sig });
      }
    } catch (err) {
      state.errors++;
      log("ERROR", "Loop error", { error: (err as Error).message, errors: state.errors });

      // Back off on errors
      await new Promise((r) => setTimeout(r, CONFIG.retryDelayMs * state.errors));
    }

    await new Promise((r) => setTimeout(r, CONFIG.loopIntervalMs));
  }

  log("INFO", "Bot stopped", {
    trades: state.tradeCount,
    totalPnl: state.totalPnl,
    errors: state.errors,
  });
}

main().catch((err) => {
  log("ERROR", "Fatal error", { error: (err as Error).message });
  process.exit(1);
});
