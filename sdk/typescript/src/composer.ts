import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import type { Phalnx, ComposeActionParams } from "./types";
import {
  buildValidateAndAuthorize,
  buildFinalizeSession,
} from "./instructions";
import {
  estimateComposedCU,
  CU_DEFAULT_COMPOSED,
  type PriorityFeeConfig,
  getEstimator,
} from "./priority-fees";

/**
 * Build an atomic composed transaction:
 * [ComputeBudget, PriorityFee?, ValidateAndAuthorize, ...defiInstructions, FinalizeSession]
 *
 * All instructions succeed or all revert atomically.
 *
 * CU budget is automatically sized to the detected DeFi protocol unless overridden.
 * Priority fees are injected when a connection is provided.
 */
export async function composePermittedAction(
  program: Program<Phalnx>,
  params: ComposeActionParams,
  computeUnits?: number,
  connection?: Connection,
  priorityFeeConfig?: PriorityFeeConfig,
): Promise<TransactionInstruction[]> {
  const units = computeUnits ?? estimateComposedCU(params.defiInstructions);

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units });

  const validateIx = await buildValidateAndAuthorize(
    program,
    params.agent,
    params.vault,
    params.vaultTokenAccount,
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

  const finalizeIx = await buildFinalizeSession(
    program,
    params.agent,
    params.vault,
    params.agent,
    params.tokenMint,
    params.success ?? true,
    params.vaultTokenAccount,
    params.outputStablecoinAccount,
  ).instruction();

  const instructions: TransactionInstruction[] = [computeBudgetIx];

  // Inject priority fee if connection is available
  if (connection) {
    try {
      const estimator = getEstimator(connection, priorityFeeConfig);
      const priorityFeeIx = await estimator.buildPriorityFeeIx();
      instructions.push(priorityFeeIx);
    } catch {
      // Priority fee estimation failed — proceed without it rather than blocking
    }
  }

  instructions.push(validateIx, ...params.defiInstructions, finalizeIx);

  return instructions;
}

/**
 * Build and return a VersionedTransaction for a composed permitted action.
 * The transaction is NOT signed — caller must sign with the agent keypair.
 *
 * Automatically includes right-sized CU budget and priority fees.
 */
export async function composePermittedTransaction(
  program: Program<Phalnx>,
  connection: Connection,
  params: ComposeActionParams,
  computeUnits?: number,
  priorityFeeConfig?: PriorityFeeConfig,
): Promise<VersionedTransaction> {
  const instructions = await composePermittedAction(
    program,
    params,
    computeUnits,
    connection,
    priorityFeeConfig,
  );
  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: params.agent,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}

/**
 * Convenience: compose a swap action specifically.
 * Wraps composePermittedAction with actionType = { swap: {} }.
 */
export async function composePermittedSwap(
  program: Program<Phalnx>,
  params: Omit<ComposeActionParams, "actionType">,
  computeUnits?: number,
  connection?: Connection,
  priorityFeeConfig?: PriorityFeeConfig,
): Promise<TransactionInstruction[]> {
  return composePermittedAction(
    program,
    { ...params, actionType: { swap: {} } },
    computeUnits,
    connection,
    priorityFeeConfig,
  );
}
