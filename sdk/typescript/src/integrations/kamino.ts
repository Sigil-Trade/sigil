/**
 * Kamino Lending Adapter
 *
 * Compose functions for integrating Kamino Lend (klend) deposit, borrow,
 * repay, and withdraw with Phalnx vault authorization.
 *
 * Uses @kamino-finance/klend-sdk to build instruction arrays
 * (setupIxs + lendingIxs + cleanupIxs) for composition with
 * composePermittedAction().
 *
 * @requires @kamino-finance/klend-sdk — optional dependency, loaded lazily
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

// ─── Kamino Program IDs ──────────────────────────────────────────────────────

/** Kamino Lend (klend) mainnet program ID */
export const KAMINO_LEND_PROGRAM_ID_STR =
  "KLend2g3cP87ber8p1S4JQoTnbs78GDYAHB6h4WjSD9";

/** Kamino main lending market (mainnet) */
export const KAMINO_MAIN_MARKET_STR =
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

// ─── Param Types ─────────────────────────────────────────────────────────────

export interface KaminoDepositParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  /** Deposit amount in token base units */
  amount: BN;
  /** Token mint address */
  tokenMint: PublicKey;
  /** Kamino lending market address (defaults to main market) */
  market?: PublicKey;
  /** Fee destination token account (optional) */
  feeDestinationTokenAccount?: PublicKey;
}

export interface KaminoBorrowParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  amount: BN;
  tokenMint: PublicKey;
  market?: PublicKey;
  feeDestinationTokenAccount?: PublicKey;
}

export interface KaminoRepayParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  amount: BN;
  tokenMint: PublicKey;
  market?: PublicKey;
  feeDestinationTokenAccount?: PublicKey;
}

export interface KaminoWithdrawParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  amount: BN;
  tokenMint: PublicKey;
  market?: PublicKey;
  feeDestinationTokenAccount?: PublicKey;
}

export interface KaminoComposeResult {
  instructions: TransactionInstruction[];
  additionalSigners: Signer[];
}

// ─── Lazy SDK Import ─────────────────────────────────────────────────────────
// @kamino-finance/klend-sdk is an optional dependency — loaded dynamically.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _kaminoSdk: any = null;

async function getKaminoSdk(): Promise<any> {
  if (!_kaminoSdk) {
    try {
      // Dynamic require to avoid TypeScript checking optional dependency at compile time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _kaminoSdk = require("@kamino-finance/klend-sdk");
    } catch {
      throw new Error(
        "@kamino-finance/klend-sdk is required for Kamino integration. Install it: pnpm add @kamino-finance/klend-sdk",
      );
    }
  }
  return _kaminoSdk;
}

// ─── Market Cache ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _marketCache = new Map<string, any>();

/**
 * Load and cache a KaminoMarket instance.
 * KaminoMarket.load() is stateless — no persistent client needed.
 */
