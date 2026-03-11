/**
 * Adapter Output Verifier — Kit-native
 *
 * Verifies that protocol handler compose() output is safe to include
 * in a Phalnx composed transaction. Prevents malicious adapters from
 * injecting unauthorized instructions.
 *
 * Kit differences from web3.js version:
 *   - ix.programAddress (Kit) instead of ix.programId (web3.js)
 *   - Address is a branded string — direct === comparison, no .equals()
 *   - TOKEN_PROGRAM_ID hardcoded as Address string
 *   - ix.accounts[] entries have .address instead of .pubkey
 */

import type { Address } from "@solana/kit";

/** SPL Token instruction discriminators */
const SPL_TRANSFER_DISCRIMINATOR = 3;
const SPL_TRANSFER_CHECKED_DISCRIMINATOR = 12;

/**
 * Token Program address — hardcoded to avoid spl-token dependency.
 * This is the canonical SPL Token Program ID on all Solana clusters.
 */
const TOKEN_PROGRAM_ID: Address =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** Infrastructure programs always allowed (ComputeBudget, SystemProgram, ATA) */
const INFRASTRUCTURE_PROGRAMS = new Set<string>([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

export interface AdapterVerifyResult {
  valid: boolean;
  violations: string[];
}

/**
 * Kit-native instruction type used for verification.
 * Compatible with Kit's IInstruction but with concrete types.
 */
export interface VerifiableInstruction {
  programAddress: Address;
  accounts?: readonly { address: Address }[];
  data?: Uint8Array;
}

/**
 * Verify that a protocol handler's compose output is safe.
 *
 * Checks:
 * 1. Every instruction's programAddress must be in handler's programIds OR infrastructure whitelist
 * 2. No SPL Token Transfer/TransferChecked referencing vault token accounts
 *
 * @param instructions - The instructions from a protocol handler's compose result
 * @param allowedProgramIds - Program IDs from the handler's metadata
 * @param vaultAddress - The vault PDA address (to detect transfers targeting vault ATAs)
 */
export function verifyAdapterOutput(
  instructions: VerifiableInstruction[],
  allowedProgramIds: Address[],
  vaultAddress: Address,
): AdapterVerifyResult {
  const violations: string[] = [];
  const allowedSet = new Set<string>(allowedProgramIds);

  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    const programId = ix.programAddress;

    // Check 1: programAddress must be in allowed list or infrastructure
    if (
      !allowedSet.has(programId) &&
      !INFRASTRUCTURE_PROGRAMS.has(programId)
    ) {
      violations.push(
        `Instruction ${i}: program ${programId} not in handler's programIds or infrastructure whitelist`,
      );
    }

    // Check 2: Block SPL Token transfers referencing vault accounts
    if (
      programId === TOKEN_PROGRAM_ID &&
      ix.data &&
      ix.data.length > 0
    ) {
      const discriminator = ix.data[0];
      if (
        discriminator === SPL_TRANSFER_DISCRIMINATOR ||
        discriminator === SPL_TRANSFER_CHECKED_DISCRIMINATOR
      ) {
        // Check if any account in the instruction references the vault
        if (ix.accounts) {
          const hasVaultKey = ix.accounts.some(
            (acc) => acc.address === vaultAddress,
          );
          if (hasVaultKey) {
            violations.push(
              `Instruction ${i}: SPL Token transfer referencing vault account — potential unauthorized drain`,
            );
          }
        }
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
