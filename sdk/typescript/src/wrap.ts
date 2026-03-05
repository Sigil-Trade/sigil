import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  Connection,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Phalnx, ActionType } from "./types";
import { getVaultPDA, getPolicyPDA } from "./accounts";
import {
  buildValidateAndAuthorize,
  buildFinalizeSession,
} from "./instructions";
import { rewriteVaultAuthority } from "./rewriter";
import {
  estimateComposedCU,
  type PriorityFeeConfig,
  getEstimator,
} from "./priority-fees";

export interface WrapTransactionParams {
  /** Vault PDA */
  vault: PublicKey;
  /** Vault owner pubkey */
  owner: PublicKey;
  /** Vault ID */
  vaultId: BN;
  /** Agent signer pubkey */
  agent: PublicKey;
  /** Raw DeFi instruction(s) — will be authority-rewritten */
  defiInstructions: TransactionInstruction[];
  /** Token mint being spent */
  tokenMint: PublicKey;
  /** Amount in base units */
  amount: BN;
  /** Target DeFi protocol program ID */
  targetProtocol: PublicKey;
  /** Action type (swap, openPosition, etc.) */
  actionType: ActionType;
  /** Leverage in basis points (for perp actions) */
  leverageBps?: number | null;
  /** Address lookup tables for compact transaction encoding */
  addressLookupTables?: AddressLookupTableAccount[];
  /** Compute unit budget override (auto-detected if omitted) */
  computeUnits?: number;
  /** Protocol treasury token account (optional) */
  protocolTreasuryTokenAccount?: PublicKey | null;
  /** Fee destination token account (optional) */
  feeDestinationTokenAccount?: PublicKey | null;
  /** Output stablecoin account for non-stablecoin swaps (vault's stablecoin ATA) */
  outputStablecoinAccount?: PublicKey;
  /** Priority fee configuration (auto-configured if omitted) */
  priorityFeeConfig?: PriorityFeeConfig;
}

/**
 * Wrap arbitrary DeFi instructions into a complete Phalnx transaction.
 *
 * This is the protocol-agnostic entry point. It:
 * 1. Resolves the vault's token account
 * 2. Rewrites authority in DeFi instructions (vault PDA → agent)
 * 3. Builds: [ComputeBudget, PriorityFee, ValidateAndAuthorize, ...defi, FinalizeSession]
 * 4. Returns an unsigned VersionedTransaction
 *
 * CU budget is automatically sized. Priority fees are automatically estimated.
 */
export async function wrapTransaction(
  program: Program<Phalnx>,
  connection: Connection,
  params: WrapTransactionParams,
): Promise<VersionedTransaction> {
  const instructions = await wrapInstructions(program, connection, params);

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: params.agent,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(params.addressLookupTables);

  return new VersionedTransaction(messageV0);
}

/**
 * Build the instruction array for a wrapped transaction without
 * creating the VersionedTransaction. Useful when the caller needs
 * to compose further or use a different signing flow.
 */
export async function wrapInstructions(
  program: Program<Phalnx>,
  connection: Connection | null,
  params: WrapTransactionParams,
): Promise<TransactionInstruction[]> {
  const computeUnits =
    params.computeUnits ?? estimateComposedCU(params.defiInstructions);

  // Derive vault token account
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    params.vault,
    true,
  );

  // Rewrite authority in DeFi instructions
  const rewrittenDefi = rewriteVaultAuthority(
    params.defiInstructions,
    params.vault,
    params.agent,
  );

  // Compute budget
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: computeUnits,
  });

  // Validate and authorize (includes token delegation CPI + fee collection)
  const validateIx = await buildValidateAndAuthorize(
    program,
    params.agent,
    params.vault,
    vaultTokenAccount,
    {
      actionType: params.actionType,
      tokenMint: params.tokenMint,
      amount: params.amount,
      targetProtocol: params.targetProtocol,
      leverageBps: params.leverageBps,
      outputStablecoinAccount: params.outputStablecoinAccount,
    },
    params.protocolTreasuryTokenAccount,
    params.feeDestinationTokenAccount,
    params.outputStablecoinAccount,
  ).instruction();

  // Finalize session (revokes delegation, closes session PDA)
  const finalizeIx = await buildFinalizeSession(
    program,
    params.agent,
    params.vault,
    params.agent,
    params.tokenMint,
    true,
    vaultTokenAccount,
    params.outputStablecoinAccount,
  ).instruction();

  const instructions: TransactionInstruction[] = [computeIx];

  // Inject priority fee if connection is available
  if (connection) {
    try {
      const estimator = getEstimator(connection, params.priorityFeeConfig);
      const priorityFeeIx = await estimator.buildPriorityFeeIx();
      instructions.push(priorityFeeIx);
    } catch {
      // Priority fee estimation failed — proceed without it rather than blocking
    }
  }

  instructions.push(validateIx, ...rewrittenDefi, finalizeIx);

  return instructions;
}
