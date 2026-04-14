/**
 * Owner-side transaction builder for Sigil dashboard.
 *
 * Builds complete versioned transactions for owner-only instructions
 * (freeze, deposit, withdraw, policy changes, agent management, constraints).
 * Returns compiled (unsigned) transactions for wallet adapter signing.
 *
 * Unlike composeSigilTransaction() which builds the agent-side
 * validate→DeFi→finalize sandwich, owner transactions are direct
 * program calls with compute budget and ALT compression.
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
  AddressesByLookupTableAddress,
} from "@solana/kit";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compressTransactionMessageUsingAddressLookupTables,
  compileTransaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { measureTransactionSize, MAX_TX_SIZE } from "./composer.js";
import { getBlockhashCache, type Blockhash } from "./rpc-helpers.js";
import { AltCache } from "./alt-loader.js";
import { getSigilAltAddress } from "./alt-config.js";
import { CU_OWNER_ACTION } from "./priority-fees.js";
import { normalizeNetwork, type Network } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BuildOwnerTransactionParams {
  /** RPC client for blockhash + ALT resolution. */
  rpc: Rpc<SolanaRpcApi>;
  /** Owner signer (fee payer). */
  owner: TransactionSigner;
  /** One or more Sigil owner instructions. */
  instructions: Instruction[];
  /** Network for ALT resolution. */
  network: "devnet" | "mainnet";
  /** Override compute units. Default: CU_OWNER_ACTION (200,000). */
  computeUnits?: number;
  /** Priority fee in microLamports per CU. Default: 0 (no priority fee). */
  priorityFeeMicroLamports?: number;
  /** Pre-resolved ALTs. If omitted, resolves Sigil ALT automatically. */
  addressLookupTables?: AddressesByLookupTableAddress;
  /** Pre-fetched blockhash. If omitted, fetches via RPC. */
  blockhash?: Blockhash;
}

export interface OwnerTransactionResult {
  /** Compiled versioned transaction (caller signs with wallet adapter). */
  transaction: ReturnType<typeof compileTransaction>;
  /** Wire size in bytes. */
  txSizeBytes: number;
  /** Base64-encoded wire transaction (for display/debugging). */
  wireBase64: string;
}

// ─── Module-level caches ────────────────────────────────────────────────────
// Per-RPC blockhash cache lives in `rpc-helpers.getBlockhashCache(rpc)`; see
// its JSDoc for why we no longer hold a module-level singleton. `AltCache`
// stays module-level — ALTs are address-keyed and safe to share.

const altCache = new AltCache();

// ─── buildOwnerTransaction ──────────────────────────────────────────────────

export async function buildOwnerTransaction(
  params: BuildOwnerTransactionParams,
): Promise<OwnerTransactionResult> {
  // 1. Validate inputs
  if (!params.instructions.length) {
    throw new Error("At least one instruction is required.");
  }

  // 2. Resolve blockhash + ALTs in parallel (independent RPC calls)
  const net = normalizeNetwork(params.network);
  const [blockhash, addressLookupTables] = await Promise.all([
    params.blockhash
      ? Promise.resolve(params.blockhash)
      : getBlockhashCache(params.rpc).get(params.rpc),
    params.addressLookupTables
      ? Promise.resolve(params.addressLookupTables)
      : altCache.resolve(params.rpc, [getSigilAltAddress(net)]),
  ]);

  // 3. Build compute budget instructions
  const computeUnits = params.computeUnits ?? CU_OWNER_ACTION;
  const allInstructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: computeUnits }),
  ];

  if (
    params.priorityFeeMicroLamports !== undefined &&
    params.priorityFeeMicroLamports > 0
  ) {
    allInstructions.push(
      getSetComputeUnitPriceInstruction({
        microLamports: params.priorityFeeMicroLamports,
      }),
    );
  }

  // 4. Append owner instructions
  allInstructions.push(...params.instructions);

  // 5. Build transaction message via pipe()
  let txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(params.owner.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        blockhash as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0],
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(allInstructions, tx),
  );

  // 6. Apply ALT compression
  if (addressLookupTables && Object.keys(addressLookupTables).length > 0) {
    txMessage = compressTransactionMessageUsingAddressLookupTables(
      txMessage as Parameters<
        typeof compressTransactionMessageUsingAddressLookupTables
      >[0],
      addressLookupTables,
    ) as typeof txMessage;
  }

  // 7. Compile and validate size
  const compiledTx = compileTransaction(
    txMessage as Parameters<typeof compileTransaction>[0],
  );
  const { wireBase64, byteLength, withinLimit } =
    measureTransactionSize(compiledTx);

  if (!withinLimit) {
    throw new Error(
      `Owner transaction size ${byteLength} bytes exceeds limit of ${MAX_TX_SIZE} bytes. ` +
        `Reduce instruction count or use address lookup tables.`,
    );
  }

  return {
    transaction: compiledTx,
    txSizeBytes: byteLength,
    wireBase64,
  };
}
