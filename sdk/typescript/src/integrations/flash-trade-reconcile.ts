import { PublicKey, Connection, TransactionInstruction } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import type { Phalnx, AgentVaultAccount } from "../types";
import { buildSyncPositions } from "../instructions";
import { fetchVaultByAddress } from "../accounts";

/**
 * Count the number of active Flash Trade positions for a vault.
 *
 * @param connection - Solana connection
 * @param poolCustodyPairs - Array of [pool, custody] pubkey pairs to check
 *   positions against. Each pair generates a position PDA.
 * @param vault - The vault PDA (position owner)
 * @param flashProgramId - Flash Trade program ID
 * @returns Number of existing (non-null) position accounts
 */
export async function countFlashTradePositions(
  connection: Connection,
  poolCustodyPairs: [PublicKey, PublicKey][],
  vault: PublicKey,
  flashProgramId: PublicKey,
): Promise<number> {
  // Derive position PDAs: seeds = ["position", owner, pool, custody, side]
  // We check both long and short for each pair
  const positionPDAs: PublicKey[] = [];
  for (const [pool, custody] of poolCustodyPairs) {
    for (const sideBytes of [
      Buffer.from([1]), // long
      Buffer.from([2]), // short
    ]) {
      const [positionPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          vault.toBuffer(),
          pool.toBuffer(),
          custody.toBuffer(),
          sideBytes,
        ],
        flashProgramId,
      );
      positionPDAs.push(positionPDA);
    }
  }

  if (positionPDAs.length === 0) return 0;

  // Batch fetch all position accounts
  const accounts = await connection.getMultipleAccountsInfo(positionPDAs);
  return accounts.filter((a) => a !== null).length;
}

/**
 * Reconcile the vault's open position counter with actual Flash Trade state.
 *
 * @returns A sync_positions instruction if the counter is divergent, or null
 *   if already in sync.
 */
export async function reconcilePositions(
  program: Program<Phalnx>,
  connection: Connection,
  owner: PublicKey,
  vault: PublicKey,
  poolCustodyPairs: [PublicKey, PublicKey][],
  flashProgramId: PublicKey,
): Promise<TransactionInstruction | null> {
  const [vaultAccount, actualCount] = await Promise.all([
    fetchVaultByAddress(program, vault),
    countFlashTradePositions(
      connection,
      poolCustodyPairs,
      vault,
      flashProgramId,
    ),
  ]);

  if (!vaultAccount) {
    throw new Error(`Vault account not found: ${vault.toBase58()}`);
  }

  const currentCount = (vaultAccount as AgentVaultAccount).openPositions;
  if (currentCount === actualCount) return null;

  return buildSyncPositions(program, owner, vault, actualCount).instruction();
}