async function loadKaminoMarket(
  connection: Connection,
  marketAddress: PublicKey,
): Promise<any> {
  const key = marketAddress.toBase58();
  if (_marketCache.has(key)) {
    return _marketCache.get(key);
  }

  const sdk = await getKaminoSdk();
  const market = await sdk.KaminoMarket.load(connection, marketAddress);
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${key}`);
  }
  _marketCache.set(key, market);
  return market;
}

function getDefaultMarket(): PublicKey {
  // Import PublicKey dynamically to avoid import order issues
  const { PublicKey: PK } = require("@solana/web3.js");
  return new PK(KAMINO_MAIN_MARKET_STR);
}

// ─── Helper: Extract Instructions from KaminoAction ──────────────────────────

/**
 * KaminoAction returns { setupIxs, lendingIxs, cleanupIxs }.
 * Concatenate all three for the composed transaction.
 */
function extractKaminoInstructions(action: any): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (action.setupIxs?.length) ixs.push(...action.setupIxs);
  if (action.lendingIxs?.length) ixs.push(...action.lendingIxs);
  if (action.cleanupIxs?.length) ixs.push(...action.cleanupIxs);
  return ixs;
}

// ─── Compose Functions ───────────────────────────────────────────────────────

/**
 * Compose a Kamino deposit instruction wrapped in Phalnx validate/finalize.
 * ActionType: deposit (spending) — tokens leave vault into lending pool.
 */
export async function composeKaminoDeposit(
  program: Program<Phalnx>,
  connection: Connection,
  params: KaminoDepositParams,
): Promise<KaminoComposeResult> {
  const sdk = await getKaminoSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);
  const marketAddress = params.market ?? getDefaultMarket();

  const market = await loadKaminoMarket(connection, marketAddress);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const kaminoAction = await sdk.KaminoAction.buildDepositTxns(
    market,
    params.amount.toString(),
    params.tokenMint,
    vault,
    {} as any, // obligation — auto-derived
  );

  const defiInstructions = extractKaminoInstructions(kaminoAction);

  const kaminoProgramId = new (require("@solana/web3.js").PublicKey)(
    KAMINO_LEND_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { deposit: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: kaminoProgramId,
    defiInstructions,
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
 * Compose a Kamino borrow instruction wrapped in Phalnx validate/finalize.
 * ActionType: withdraw (non-spending) — tokens flow INTO vault from lending pool.
 *
 * Borrow is non-spending because from Phalnx's perspective, tokens enter
 * the vault. The lending obligation is the liability, not a vault outflow.
 */
export async function composeKaminoBorrow(
  program: Program<Phalnx>,
  connection: Connection,
  params: KaminoBorrowParams,
): Promise<KaminoComposeResult> {
  const sdk = await getKaminoSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);
  const marketAddress = params.market ?? getDefaultMarket();

  const market = await loadKaminoMarket(connection, marketAddress);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const kaminoAction = await sdk.KaminoAction.buildBorrowTxns(
    market,
    params.amount.toString(),
    params.tokenMint,
    vault,
    {} as any, // obligation — auto-derived
  );

  const defiInstructions = extractKaminoInstructions(kaminoAction);

  const kaminoProgramId = new (require("@solana/web3.js").PublicKey)(
    KAMINO_LEND_PROGRAM_ID_STR,
  );

  const { BN: BNClass } = require("@coral-xyz/anchor");

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { withdraw: {} },
    tokenMint: params.tokenMint,
    amount: new BNClass(0), // non-spending
    targetProtocol: kaminoProgramId,
    defiInstructions,
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
 * Compose a Kamino repay instruction wrapped in Phalnx validate/finalize.
 * ActionType: deposit (spending) — tokens leave vault to repay obligation.
 */
export async function composeKaminoRepay(
  program: Program<Phalnx>,
  connection: Connection,
  params: KaminoRepayParams,
): Promise<KaminoComposeResult> {
  const sdk = await getKaminoSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);
  const marketAddress = params.market ?? getDefaultMarket();

  const market = await loadKaminoMarket(connection, marketAddress);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const kaminoAction = await sdk.KaminoAction.buildRepayTxns(
    market,
    params.amount.toString(),
    params.tokenMint,
    vault,
    {} as any, // obligation — auto-derived
  );

  const defiInstructions = extractKaminoInstructions(kaminoAction);

  const kaminoProgramId = new (require("@solana/web3.js").PublicKey)(
    KAMINO_LEND_PROGRAM_ID_STR,
  );

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { deposit: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: kaminoProgramId,
    defiInstructions,
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
 * Compose a Kamino withdraw instruction wrapped in Phalnx validate/finalize.
 * ActionType: withdraw (non-spending) — tokens return from lending pool to vault.
 */
export async function composeKaminoWithdraw(
  program: Program<Phalnx>,
  connection: Connection,
  params: KaminoWithdrawParams,
): Promise<KaminoComposeResult> {
  const sdk = await getKaminoSdk();
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);
  const marketAddress = params.market ?? getDefaultMarket();

  const market = await loadKaminoMarket(connection, marketAddress);

  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    vault,
    true,
  );

  const kaminoAction = await sdk.KaminoAction.buildWithdrawTxns(
    market,
    params.amount.toString(),
    params.tokenMint,
    vault,
    {} as any, // obligation — auto-derived
  );

  const defiInstructions = extractKaminoInstructions(kaminoAction);

  const kaminoProgramId = new (require("@solana/web3.js").PublicKey)(
    KAMINO_LEND_PROGRAM_ID_STR,
  );

  const { BN: BNClass } = require("@coral-xyz/anchor");

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { withdraw: {} },
    tokenMint: params.tokenMint,
    amount: new BNClass(0), // non-spending
    targetProtocol: kaminoProgramId,
    defiInstructions,
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
