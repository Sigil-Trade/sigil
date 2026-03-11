/**
 * Kit-native pipe() transaction composer for Phalnx.
 *
 * Builds atomic composed transactions:
 * [ComputeBudget, PriorityFee?, ValidateAndAuthorize, ...defiIxs, FinalizeSession]
 */

import type { Address, Instruction } from "@solana/kit";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { estimateComposedCU, CU_DEFAULT_COMPOSED } from "./priority-fees.js";

/** Maximum Solana transaction size in bytes */
const MAX_TX_SIZE = 1_232;

export interface ComposeTransactionParams {
  /** Fee payer (typically the agent) */
  feePayer: Address;
  /** The validate_and_authorize instruction */
  validateIx: Instruction;
  /** DeFi protocol instruction(s) to sandwich */
  defiInstructions: Instruction[];
  /** The finalize_session instruction */
  finalizeIx: Instruction;
  /** Recent blockhash for lifetime */
  blockhash: {
    blockhash: string;
    lastValidBlockHeight: bigint;
  };
  /** Optional: override CU limit */
  computeUnits?: number;
  /** Optional: priority fee in microLamports per CU */
  priorityFeeMicroLamports?: number;
  /** Optional: address lookup tables (Kit format) */
  addressLookupTables?: readonly unknown[];
}

/**
 * Build an atomic composed transaction using Kit's pipe().
 *
 * Transaction order: [ComputeBudget, PriorityFee?, Validate, ...DeFi, Finalize]
 * All instructions succeed or all revert atomically.
 */
export function composePhalnxTransaction(
  params: ComposeTransactionParams,
): ReturnType<typeof compileTransaction> {
  const units =
    params.computeUnits ?? estimateComposedCU(params.defiInstructions);

  const computeBudgetIx = getSetComputeUnitLimitInstruction({ units });

  const allInstructions: Instruction[] = [computeBudgetIx];

  if (
    params.priorityFeeMicroLamports !== undefined &&
    params.priorityFeeMicroLamports > 0
  ) {
    const priorityFeeIx = getSetComputeUnitPriceInstruction({
      microLamports: params.priorityFeeMicroLamports,
    });
    allInstructions.push(priorityFeeIx);
  }

  allInstructions.push(
    params.validateIx,
    ...params.defiInstructions,
    params.finalizeIx,
  );

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(params.feePayer, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        params.blockhash as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0],
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(allInstructions, tx),
  );

  return compileTransaction(txMessage as any);
}

/**
 * Validate that a compiled transaction doesn't exceed the Solana size limit.
 * Returns the base64-encoded wire transaction if valid, throws if too large.
 */
export function validateTransactionSize(
  compiledTx: ReturnType<typeof compileTransaction>,
): string {
  const wireBytes = getBase64EncodedWireTransaction(compiledTx);
  // Base64 encodes 3 bytes as 4 chars. Decode to check actual size.
  const byteLength = Math.ceil((wireBytes.length * 3) / 4);
  if (byteLength > MAX_TX_SIZE) {
    throw new Error(
      `Transaction size ${byteLength} bytes exceeds limit of ${MAX_TX_SIZE} bytes. ` +
        `Use address lookup tables or reduce instruction count.`,
    );
  }
  return wireBytes;
}
