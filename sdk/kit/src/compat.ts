/**
 * INTERNAL: web3.js ↔ Kit type bridge for T2 protocol SDKs.
 *
 * This is the ONLY file in sdk/kit/ that imports @solana/web3.js.
 * It is NOT exported from index.ts — internal use only.
 *
 * @solana/web3.js and @coral-xyz/anchor are optional dependencies.
 * This module will throw at runtime if they are not installed.
 */

import type { Address, Instruction, AccountMeta } from "@solana/kit";
import { AccountRole } from "@solana/kit";

/**
 * Convert a web3.js TransactionInstruction to a Kit Instruction.
 * Used when wrapping T2 protocol SDKs that return web3.js types.
 */
export function toKitInstruction(
  ix: {
    programId: { toBase58(): string };
    keys: Array<{
      pubkey: { toBase58(): string };
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: Buffer | Uint8Array;
  },
): Instruction {
  const accounts: AccountMeta[] = ix.keys.map((key) => {
    const address = key.pubkey.toBase58() as Address;
    if (key.isSigner && key.isWritable) {
      return { address, role: AccountRole.WRITABLE_SIGNER } as AccountMeta;
    }
    if (key.isSigner) {
      return { address, role: AccountRole.READONLY_SIGNER } as AccountMeta;
    }
    if (key.isWritable) {
      return { address, role: AccountRole.WRITABLE } as AccountMeta;
    }
    return { address, role: AccountRole.READONLY } as AccountMeta;
  });

  return {
    programAddress: ix.programId.toBase58() as Address,
    accounts,
    data: new Uint8Array(ix.data),
  };
}

/**
 * Convert a web3.js PublicKey to a Kit Address.
 */
export function toKitAddress(
  pubkey: { toBase58(): string },
): Address {
  return pubkey.toBase58() as Address;
}

/**
 * Convert a BN (from @coral-xyz/anchor) to a bigint.
 */
export function toBigInt(
  bn: { toString(base?: number): string },
): bigint {
  return BigInt(bn.toString());
}

/**
 * Convert a Kit Address to a base58 string.
 * (Identity function since Kit Address IS a string, but useful for type clarity)
 */
export function fromKitAddress(address: Address): string {
  return address as string;
}
