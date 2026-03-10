/**
 * Adapter Output Verifier
 *
 * Verifies that protocol handler compose() output is safe to include
 * in a Phalnx composed transaction. Prevents malicious adapters from
 * injecting unauthorized instructions.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ProtocolComposeResult } from "./protocol-handler";

/** SPL Token instruction discriminators for Transfer and TransferChecked */
const SPL_TRANSFER_DISCRIMINATOR = 3;
const SPL_TRANSFER_CHECKED_DISCRIMINATOR = 12;

/** Infrastructure programs always allowed (ComputeBudget, SystemProgram, ATA) */
const INFRASTRUCTURE_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

export interface AdapterVerifyResult {
  valid: boolean;
  violations: string[];
}

/**
 * Verify that a protocol handler's compose output is safe.
 *
 * Checks:
 * 1. Every instruction's programId must be in handler's programIds OR infrastructure whitelist
 * 2. No SPL Token Transfer/TransferChecked targeting vault token accounts
 *
 * @param result - The compose result from a protocol handler
 * @param allowedProgramIds - Program IDs from the handler's metadata
 * @param vaultAddress - The vault PDA address (to detect transfers targeting vault ATAs)
 */
export function verifyAdapterOutput(
  result: ProtocolComposeResult,
  allowedProgramIds: PublicKey[],
  vaultAddress: PublicKey,
): AdapterVerifyResult {
  const violations: string[] = [];
  const allowedSet = new Set(allowedProgramIds.map((p) => p.toBase58()));

  for (let i = 0; i < result.instructions.length; i++) {
    const ix = result.instructions[i];
    const programId = ix.programId.toBase58();

    // Check 1: programId must be in allowed list or infrastructure
    if (!allowedSet.has(programId) && !INFRASTRUCTURE_PROGRAMS.has(programId)) {
      violations.push(
        `Instruction ${i}: program ${programId} not in handler's programIds or infrastructure whitelist`,
      );
    }

    // Check 2: Block SPL Token transfers targeting vault accounts
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data.length > 0) {
      const discriminator = ix.data[0];
      if (
        discriminator === SPL_TRANSFER_DISCRIMINATOR ||
        discriminator === SPL_TRANSFER_CHECKED_DISCRIMINATOR
      ) {
        // For Transfer: accounts[0] = source, accounts[1] = destination
        // Check if source is a vault-owned account (vault is PDA authority)
        const sourceAccount = ix.keys[0]?.pubkey;
        if (sourceAccount) {
          // We check if any key in the instruction references the vault as an owner/authority
          const vaultBase58 = vaultAddress.toBase58();
          const hasVaultKey = ix.keys.some(
            (k) => k.pubkey.toBase58() === vaultBase58,
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
