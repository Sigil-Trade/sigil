import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from "@solana/kit";
import type { CustodyAdapter, Network } from "@usesigil/kit";

/** Convert plugin's "mainnet" to kit's "mainnet-beta" network string. */
export function toResolvedNetwork(network: "devnet" | "mainnet"): Network {
  return network === "mainnet" ? "mainnet-beta" : "devnet";
}

export interface SigilSakConfig {
  /** Vault PDA address. */
  vault: Address;
  /** Network selector. */
  network: "devnet" | "mainnet";
  /** @solana/kit RPC client. */
  rpc: Rpc<SolanaRpcApi>;
  /** Agent signer — either a Kit TransactionSigner or a CustodyAdapter (Turnkey/Privy). */
  agent: TransactionSigner | CustodyAdapter;
  /** Optional: Jupiter API base URL (defaults to public endpoint). */
  jupiterApiUrl?: string;
}
