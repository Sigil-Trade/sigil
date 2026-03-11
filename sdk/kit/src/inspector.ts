/**
 * Instruction Inspector — Kit-native
 *
 * Analyzes Kit Instruction[] arrays (pre-compilation) to extract:
 *   - Unique program IDs involved
 *   - SPL Token transfers (Transfer and TransferChecked)
 *   - Estimated USD value of outgoing transfers
 *
 * Kit differences from web3.js version:
 *   - Works on Instruction[] not compiled transactions
 *   - Uses ix.programAddress instead of ix.programId
 *   - Uses ix.accounts[].address instead of ix.keys[].pubkey
 *   - Uses ix.data as Uint8Array directly
 *   - All addresses are Address (branded strings) — no .toBase58()/.equals()
 */

import type { Address } from "@solana/kit";

// ─── Constants ───────────────────────────────────────────────────────────────

const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** SPL Token instruction discriminators */
const SPL_TRANSFER_DISCRIMINATOR = 3;
const SPL_TRANSFER_CHECKED_DISCRIMINATOR = 12;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Kit-native instruction shape for inspection.
 * Compatible with Kit's IInstruction interface.
 */
export interface InspectableInstruction {
  programAddress: Address;
  accounts?: readonly { address: Address }[];
  data?: Uint8Array;
}

/** Parsed SPL Token transfer info */
export interface TokenTransferInfo {
  /** Token mint address (only available for TransferChecked) */
  mint: Address;
  /** Transfer amount in base units */
  amount: bigint;
  /** Source token account */
  source: Address;
  /** Destination token account */
  destination: Address;
  /** Authority (signer) of the transfer */
  authority: Address;
}

/** Result of analyzing a set of instructions */
export interface InstructionAnalysis {
  /** Unique program IDs referenced across all instructions */
  programIds: Address[];
  /** Detected SPL Token transfers */
  tokenTransfers: TokenTransferInfo[];
  /** Sum of outgoing transfer amounts (where authority === signerAddress) */
  estimatedValue: bigint;
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Analyze a set of Kit instructions to extract program IDs, token transfers,
 * and estimated outgoing value.
 *
 * @param instructions - Kit-native instructions to analyze
 * @param signerAddress - The signer's address (to determine transfer direction)
 * @returns Analysis result with program IDs, transfers, and estimated value
 */
export function analyzeInstructions(
  instructions: InspectableInstruction[],
  signerAddress: Address,
): InstructionAnalysis {
  const programIdSet = new Set<string>();
  const tokenTransfers: TokenTransferInfo[] = [];
  let estimatedValue = 0n;

  for (const ix of instructions) {
    // Collect unique program IDs
    programIdSet.add(ix.programAddress);

    // Check for token program instructions
    if (
      ix.programAddress !== TOKEN_PROGRAM_ID &&
      ix.programAddress !== TOKEN_2022_PROGRAM_ID
    ) {
      continue;
    }

    if (!ix.data || ix.data.length === 0) continue;

    const discriminator = ix.data[0];
    const accounts = ix.accounts ?? [];

    if (discriminator === SPL_TRANSFER_DISCRIMINATOR) {
      // Transfer layout: [1 byte disc][8 bytes amount LE]
      // Accounts: [source, destination, authority]
      if (ix.data.length < 9 || accounts.length < 3) continue;

      const amount = readU64LE(ix.data, 1);
      const source = accounts[0].address;
      const destination = accounts[1].address;
      const authority = accounts[2].address;

      const transfer: TokenTransferInfo = {
        mint: "unknown" as Address, // Not available in Transfer instruction
        amount,
        source,
        destination,
        authority,
      };
      tokenTransfers.push(transfer);

      // Sum outgoing transfers
      if (authority === signerAddress) {
        estimatedValue += amount;
      }
    } else if (discriminator === SPL_TRANSFER_CHECKED_DISCRIMINATOR) {
      // TransferChecked layout: [1 byte disc][8 bytes amount LE][1 byte decimals]
      // Accounts: [source, mint, destination, authority]
      if (ix.data.length < 10 || accounts.length < 4) continue;

      const amount = readU64LE(ix.data, 1);
      const source = accounts[0].address;
      const mint = accounts[1].address;
      const destination = accounts[2].address;
      const authority = accounts[3].address;

      const transfer: TokenTransferInfo = {
        mint,
        amount,
        source,
        destination,
        authority,
      };
      tokenTransfers.push(transfer);

      // Sum outgoing transfers
      if (authority === signerAddress) {
        estimatedValue += amount;
      }
    }
  }

  return {
    programIds: Array.from(programIdSet) as Address[],
    tokenTransfers,
    estimatedValue,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a u64 (8 bytes) in little-endian from a Uint8Array.
 */
function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}
