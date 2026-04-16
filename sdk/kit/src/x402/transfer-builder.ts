/**
 * x402 Transfer Builder — Kit-native
 *
 * Builds SPL TransferChecked instructions from raw bytes.
 * Zero dependency on @solana-program/token — the instruction is 10 bytes
 * of data + 4 accounts, trivial to encode directly.
 */

import type { Address, Instruction } from "../kit-adapter.js";
import { AccountRole } from "../kit-adapter.js";
import type { InspectableInstruction } from "../inspector.js";
import { X402ParseError } from "./errors.js";

// ─── Constants ──────────────────────────────────────────────────────────────

// PR 3.B F036: use canonical constants from types.ts.
// Re-exported here for backwards compat with consumers importing from x402/.
import { TOKEN_PROGRAM_ADDRESS, ATA_PROGRAM_ADDRESS } from "../types.js";
export const TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ADDRESS;
export const ATA_PROGRAM_ID = ATA_PROGRAM_ADDRESS;

/** SPL TransferChecked instruction discriminator */
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

// ─── ATA Derivation ─────────────────────────────────────────────────────────
// PR 3.B F062: deriveAta moved to tokens.ts (correct home — generic SPL utility,
// not x402-specific). Imported for local use + re-exported for backwards compat
// with consumers importing from "@usesigil/kit/x402".
import { deriveAta } from "../tokens.js";
export { deriveAta };

// getAddressBytes removed — was only used by deriveAta (now in tokens.ts).

// ─── Instruction Builder ────────────────────────────────────────────────────

/**
 * Build an SPL TransferChecked instruction for an x402 payment.
 *
 * Instruction data layout:
 *   [0]: 12 (TransferChecked discriminator)
 *   [1-8]: amount as u64 LE
 *   [9]: decimals
 *
 * Accounts:
 *   0: source ATA (writable)
 *   1: mint (readonly)
 *   2: destination ATA (writable)
 *   3: authority/owner (signer)
 */
export async function buildX402TransferInstruction(params: {
  from: Address;
  payTo: Address;
  asset: Address;
  amount: bigint;
  decimals: number;
}): Promise<Instruction> {
  const sourceAta = await deriveAta(params.from, params.asset);
  const destAta = await deriveAta(params.payTo, params.asset);

  // Encode instruction data: [12, u64_le amount, u8 decimals]
  const data = new Uint8Array(10);
  data[0] = TRANSFER_CHECKED_DISCRIMINATOR;

  // Write amount as u64 little-endian
  let amount = params.amount;
  for (let i = 1; i <= 8; i++) {
    data[i] = Number(amount & 0xffn);
    amount >>= 8n;
  }
  data[9] = params.decimals;

  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: sourceAta, role: AccountRole.WRITABLE },
      { address: params.asset, role: AccountRole.READONLY },
      { address: destAta, role: AccountRole.WRITABLE },
      { address: params.from, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

/**
 * Convert a built transfer instruction to an InspectableInstruction
 * for Shield policy evaluation.
 */
export function transferToInspectable(ix: Instruction): InspectableInstruction {
  return {
    programAddress: ix.programAddress,
    accounts: ix.accounts?.map((a) => ({ address: a.address })),
    data: ix.data instanceof Uint8Array ? ix.data : undefined,
  };
}

// ─── Base58 Decode ──────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];

  for (const char of str) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new X402ParseError(`Invalid base58 character: ${char}`);
    }

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Leading zeros
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}
