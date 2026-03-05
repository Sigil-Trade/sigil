import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Connection,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Phalnx, ComposeActionParams } from "../types";
import { getVaultPDA } from "../accounts";
import { composePermittedAction } from "../composer";
import { jupiterFetch } from "./jupiter-api";

// Re-export JupiterApiError from the canonical location
export { JupiterApiError } from "./jupiter-api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @deprecated Use jupiterFetch with path constants instead. Kept for backwards compat. */
export const JUPITER_V6_API = "https://api.jup.ag";
export const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JupiterQuoteParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  /** Raw token amount (lamports / smallest unit) */
  amount: BN;
  /** Slippage in basis points. Default 50 (0.5%) */
  slippageBps?: number;
  /** Additional query params forwarded to the Jupiter quote API */
  extraParams?: Record<string, string>;
}

export interface JupiterRoutePlanStep {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot: number;
  timeTaken: number;
}

/** Serialized instruction format returned by Jupiter swap-instructions API */
export interface JupiterSerializedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: JupiterSerializedInstruction;
  computeBudgetInstructions: JupiterSerializedInstruction[];
  setupInstructions: JupiterSerializedInstruction[];
  swapInstruction: JupiterSerializedInstruction;
  cleanupInstruction?: JupiterSerializedInstruction;
  addressLookupTableAddresses: string[];
}

export interface JupiterSwapParams {
  /** Vault owner pubkey */
  owner: PublicKey;
  /** Vault ID (BN) */
  vaultId: BN;
  /** Agent signing key */
  agent: PublicKey;
  /** Input token mint */
  inputMint: PublicKey;
  /** Output token mint */
  outputMint: PublicKey;
  /** Amount in smallest units */
  amount: BN;
  /** Slippage in bps (default 50) */
  slippageBps?: number;
  /** Pre-fetched quote — skips the quote API call if provided */
  quote?: JupiterQuoteResponse;
  /** Optional: vault token account for fee deduction */
  vaultTokenAccount?: PublicKey | null;
  /** Optional: fee destination token account */
  feeDestinationTokenAccount?: PublicKey | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deserialize a Jupiter serialized instruction into a Solana TransactionInstruction.
 */
export function deserializeInstruction(
  ix: JupiterSerializedInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Fetch a swap quote from the Jupiter V6 API.
 */
export async function fetchJupiterQuote(
  params: JupiterQuoteParams,
): Promise<JupiterQuoteResponse> {
  const slippage = params.slippageBps ?? 50;
  const qs = new URLSearchParams({
    inputMint: params.inputMint.toBase58(),
    outputMint: params.outputMint.toBase58(),
    amount: params.amount.toString(),
    slippageBps: slippage.toString(),
    ...params.extraParams,
  });

  return jupiterFetch<JupiterQuoteResponse>(`/v6/quote?${qs.toString()}`, {
    timeoutMs: 5_000,
  });
}

/**
 * Fetch deserialized swap instructions from Jupiter V6 API.
 *
 * @param quote - A quote previously obtained from `fetchJupiterQuote`.
 * @param userPublicKey - The account that owns the input tokens. For
 *   Phalnx, this should be the **vault PDA** (the vault owns the ATAs).
 */
export async function fetchJupiterSwapInstructions(
  quote: JupiterQuoteResponse,
  userPublicKey: PublicKey,
): Promise<JupiterSwapInstructionsResponse> {
  return jupiterFetch<JupiterSwapInstructionsResponse>(
    "/v6/swap-instructions",
    {
      method: "POST",
      body: {
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    },
  );
}

/**
 * Fetch address lookup table accounts for a set of table addresses.
 */
export async function fetchAddressLookupTables(
  connection: Connection,
  tableAddresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (tableAddresses.length === 0) return [];

  const results = await Promise.all(
    tableAddresses.map((addr) =>
      connection.getAddressLookupTable(new PublicKey(addr)),
    ),
  );

  return results
    .filter((r) => r.value !== null)
    .map((r) => r.value as AddressLookupTableAccount);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Build a full Phalnx-composed Jupiter swap transaction.
 *
 * Returns an array of TransactionInstructions:
 * `[ComputeBudget, ValidateAndAuthorize, ...setupIxs, swapIx, cleanupIx?, FinalizeSession]`
 *
 * The DeFi instructions (setup + swap + cleanup) are sandwiched between
 * validate and finalize, forming an atomic composed transaction.
 *
 * @param program - The Phalnx Anchor program instance.
 * @param connection - Solana connection (needed for address lookup tables).
 * @param params - Jupiter swap parameters including vault/agent info.
 * @returns Instructions array + address lookup tables for VersionedTransaction.
 */
export async function composeJupiterSwap(
  program: Program<Phalnx>,
  connection: Connection,
  params: JupiterSwapParams,
): Promise<{
  instructions: TransactionInstruction[];
  addressLookupTables: AddressLookupTableAccount[];
}> {
  const [vault] = getVaultPDA(params.owner, params.vaultId, program.programId);

  // 1. Get quote (use pre-fetched or fetch new)
  let quote =
    params.quote ??
    (await fetchJupiterQuote({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: params.slippageBps,
    }));

  // Staleness check: re-quote if pre-fetched quote is >30 slots old (~12s)
  if (params.quote && quote.contextSlot) {
    const currentSlot = await connection.getSlot("confirmed");
    if (currentSlot - quote.contextSlot > 30) {
      quote = await fetchJupiterQuote({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: params.slippageBps,
      });
    }
  }

  // 2. Get swap instructions from Jupiter with vault PDA as the user
  const swapResponse = await fetchJupiterSwapInstructions(quote, vault);

  // 3. Deserialize Jupiter instructions
  const defiInstructions: TransactionInstruction[] = [];

  for (const ix of swapResponse.setupInstructions) {
    defiInstructions.push(deserializeInstruction(ix));
  }

  defiInstructions.push(deserializeInstruction(swapResponse.swapInstruction));

  if (swapResponse.cleanupInstruction) {
    defiInstructions.push(
      deserializeInstruction(swapResponse.cleanupInstruction),
    );
  }

  // 4. Fetch address lookup tables
  const addressLookupTables = await fetchAddressLookupTables(
    connection,
    swapResponse.addressLookupTableAddresses,
  );

  // 5. Compose with Phalnx validate/finalize sandwich
  const vaultTokenAccount =
    params.vaultTokenAccount ??
    getAssociatedTokenAddressSync(params.inputMint, vault, true);

  const composeParams: ComposeActionParams = {
    vault,
    owner: params.owner,
    vaultId: params.vaultId,
    agent: params.agent,
    actionType: { swap: {} },
    tokenMint: params.inputMint,
    amount: params.amount,
    targetProtocol: JUPITER_PROGRAM_ID,
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

  return { instructions, addressLookupTables };
}

/**
 * Build a complete VersionedTransaction for a Jupiter swap through Phalnx.
 *
 * The transaction is NOT signed — caller must sign with the agent keypair.
 */
export async function composeJupiterSwapTransaction(
  program: Program<Phalnx>,
  connection: Connection,
  params: JupiterSwapParams,
): Promise<VersionedTransaction> {
  const { instructions, addressLookupTables } = await composeJupiterSwap(
    program,
    connection,
    params,
  );

  const { blockhash } = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: params.agent,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTables);

  return new VersionedTransaction(messageV0);
}
