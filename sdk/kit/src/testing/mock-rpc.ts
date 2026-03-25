/**
 * Reusable mock RPC factory for Kit SDK E2E tests.
 *
 * Provides canned responses for all RPC methods used in the execute pipeline.
 * No real network calls — everything returns predictable data.
 */

import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { VaultStatus } from "../generated/types/vaultStatus.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MOCK_VAULT =
  "Vault111111111111111111111111111111111111111" as Address;
export const MOCK_AGENT =
  "Agent111111111111111111111111111111111111111" as Address;
export const MOCK_OWNER =
  "Owner111111111111111111111111111111111111111" as Address;
export const MOCK_POLICY =
  "Policy11111111111111111111111111111111111111" as Address;
export const MOCK_SIGNATURE =
  "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";

export const MOCK_BLOCKHASH = {
  blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
  lastValidBlockHeight: 1000n,
};

export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── Mock RPC Factory ───────────────────────────────────────────────────────

export interface MockRpcOverrides {
  simulateResult?: { value: any };
  sendResult?: string;
  statusResult?: { value: unknown[] };
  getAccountInfoResult?: any;
}

export function createMockRpc(overrides?: MockRpcOverrides): Rpc<SolanaRpcApi> {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({ value: MOCK_BLOCKHASH }),
    }),
    simulateTransaction: () => ({
      send: async () =>
        overrides?.simulateResult ?? {
          value: { err: null, logs: [], unitsConsumed: 400_000 },
        },
    }),
    sendTransaction: () => ({
      send: async () => overrides?.sendResult ?? MOCK_SIGNATURE,
    }),
    getSignatureStatuses: () => ({
      send: async () =>
        overrides?.statusResult ?? {
          value: [{ confirmationStatus: "confirmed", err: null }],
        },
    }),
    getAccountInfo: () => ({
      send: async () => overrides?.getAccountInfoResult ?? { value: null },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

// ─── Mock Agent Signer ──────────────────────────────────────────────────────

export function createMockAgent(address: Address = MOCK_AGENT) {
  return {
    address,
    modifyAndSignTransactions: async (txs: unknown[]) => txs,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}
