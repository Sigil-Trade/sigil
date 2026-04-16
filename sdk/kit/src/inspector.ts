/**
 * Instruction Inspector — Kit-native
 *
 * Analyzes Kit Instruction[] arrays (pre-compilation) to extract:
 *   - Unique program IDs involved
 *   - SPL Token transfers (Transfer and TransferChecked)
 *   - Estimated USD value of outgoing transfers
 *
 */

import type { Address } from "./kit-adapter.js";
import type { ConstraintEntry } from "./generated/types/constraintEntry.js";
import { resolveProtocolName } from "./protocol-names.js";

// ─── Constants ───────────────────────────────────────────────────────────────

import {
  TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS as TOKEN_2022_PROGRAM_ID,
} from "./types.js";

/** SPL Token instruction discriminators */
const SPL_TRANSFER_DISCRIMINATOR = 3;
const SPL_APPROVE_DISCRIMINATOR = 4;
const SPL_REVOKE_DISCRIMINATOR = 5;
const SPL_SET_AUTHORITY_DISCRIMINATOR = 6;
const SPL_CLOSE_ACCOUNT_DISCRIMINATOR = 9;
const SPL_TRANSFER_CHECKED_DISCRIMINATOR = 12;
const SPL_APPROVE_CHECKED_DISCRIMINATOR = 13;

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
  /** Token mint address (only available for TransferChecked, null for Transfer) */
  mint: Address | null;
  /** Transfer amount in base units */
  amount: bigint;
  /** Source token account */
  source: Address;
  /** Destination token account */
  destination: Address;
  /** Authority (signer) of the transfer */
  authority: Address;
}

/** A dangerous SPL Token operation detected by the inspector. */
export interface DangerousTokenOperation {
  /** Type of dangerous operation */
  type: "approve" | "setAuthority" | "closeAccount" | "revoke";
  /** The token account being affected */
  account: Address;
}

/** Result of analyzing a set of instructions */
export interface InstructionAnalysis {
  /** Unique program IDs referenced across all instructions */
  programIds: Address[];
  /** Detected SPL Token transfers */
  tokenTransfers: TokenTransferInfo[];
  /** Sum of outgoing transfer amounts (where authority === signerAddress) */
  estimatedValue: bigint;
  /** Dangerous SPL Token operations (approve, setAuthority, closeAccount) */
  dangerousOperations: DangerousTokenOperation[];
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
  const dangerousOperations: DangerousTokenOperation[] = [];
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
        mint: null, // Not available in Transfer instruction (only TransferChecked provides mint)
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

    // Detect dangerous token operations (approve, setAuthority, closeAccount, revoke)
    if (
      discriminator === SPL_APPROVE_DISCRIMINATOR ||
      discriminator === SPL_APPROVE_CHECKED_DISCRIMINATOR
    ) {
      if (accounts.length >= 1) {
        dangerousOperations.push({
          type: "approve",
          account: accounts[0].address,
        });
      }
    } else if (discriminator === SPL_SET_AUTHORITY_DISCRIMINATOR) {
      if (accounts.length >= 1) {
        dangerousOperations.push({
          type: "setAuthority",
          account: accounts[0].address,
        });
      }
    } else if (discriminator === SPL_CLOSE_ACCOUNT_DISCRIMINATOR) {
      if (accounts.length >= 1) {
        dangerousOperations.push({
          type: "closeAccount",
          account: accounts[0].address,
        });
      }
    } else if (discriminator === SPL_REVOKE_DISCRIMINATOR) {
      if (accounts.length >= 1) {
        dangerousOperations.push({
          type: "revoke",
          account: accounts[0].address,
        });
      }
    }
  }

  return {
    programIds: Array.from(programIdSet) as Address[],
    tokenTransfers,
    estimatedValue,
    dangerousOperations,
  };
}

// ─── Constraint Inspection ───────────────────────────────────────────────────

export interface ConstraintSummary {
  /** 0-based index in the constraints array. */
  index: number;
  /** Protocol program address this constraint targets. */
  program: Address;
  /** Human-readable protocol name (e.g. "Jupiter") or shortened address. */
  programName: string;
  /** Number of data constraints (byte-level rules). */
  dataConstraintCount: number;
  /** Number of account constraints (address-level rules). */
  accountConstraintCount: number;
  /** Human-readable description of each rule. */
  rules: string[];
}

const OPERATOR_NAMES: Record<number, string> = {
  0: "==",
  1: "!=",
  2: "<",
  3: "<=",
  4: ">",
  5: ">=",
  6: "contains",
};

/**
 * Inspect an InstructionConstraints account and return a human-readable
 * summary of each constraint entry.
 *
 * @param entries - The constraint entries from the InstructionConstraints PDA.
 *   Obtain via: `(await resolveVaultState(rpc, vault, agent)).constraints?.entries`
 */
export function inspectConstraints(
  entries: ConstraintEntry[],
): ConstraintSummary[] {
  return entries
    .map((entry, index) => {
      const program = entry.programId;
      const programName = resolveProtocolName(String(program));
      const rules: string[] = [];

      // Data constraints: { offset, operator: ConstraintOperator, value: ReadonlyUint8Array }
      for (const dc of entry.dataConstraints ?? []) {
        const opNum =
          typeof dc.operator === "number"
            ? dc.operator
            : (dc.operator as { __kind: string }).__kind
              ? 0
              : 0;
        const op = OPERATOR_NAMES[opNum] ?? `op(${String(dc.operator)})`;
        const bytes = new Uint8Array(dc.value as unknown as ArrayLike<number>);
        const valueHex = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        rules.push(`data[${dc.offset}..+${bytes.length}] ${op} 0x${valueHex}`);
      }

      // Account constraints: { index, expected: Address }
      for (const ac of entry.accountConstraints ?? []) {
        rules.push(`account[${ac.index}] == ${ac.expected}`);
      }

      return {
        index,
        program,
        programName,
        dataConstraintCount: entry.dataConstraints?.length ?? 0,
        accountConstraintCount: entry.accountConstraints?.length ?? 0,
        rules,
      };
    })
    .filter((s) => s.rules.length > 0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a u64 (8 bytes) in little-endian from a Uint8Array.
 */
function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}
