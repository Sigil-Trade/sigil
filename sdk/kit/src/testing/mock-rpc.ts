/**
 * Reusable mock RPC factory for Kit SDK E2E tests.
 *
 * Provides canned responses for all RPC methods used in the execute pipeline.
 * No real network calls — everything returns predictable data.
 */

import type { Address, Rpc, SolanaRpcApi } from "../kit-adapter.js";

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
  /**
   * Override the rent-exemption response. Either:
   *  - A bigint → returned for every size
   *  - A function → called with the requested `size: bigint`, returns bigint
   *  - Omitted → mock returns `size * 6960n + 890_880n` (Solana's
   *    deterministic rent-exemption formula at typical lamports-per-byte-year).
   */
  getMinimumBalanceForRentExemptionResult?:
    | bigint
    | ((size: bigint) => bigint | Promise<bigint>);
  /**
   * Override `getMultipleAccounts` (what `fetchEncodedAccounts` calls under the
   * hood). Keyed by base58 address → the JSON-RPC account-info value, or `null`
   * for "does not exist". Addresses absent from the map resolve to `null`.
   * Used by the F-Q4 seal() satisfier tests, which fetch the writable DeFi
   * accounts to resolve vault-owned Token-2022 output mints.
   */
  getMultipleAccountsByAddress?: Record<string, unknown>;
}

export function createMockRpc(overrides?: MockRpcOverrides): Rpc<SolanaRpcApi> {
  // Solana's rent-exempt minimum is `(account_size + 128) * 6960` lamports
  // (lamports-per-byte-year × 2-year exemption). Producing a deterministic
  // size-dependent value lets tests assert per-PDA rent without hardcoding.
  const defaultRent = (size: bigint): bigint => (size + 128n) * 6_960n;
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
    // `fetchEncodedAccounts` (used by the F-Q4 seal() satisfier) calls this.
    // Returns one entry per requested address, in order; unknown addresses → null.
    getMultipleAccounts: (addresses: readonly Address[]) => ({
      send: async () => ({
        context: { slot: 100n },
        value: addresses.map(
          (a) => overrides?.getMultipleAccountsByAddress?.[a as string] ?? null,
        ),
      }),
    }),
    getMinimumBalanceForRentExemption: (size: bigint) => ({
      send: async () => {
        const o = overrides?.getMinimumBalanceForRentExemptionResult;
        if (typeof o === "bigint") return o;
        if (typeof o === "function") return o(size);
        return defaultRent(size);
      },
    }),
    // PEN-CROSS-2: `createVault` reads the current slot to bind into the
    // TA-19 digest. Deterministic mock value so test fixtures don't drift.
    getSlot: () => ({
      send: async () => 100n,
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
