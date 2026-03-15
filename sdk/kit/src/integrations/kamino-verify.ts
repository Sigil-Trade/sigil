/**
 * Kamino Pre-Submit Verification — Kit-native
 *
 * Every API-sourced instruction is checked before sandwiching into
 * a Phalnx composed transaction. Defense-in-depth against API tampering.
 *
 * 4-point verification:
 * 1. Program ID — must target allowed programs
 * 2. Discriminator — main Kamino IX must match expected action
 * 3. Amount — encoded u64 at offset 8 must match requested amount
 * 4. Signer — vault address must appear as signer
 */

import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import { KAMINO_LENDING_PROGRAM } from "./config/kamino-markets.js";
import { KAMINO_SCHEMA } from "../constraints/protocols/kamino-schema.js";
import { KaminoApiError } from "./kamino-api.js";

const ALLOWED_PROGRAMS = new Set<string>([
  KAMINO_LENDING_PROGRAM,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // Token Program
  "11111111111111111111111111111111",                 // System Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // ATA Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022
]);

/** Map Kamino handler action names to schema instruction names */
const ACTION_TO_SCHEMA: Record<string, string> = {
  deposit: "depositCollateral",
  withdraw: "withdrawCollateral",
  borrow: "borrowLiquidity",
  repay: "repayLiquidity",
};

export function verifyKaminoInstructions(
  instructions: Instruction[],
  expectedAction: string,
  expectedAmount: bigint,
  vaultAddress: Address,
): void {
  if (instructions.length === 0) {
    throw new KaminoApiError(0, "API returned zero instructions");
  }

  // 1. Program ID check — every IX must target allowed programs
  for (const ix of instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.programAddress)) {
      throw new KaminoApiError(
        0,
        `Unexpected program in Kamino instructions: ${ix.programAddress}`,
      );
    }
  }

  // Find the main Kamino instruction (program = KLend, not a helper)
  const kaminoIxs = instructions.filter(
    (ix) => ix.programAddress === KAMINO_LENDING_PROGRAM,
  );

  if (kaminoIxs.length === 0) {
    // For kvault/multiply, there may be no direct KLend instructions
    // in which case we only validate program IDs + signer
    verifySigner(instructions, vaultAddress);
    return;
  }

  // 2. Discriminator check (for KLend actions only)
  const schemaName = ACTION_TO_SCHEMA[expectedAction];
  if (schemaName) {
    const schema = KAMINO_SCHEMA.instructions.get(schemaName);
    if (schema) {
      const mainIx = kaminoIxs[kaminoIxs.length - 1]; // Last KLend IX is the action
      if (mainIx.data && mainIx.data.length >= 8) {
        const disc = mainIx.data.slice(0, 8);
        if (!arraysEqual(disc, schema.discriminator)) {
          throw new KaminoApiError(
            0,
            `Discriminator mismatch for ${expectedAction}: expected ${arrayToHex(schema.discriminator)}, got ${arrayToHex(disc)}`,
          );
        }
      }

      // 3. Amount check — u64 at offset 8
      if (mainIx.data && mainIx.data.length >= 16 && expectedAmount > 0n) {
        const encodedAmount = readU64LE(mainIx.data, 8);
        if (encodedAmount !== expectedAmount) {
          throw new KaminoApiError(
            0,
            `Amount mismatch for ${expectedAction}: expected ${expectedAmount}, got ${encodedAmount}`,
          );
        }
      }
    }
  }

  // 4. Signer check
  verifySigner(instructions, vaultAddress);
}

function verifySigner(instructions: Instruction[], vaultAddress: Address): void {
  const hasSigner = instructions.some((ix) =>
    ix.accounts?.some(
      (acc) =>
        acc.address === vaultAddress &&
        (acc.role === AccountRole.WRITABLE_SIGNER || acc.role === AccountRole.READONLY_SIGNER),
    ),
  );
  if (!hasSigner) {
    throw new KaminoApiError(
      0,
      `Vault ${vaultAddress} not found as signer in any instruction`,
    );
  }
}

function arraysEqual(a: Uint8Array | ReadonlyArray<number>, b: Uint8Array | ReadonlyArray<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readU64LE(data: { readonly [index: number]: number; readonly length: number }, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8);
  }
  return value;
}

function arrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
