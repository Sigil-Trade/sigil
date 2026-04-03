/**
 * @usesigil/kit/dashboard — Static discovery methods.
 *
 * These run before constructing an OwnerClient — they help find vaults.
 */

import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { findVaultsByOwner } from "../state-resolver.js";
import { fetchMaybeAgentVault } from "../generated/accounts/agentVault.js";
import type { DiscoveredVault } from "./types.js";

/**
 * Discover all vaults owned by an address.
 * Re-derives PDAs client-side via findVaultsByOwner — rejects RPC results
 * that don't match derivable addresses.
 */
export async function discoverVaults(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  _network: "devnet" | "mainnet",
): Promise<DiscoveredVault[]> {
  const sdkVaults = await findVaultsByOwner(rpc, owner);

  // Fetch vault accounts in parallel to get status + agentCount
  const results = await Promise.all(
    sdkVaults.map(async (v) => {
      try {
        const account = await fetchMaybeAgentVault(rpc, v.vaultAddress);
        if (!account.exists) return null;

        const data = account.data;
        const statusNum =
          typeof data.status === "number"
            ? data.status
            : (data.status as any)?.__kind === "Active"
              ? 0
              : 1;

        return {
          address: v.vaultAddress as string,
          vaultId: v.vaultId,
          status: (statusNum === 0
            ? "active"
            : statusNum === 1
              ? "frozen"
              : "closed") as DiscoveredVault["status"],
          agentCount: data.agents?.length ?? 0,
          toJSON: () => ({
            address: v.vaultAddress as string,
            vaultId: v.vaultId.toString(),
            status:
              statusNum === 0
                ? "active"
                : statusNum === 1
                  ? "frozen"
                  : "closed",
            agentCount: data.agents?.length ?? 0,
          }),
        } satisfies DiscoveredVault;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((v): v is DiscoveredVault => v !== null);
}
