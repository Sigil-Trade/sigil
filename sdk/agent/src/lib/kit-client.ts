/**
 * Thin wrapper around the Sigil kit — builds an OwnerClient from an
 * AgentConfig so tool implementations don't have to assemble it themselves.
 *
 * NOTE: an "OwnerClient" is misleadingly named for an AGENT runtime — the
 * kit's nomenclature comes from the dashboard context. Here, the agent
 * is reading state (which uses owner=NoopSigner, signing not needed) and
 * proposing transactions via the agent keypair (which becomes a real
 * transaction signer). The kit's seal() function takes the agent signer
 * separately from the vault context.
 *
 * For v0.1: read-only methods only (getVaultState, getPolicy, getAgents,
 * getActivity). Day 2 adds seal() integration with the agent signer.
 */
import {
  address,
  createKeyPairFromBytes,
  createNoopSigner,
  createSignerFromKeyPair,
  createSolanaRpc,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { createOwnerClient } from "@usesigil/kit/dashboard";
import type { AgentConfig } from "../config/index.js";

const PUBLIC_RPC: Record<"devnet" | "mainnet", string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

/**
 * Build the read-only client for a given config. Uses the public Solana
 * RPC by default; an upcoming flag will let users supply their own
 * Helius / QuickNode URL via SIGIL_RPC_URL env var for mainnet
 * production traffic.
 */
export function buildReadClient(config: AgentConfig): {
  readonly client: ReturnType<typeof createOwnerClient>;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly owner: Address;
} {
  const rpcUrl = process.env.SIGIL_RPC_URL ?? PUBLIC_RPC[config.network];
  const rpc = createSolanaRpc(rpcUrl);
  const owner = address(config.ownerAddress);
  const vault = address(config.vaultAddress);
  // Reads don't need a real signer — NoopSigner satisfies the kit's
  // type contract for the owner field.
  const client = createOwnerClient({
    rpc,
    vault,
    owner: createNoopSigner(owner),
    network: config.network,
  });
  return { client, rpc, vault, owner };
}

/**
 * Build the agent's transaction signer from the persisted secret key.
 * Used by Day 2 seal_*  tools.
 */
export async function buildAgentSigner(
  config: AgentConfig,
): Promise<TransactionSigner> {
  const secret = new Uint8Array(config.agent.secretKey);
  if (secret.length !== 64) {
    throw new Error(
      `Agent secret key must be 64 bytes (Solana CLI format); got ${secret.length}`,
    );
  }
  const keyPair = await createKeyPairFromBytes(secret);
  return createSignerFromKeyPair(keyPair);
}
