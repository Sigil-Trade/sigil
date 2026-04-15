/**
 * Kit-native pipe() transaction composer for Sigil.
 *
 * Builds atomic composed transactions:
 * [ComputeBudget, PriorityFee?, ValidateAndAuthorize, ...defiIxs, FinalizeSession]
 */

import type { Address, Instruction } from "@solana/kit";
import type { AddressesByLookupTableAddress } from "@solana/kit";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compressTransactionMessageUsingAddressLookupTables,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { estimateComposedCU, CU_DEFAULT_COMPOSED } from "./priority-fees.js";
import { SigilRpcError } from "./errors/rpc.js";
import { SIGIL_ERROR__RPC__TX_TOO_LARGE } from "./errors/codes.js";

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
  /** Resolved address lookup tables for transaction compression */
  addressLookupTables?: AddressesByLookupTableAddress;
}

/**
 * Build an atomic composed transaction using Kit's pipe().
 *
 * Transaction order: [ComputeBudget, PriorityFee?, Validate, ...DeFi, Finalize]
 * All instructions succeed or all revert atomically.
 */
export function composeSigilTransaction(
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

  let txMessage = pipe(
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

  // Apply ALT compression if lookup tables provided
  if (
    params.addressLookupTables &&
    Object.keys(params.addressLookupTables).length > 0
  ) {
    txMessage = compressTransactionMessageUsingAddressLookupTables(
      txMessage as Parameters<
        typeof compressTransactionMessageUsingAddressLookupTables
      >[0],
      params.addressLookupTables,
    ) as typeof txMessage;
  }

  return compileTransaction(
    txMessage as Parameters<typeof compileTransaction>[0],
  );
}

/**
 * Compute actual byte length from a padded base64 string.
 * The naive `Math.ceil(len * 3 / 4)` overestimates by 1-2 bytes
 * when padding is present (RFC 4648). At the 1232-byte TX limit,
 * this causes false rejections of valid transactions.
 */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  let padding = 0;
  if (len > 0 && b64[len - 1] === "=") padding++;
  if (len > 1 && b64[len - 2] === "=") padding++;
  return (len / 4) * 3 - padding;
}

/**
 * Validate that a compiled transaction doesn't exceed the Solana size limit.
 * Returns the base64-encoded wire transaction if valid, throws if too large.
 */
export function validateTransactionSize(
  compiledTx: ReturnType<typeof compileTransaction>,
): string {
  const wireBytes = getBase64EncodedWireTransaction(compiledTx);
  const byteLength = base64ByteLength(wireBytes);
  if (byteLength > MAX_TX_SIZE) {
    throw new SigilRpcError(
      SIGIL_ERROR__RPC__TX_TOO_LARGE,
      `Transaction size ${byteLength} bytes exceeds limit of ${MAX_TX_SIZE} bytes. ` +
        `Use address lookup tables or reduce instruction count.`,
      { context: { byteLength, limit: MAX_TX_SIZE } },
    );
  }
  return wireBytes;
}

/**
 * Measure transaction wire size without throwing.
 * Non-throwing alternative to validateTransactionSize for pre-send checks.
 */
export function measureTransactionSize(
  compiledTx: ReturnType<typeof compileTransaction>,
): {
  wireBase64: string;
  byteLength: number;
  withinLimit: boolean;
} {
  const wireBase64 = getBase64EncodedWireTransaction(compiledTx);
  const byteLength = base64ByteLength(wireBase64);
  return { wireBase64, byteLength, withinLimit: byteLength <= MAX_TX_SIZE };
}

/** Exported for use in fallback checks */
export { MAX_TX_SIZE };
