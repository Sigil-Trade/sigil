// ---------------------------------------------------------------------------
// Jupiter Lend / Earn API v1
// ---------------------------------------------------------------------------
// Agents earn yield on vault funds with full on-chain sandwich enforcement.
// The Lend API's `-instructions` endpoints return individual instructions,
// making it composable with our validate/finalize sandwich.
//
// Deposit = spending action (amount against spending cap)
// Withdraw = non-spending (amount = 0)
// ---------------------------------------------------------------------------

import { PublicKey, TransactionInstruction, Connection } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Phalnx, ComposeActionParams } from "../types";
import { getVaultPDA } from "../accounts";
import { composePermittedAction } from "../composer";
import { jupiterFetch } from "./jupiter-api";
import {
  deserializeInstruction,
  type JupiterSerializedInstruction,
} from "./jupiter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jupiter Lend program ID (mainnet) */
export const JUPITER_LEND_PROGRAM_ID = new PublicKey(
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu",
);

/** Jupiter Borrow/Vaults program ID (mainnet) */
export const JUPITER_BORROW_PROGRAM_ID = new PublicKey(
  "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JupiterLendTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  apy: number;
  totalDeposited: string;
  totalBorrowed: string;
  utilizationRate: number;
}

export interface JupiterEarnPosition {
  mint: string;
  amount: string;
  value: string;
  apy: number;
}

export interface JupiterLendDepositParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  tokenMint: PublicKey;
  amount: BN;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

export interface JupiterLendWithdrawParams {
  owner: PublicKey;
  vaultId: BN;
  agent: PublicKey;
  tokenMint: PublicKey;
  amount: BN;
  vaultTokenAccount?: PublicKey | null;
  feeDestinationTokenAccount?: PublicKey | null;
}

interface LendInstructionsResponse {
  setupInstructions: JupiterSerializedInstruction[];
  mainInstruction: JupiterSerializedInstruction;
  cleanupInstructions: JupiterSerializedInstruction[];
  addressLookupTableAddresses: string[];
}

// ---------------------------------------------------------------------------
// Read-Only API Functions
// ---------------------------------------------------------------------------

/**
 * Get available tokens for Jupiter Lend/Earn with APY rates.
 */
export async function getJupiterLendTokens(): Promise<JupiterLendTokenInfo[]> {
  return jupiterFetch<JupiterLendTokenInfo[]>("/lend/v1/earn/tokens");
}

/**
 * Get earn positions for a user.
 *
 * @param user - Wallet address to check.
 * @param positions - Position mint addresses to query.
 */
export async function getJupiterEarnPositions(
  user: string,
  positions: string[],
): Promise<JupiterEarnPosition[]> {
  const qs = new URLSearchParams({ user });
  for (const p of positions) {
    qs.append("positions", p);
  }
  return jupiterFetch<JupiterEarnPosition[]>(
    `/lend/v1/earn/positions?${qs.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Composable Functions (sandwich pattern)
// ---------------------------------------------------------------------------

/**
 * Compose a Jupiter Lend deposit through Phalnx.
 *
 * Deposit is a spending action — amount counts against the daily spending cap.
 * Returns instructions for the sandwich: [validate, ...lendIxs, finalize].
 */
export async function composeJupiterLendDeposit(
  program: Program<Phalnx>,
  connection: Connection,
  params: JupiterLendDepositParams,
): Promise<{ instructions: TransactionInstruction[] }> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  // Fetch deposit instructions from Jupiter Lend API
  const response = await jupiterFetch<LendInstructionsResponse>(
    "/lend/v1/earn/deposit-instructions",
    {
      method: "POST",
      body: {
        userPublicKey: vault.toBase58(),
        mint: params.tokenMint.toBase58(),
        amount: params.amount.toString(),
      },
    },
  );

  // Deserialize Jupiter Lend instructions
  const defiInstructions: TransactionInstruction[] = [];
  for (const ix of response.setupInstructions) {
    defiInstructions.push(deserializeInstruction(ix));
  }
  defiInstructions.push(deserializeInstruction(response.mainInstruction));
  for (const ix of response.cleanupInstructions) {
    defiInstructions.push(deserializeInstruction(ix));
  }

  // Compose with Phalnx validate/finalize sandwich
  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(params.tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { deposit: {} },
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: JUPITER_LEND_PROGRAM_ID,
    defiInstructions,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions };
}

/**
 * Compose a Jupiter Lend withdrawal through Phalnx.
 *
 * Withdraw is a non-spending action — amount does not count against cap.
 * Returns instructions for the sandwich: [validate, ...lendIxs, finalize].
 */
export async function composeJupiterLendWithdraw(
  program: Program<Phalnx>,
  connection: Connection,
  params: JupiterLendWithdrawParams,
): Promise<{ instructions: TransactionInstruction[] }> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  // Fetch withdraw instructions from Jupiter Lend API
  const response = await jupiterFetch<LendInstructionsResponse>(
    "/lend/v1/earn/withdraw-instructions",
    {
      method: "POST",
      body: {
        userPublicKey: vault.toBase58(),
        mint: params.tokenMint.toBase58(),
        amount: params.amount.toString(),
      },
    },
  );

  // Deserialize Jupiter Lend instructions
  const defiInstructions: TransactionInstruction[] = [];
  for (const ix of response.setupInstructions) {
    defiInstructions.push(deserializeInstruction(ix));
  }
  defiInstructions.push(deserializeInstruction(response.mainInstruction));
  for (const ix of response.cleanupInstructions) {
    defiInstructions.push(deserializeInstruction(ix));
  }

  // Compose with Phalnx validate/finalize sandwich
  // Withdraw is non-spending: amount = 0
  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(params.tokenMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { withdraw: {} },
    tokenMint: params.tokenMint,
    amount: new BN(0), // Non-spending
    targetProtocol: JUPITER_LEND_PROGRAM_ID,
    defiInstructions,
    success: true,
    vaultTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount,
  };

  const instructions = await composePermittedAction(
    program,
    composeParams,
    undefined,
    connection,
  );

  return { instructions };
}
