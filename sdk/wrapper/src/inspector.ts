import {
  AddressLookupTableAccount,
  Connection,
  MessageV0,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  VersionedMessage,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TransactionAnalysis, TokenTransfer } from "./policies";
import { isSystemProgram } from "./registry";

/** SPL Token instruction discriminators */
const SPL_TRANSFER_DISCRIMINATOR = 3;
const SPL_TRANSFER_CHECKED_DISCRIMINATOR = 12;

/** Token 2022 program ID */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Analyze a transaction to extract program IDs, token transfers, and estimated value.
 * Works with both legacy Transaction and VersionedTransaction.
 */
export function analyzeTransaction(
  tx: Transaction | VersionedTransaction,
  signerPubkey: PublicKey,
  addressLookupTableAccounts?: AddressLookupTableAccount[],
): TransactionAnalysis {
  const instructions = extractInstructions(tx, addressLookupTableAccounts);
  const programIds: PublicKey[] = [];
  const transfers: TokenTransfer[] = [];
  const seenPrograms = new Set<string>();

  for (const ix of instructions) {
    const programKey = ix.programId.toBase58();
    if (!seenPrograms.has(programKey)) {
      seenPrograms.add(programKey);
      programIds.push(ix.programId);
    }

    // Detect SPL token transfers
    if (isTokenProgram(ix.programId)) {
      const transfer = parseTokenTransfer(ix, signerPubkey);
      if (transfer) {
        transfers.push(transfer);
      }
    }
  }

  // Sum outgoing transfer amounts as estimated value
  const estimatedValueLamports = transfers
    .filter((t) => t.direction === "outgoing")
    .reduce((sum, t) => sum + t.amount, BigInt(0));

  return { programIds, transfers, estimatedValueLamports };
}

/**
 * Extract instructions from either Transaction or VersionedTransaction.
 */
export function extractInstructions(
  tx: Transaction | VersionedTransaction,
  addressLookupTableAccounts?: AddressLookupTableAccount[],
): TransactionInstruction[] {
  if (tx instanceof Transaction) {
    return tx.instructions;
  }

  // VersionedTransaction — need to resolve from compiled message
  return extractFromVersionedMessage(tx.message, addressLookupTableAccounts);
}

/**
 * Extract TransactionInstruction-like objects from a VersionedMessage.
 * When addressLookupTableAccounts are provided, resolves account keys
 * referenced through Address Lookup Tables (ALTs) in V0 messages.
 */
function extractFromVersionedMessage(
  message: VersionedMessage,
  addressLookupTableAccounts?: AddressLookupTableAccount[],
): TransactionInstruction[] {
  // MessageV0 (version === 0) supports ALT resolution via
  // getAccountKeys({ addressLookupTableAccounts }).
  // Legacy Message (version === 'legacy') does not accept ALT args.
  const accountKeys =
    addressLookupTableAccounts?.length && message.version === 0
      ? (message as MessageV0).getAccountKeys({ addressLookupTableAccounts })
      : message.getAccountKeys();

  const instructions: TransactionInstruction[] = [];

  for (const compiled of message.compiledInstructions) {
    const programId = accountKeys.get(compiled.programIdIndex);
    if (!programId) continue;

    const keys = compiled.accountKeyIndexes.map((idx) => ({
      pubkey: accountKeys.get(idx) ?? PublicKey.default,
      isSigner: message.isAccountSigner(idx),
      isWritable: message.isAccountWritable(idx),
    }));

    instructions.push(
      new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(compiled.data),
      }),
    );
  }

  return instructions;
}

/**
 * Resolve Address Lookup Table accounts for a VersionedTransaction.
 * Returns empty array if the transaction has no ALT references.
 */
export async function resolveTransactionAddressLookupTables(
  tx: VersionedTransaction,
  connection: Connection,
): Promise<AddressLookupTableAccount[]> {
  const lookups = tx.message.addressTableLookups;
  if (!lookups || lookups.length === 0) return [];

  const results = await Promise.all(
    lookups.map((lookup) =>
      connection.getAddressLookupTable(lookup.accountKey),
    ),
  );

  return results
    .filter((r) => r.value !== null)
    .map((r) => r.value as AddressLookupTableAccount);
}

/**
 * Check if a program ID is a token program (SPL Token or Token 2022).
 */
function isTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) ||
    programId.equals(TOKEN_2022_PROGRAM_ID)
  );
}

/**
 * Parse an SPL Token transfer instruction to extract amount and direction.
 * Handles both Transfer (discriminator 3) and TransferChecked (discriminator 12).
 */
function parseTokenTransfer(
  ix: TransactionInstruction,
  signerPubkey: PublicKey,
): TokenTransfer | null {
  if (ix.data.length < 1) return null;
  const discriminator = ix.data[0];

  if (discriminator === SPL_TRANSFER_DISCRIMINATOR) {
    return parseTransfer(ix, signerPubkey);
  }

  if (discriminator === SPL_TRANSFER_CHECKED_DISCRIMINATOR) {
    return parseTransferChecked(ix, signerPubkey);
  }

  return null;
}

/**
 * Parse SPL Token Transfer instruction.
 * Layout: [1 byte disc][8 bytes amount LE]
 * Accounts: [source, destination, authority]
 */
function parseTransfer(
  ix: TransactionInstruction,
  signerPubkey: PublicKey,
): TokenTransfer | null {
  if (ix.data.length < 9 || ix.keys.length < 3) return null;

  const amount = readU64LE(ix.data, 1);
  const source = ix.keys[0].pubkey;
  const destination = ix.keys[1].pubkey;
  const authority = ix.keys[2].pubkey;

  const direction = authority.equals(signerPubkey) ? "outgoing" : "unknown";

  return {
    mint: PublicKey.default, // Transfer (non-checked) doesn't include mint
    amount,
    direction,
    destination: direction === "outgoing" ? destination : undefined,
  };
}

/**
 * Parse SPL Token TransferChecked instruction.
 * Layout: [1 byte disc][8 bytes amount LE][1 byte decimals]
 * Accounts: [source, mint, destination, authority]
 */
function parseTransferChecked(
  ix: TransactionInstruction,
  signerPubkey: PublicKey,
): TokenTransfer | null {
  if (ix.data.length < 10 || ix.keys.length < 4) return null;

  const amount = readU64LE(ix.data, 1);
  const source = ix.keys[0].pubkey;
  const mint = ix.keys[1].pubkey;
  const destination = ix.keys[2].pubkey;
  const authority = ix.keys[3].pubkey;

  const direction = authority.equals(signerPubkey) ? "outgoing" : "unknown";

  return {
    mint,
    amount,
    direction,
    destination: direction === "outgoing" ? destination : undefined,
  };
}

/**
 * Read a little-endian u64 from a buffer at the given offset.
 */
function readU64LE(buf: Buffer | Uint8Array, offset: number): bigint {
  const view = Buffer.from(buf);
  return view.readBigUInt64LE(offset);
}

/**
 * Get all non-system program IDs from a transaction analysis.
 * Useful for checking if a transaction interacts with unknown programs.
 */
export function getNonSystemProgramIds(
  analysis: TransactionAnalysis,
): PublicKey[] {
  return analysis.programIds.filter((pid) => !isSystemProgram(pid));
}
