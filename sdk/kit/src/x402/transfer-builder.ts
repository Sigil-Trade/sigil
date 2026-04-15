/**
 * x402 Transfer Builder — Kit-native
 *
 * Builds SPL TransferChecked instructions from raw bytes.
 * Zero dependency on @solana-program/token — the instruction is 10 bytes
 * of data + 4 accounts, trivial to encode directly.
 */

import type { Address, Instruction } from "@solana/kit";
import { AccountRole, getProgramDerivedAddress } from "@solana/kit";
import type { InspectableInstruction } from "../inspector.js";
import { X402ParseError } from "./errors.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const ATA_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

/** SPL TransferChecked instruction discriminator */
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

// ─── ATA Derivation ─────────────────────────────────────────────────────────

/**
 * Derive an Associated Token Account address.
 * Seeds: [owner, TOKEN_PROGRAM_ID, mint]
 */
export async function deriveAta(
  owner: Address,
  mint: Address,
): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM_ID,
    seeds: [
      // owner
      getAddressBytes(owner),
      // token program
      getAddressBytes(TOKEN_PROGRAM_ID),
      // mint
      getAddressBytes(mint),
    ],
  });
  return ata;
}

/**
 * Convert a base58 Address to exactly 32 bytes for PDA seeds.
 * Uses base58 decode (no external dependency).
 */
function getAddressBytes(address: Address): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length === 32) return decoded;
  // Pad or truncate to exactly 32 bytes
  if (decoded.length > 32) return decoded.slice(decoded.length - 32);
  const result = new Uint8Array(32);
  result.set(decoded, 32 - decoded.length);
  return result;
}

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
