import {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { ShieldPolicies, resolvePolicies } from "./policies";
import { analyzeTransaction } from "./inspector";
import { evaluatePolicy, recordTransaction } from "./engine";
import { ShieldDeniedError } from "./errors";
import { ShieldState, ShieldStorage } from "./state";

/**
 * A wallet-like object that shield() can wrap.
 * Compatible with Keypair wallets, wallet adapters, Turnkey, Privy, Coinbase, etc.
 */
export interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]>;
}

/**
 * A shielded wallet — same interface as the input wallet, with policy enforcement.
 */
export interface ShieldedWallet extends WalletLike {
  /** The underlying wallet before shielding */
  readonly innerWallet: WalletLike;
  /** Current shield state (spending tracker, rate limiter) */
  readonly shieldState: ShieldState;
  /** Whether this wallet has been hardened (on-chain enforcement) */
  readonly isHardened: boolean;
  /** Update policies at runtime */
  updatePolicies(policies: ShieldPolicies): void;
  /** Reset all spending state */
  resetState(): void;
}

export interface ShieldOptions {
  /** Custom storage backend for state persistence. Default: auto-detect (localStorage in browser, in-memory in Node.js) */
  storage?: ShieldStorage;
  /** Event handler called when a transaction is denied */
  onDenied?: (error: ShieldDeniedError) => void;
  /** Event handler called when a transaction is approved and signed */
  onApproved?: (txHash: string | null) => void;
}

/**
 * Wrap any wallet with client-side spending controls.
 *
 * @example
 * ```typescript
 * import { shield } from '@agent-shield/solana';
 *
 * const protectedWallet = shield(wallet, { maxSpend: '500 USDC/day' });
 * const agent = new SolanaAgentKit(protectedWallet, RPC_URL, config);
 * ```
 *
 * With no config, secure defaults are applied:
 * - 1000 USDC/day, 1000 USDT/day, 10 SOL/day spending caps
 * - Unknown programs blocked
 * - 60 transactions/hour rate limit
 */
export function shield(
  wallet: WalletLike,
  policies?: ShieldPolicies,
  options?: ShieldOptions,
): ShieldedWallet {
  let resolved = resolvePolicies(policies);
  const state = new ShieldState(options?.storage);
  const onDenied = options?.onDenied;
  const onApproved = options?.onApproved;

  const shielded: ShieldedWallet = {
    publicKey: wallet.publicKey,
    innerWallet: wallet,
    shieldState: state,
    isHardened: false,

    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const violations = evaluatePolicy(analysis, resolved, state);

      if (violations.length > 0) {
        const error = new ShieldDeniedError(violations);
        onDenied?.(error);
        throw error;
      }

      // Policy passed — sign with underlying wallet
      const signed = await wallet.signTransaction(tx);

      // Record the spend and transaction
      recordTransaction(analysis, state);
      onApproved?.(null);

      return signed;
    },

    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      // Evaluate each transaction sequentially, recording spends into state
      // as we go so cumulative caps are enforced across the batch.
      const analyses = txs.map((tx) =>
        analyzeTransaction(tx, wallet.publicKey),
      );

      for (const analysis of analyses) {
        const violations = evaluatePolicy(analysis, resolved, state);
        if (violations.length > 0) {
          const error = new ShieldDeniedError(violations);
          onDenied?.(error);
          throw error;
        }
        // Record into state so the next tx sees cumulative spend
        recordTransaction(analysis, state);
      }

      // All passed — sign with underlying wallet
      let signed: T[];
      if (wallet.signAllTransactions) {
        signed = await wallet.signAllTransactions(txs);
      } else {
        signed = await Promise.all(
          txs.map((tx) => wallet.signTransaction(tx)),
        );
      }
      onApproved?.(null);

      return signed;
    },

    updatePolicies(newPolicies: ShieldPolicies): void {
      resolved = resolvePolicies(newPolicies);
    },

    resetState(): void {
      state.reset();
    },
  };

  return shielded;
}
