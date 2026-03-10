import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ShieldPolicies,
  SpendingSummary,
  ResolvedPolicies,
  resolvePolicies,
} from "./policies";
import {
  analyzeTransaction,
  resolveTransactionAddressLookupTables,
} from "./inspector";
import { evaluatePolicy, recordTransaction } from "./engine";
import { ShieldDeniedError } from "./errors";
import { ShieldState, ShieldStorage } from "./state";
import { getTokenInfo } from "./registry";
import { dryRunPolicy } from "./dry-run";
import type { DryRunInput, DryRunResult } from "./dry-run";

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
 * A TEE-backed wallet — extends WalletLike with a provider identifier.
 * Compatible with Crossmint, Turnkey, Privy, or any TEE custody provider.
 */
export interface TeeWallet extends WalletLike {
  readonly provider: string;
  /** Optional: API-based custody verification. Returns true if the provider confirms
   *  this wallet's key is in their TEE custody system. */
  verifyProviderCustody?(): Promise<boolean>;
}

/**
 * Type guard to detect TEE-backed wallets at runtime.
 */
export function isTeeWallet(wallet: WalletLike): wallet is TeeWallet {
  return (
    "provider" in wallet &&
    typeof (wallet as Record<string, unknown>).provider === "string" &&
    ((wallet as Record<string, unknown>).provider as string).length > 0
  );
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
  /** The currently active resolved policies */
  readonly resolvedPolicies: ResolvedPolicies;
  /** Whether policy enforcement is currently paused */
  readonly isPaused: boolean;
  /** Update policies at runtime */
  updatePolicies(policies: ShieldPolicies): void;
  /** Reset all spending state */
  resetState(): void;
  /** Pause the wallet — blocks all signing with ShieldDeniedError until resume() is called */
  pause(): void;
  /** Resume policy enforcement after a pause */
  resume(): void;
  /** Get a summary of current spending relative to policy limits */
  getSpendingSummary(): SpendingSummary;
  /** Dry-run a hypothetical action against policies without executing */
  dryRun(input: DryRunInput): DryRunResult;
  /** Make an HTTP request with automatic x402 payment support */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface ShieldOptions {
  /** Solana RPC connection — enables Address Lookup Table resolution for VersionedTransactions */
  connection?: Connection;
  /** Custom storage backend for state persistence. Default: auto-detect (localStorage in browser, in-memory in Node.js) */
  storage?: ShieldStorage;
  /** Event handler called when a transaction is denied */
  onDenied?: (error: ShieldDeniedError) => void;
  /** Event handler called when a transaction is approved and signed */
  onApproved?: (txHash: string | null) => void;
  /** Event handler called when policies are updated via updatePolicies() */
  onPolicyUpdate?: (policies: ShieldPolicies) => void;
  /** Event handler called when enforcement is paused */
  onPause?: () => void;
  /** Event handler called when enforcement is resumed */
  onResume?: () => void;
}

/**
 * Wrap any wallet with client-side spending controls.
 *
 * @example
 * ```typescript
 * import { shieldWallet } from '@phalnx/sdk';
 *
 * const protectedWallet = shieldWallet(wallet, { maxSpend: '500 USDC/day' });
 * const agent = new SolanaAgentKit(protectedWallet, RPC_URL, config);
 * ```
 *
 * With no config, secure defaults are applied:
 * - 1000 USDC/day, 1000 USDT/day, 10 SOL/day spending caps
 * - Unknown programs blocked
 * - 60 transactions/hour rate limit
 * @internal Use shieldWallet() instead
 */
export function shield(
  wallet: WalletLike,
  policies?: ShieldPolicies,
  options?: ShieldOptions,
): ShieldedWallet {
  let resolved = resolvePolicies(policies);
  const connection = options?.connection;
  const state = new ShieldState(options?.storage);
  const onDenied = options?.onDenied;
  const onApproved = options?.onApproved;
  const onPolicyUpdate = options?.onPolicyUpdate;
  const onPause = options?.onPause;
  const onResume = options?.onResume;
  let paused = false;

  const shielded: ShieldedWallet = {
    publicKey: wallet.publicKey,
    innerWallet: wallet,
    shieldState: state,
    isHardened: false,

    get resolvedPolicies(): ResolvedPolicies {
      return resolved;
    },

    get isPaused(): boolean {
      return paused;
    },

    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      if (paused) {
        throw new ShieldDeniedError([
          {
            rule: "rate_limit",
            message:
              "Wallet is paused — all signing is blocked until resume() is called",
            suggestion: "Call resume() to re-enable signing",
          },
        ]);
      }

      // Resolve ALTs for VersionedTransactions when connection is available
      let lookupTableAccounts: AddressLookupTableAccount[] | undefined;
      if (
        connection &&
        tx instanceof VersionedTransaction &&
        tx.message.addressTableLookups.length > 0
      ) {
        lookupTableAccounts = await resolveTransactionAddressLookupTables(
          tx,
          connection,
        );
      }

      const analysis = analyzeTransaction(
        tx,
        wallet.publicKey,
        lookupTableAccounts,
      );
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
      if (paused) {
        throw new ShieldDeniedError([
          {
            rule: "rate_limit",
            message:
              "Wallet is paused — all signing is blocked until resume() is called",
            suggestion: "Call resume() to re-enable signing",
          },
        ]);
      }

      // Resolve ALTs for any VersionedTransactions in the batch,
      // caching resolved ALTs across the batch to avoid redundant RPCs.
      const altCache = new Map<string, AddressLookupTableAccount>();
      const analyses = [];
      for (const tx of txs) {
        let lookupTableAccounts: AddressLookupTableAccount[] | undefined;
        if (
          connection &&
          tx instanceof VersionedTransaction &&
          tx.message.addressTableLookups.length > 0
        ) {
          const cached: AddressLookupTableAccount[] = [];
          let hasMissing = false;
          for (const lookup of tx.message.addressTableLookups) {
            const key = lookup.accountKey.toBase58();
            const existing = altCache.get(key);
            if (existing) {
              cached.push(existing);
            } else {
              hasMissing = true;
            }
          }
          if (hasMissing) {
            const fetched = await resolveTransactionAddressLookupTables(
              tx,
              connection,
            );
            for (const alt of fetched) {
              altCache.set(alt.key.toBase58(), alt);
            }
            // Rebuild from cache to get all ALTs in order
            cached.length = 0;
            for (const lookup of tx.message.addressTableLookups) {
              const alt = altCache.get(lookup.accountKey.toBase58());
              if (alt) cached.push(alt);
            }
          }
          lookupTableAccounts = cached;
        }
        analyses.push(
          analyzeTransaction(tx, wallet.publicKey, lookupTableAccounts),
        );
      }

      const cp = state.checkpoint();
      try {
        for (const analysis of analyses) {
          const violations = evaluatePolicy(analysis, resolved, state);
          if (violations.length > 0) {
            throw new ShieldDeniedError(violations);
          }
          // Record into state so next tx sees cumulative spend
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
      } catch (err) {
        // Rollback phantom spends on ANY error (policy denial or signing failure)
        state.rollback(cp);
        // Fire callbacks AFTER rollback so state is consistent when handler reads it
        if (err instanceof ShieldDeniedError) {
          onDenied?.(err);
        }
        throw err;
      }
    },

    updatePolicies(newPolicies: ShieldPolicies): void {
      resolved = resolvePolicies(newPolicies);
      onPolicyUpdate?.(newPolicies);
    },

    resetState(): void {
      state.reset();
    },

    pause(): void {
      paused = true;
      onPause?.();
    },

    resume(): void {
      paused = false;
      onResume?.();
    },

    dryRun(input: DryRunInput): DryRunResult {
      return dryRunPolicy(resolved, state, input);
    },

    getSpendingSummary(): SpendingSummary {
      const tokens = resolved.spendLimits.map((limit) => {
        const spent = state.getSpendInWindow(
          limit.mint,
          limit.windowMs ?? 86_400_000,
        );
        const remaining =
          limit.amount > spent ? limit.amount - spent : BigInt(0);
        const tokenInfo = getTokenInfo(limit.mint);
        return {
          mint: limit.mint,
          symbol: tokenInfo?.symbol,
          spent,
          limit: limit.amount,
          remaining,
          windowMs: limit.windowMs ?? 86_400_000,
        };
      });

      const txCount = state.getTransactionCountInWindow(
        resolved.rateLimit.windowMs,
      );
      const rateLimit = {
        count: txCount,
        limit: resolved.rateLimit.maxTransactions,
        remaining: Math.max(0, resolved.rateLimit.maxTransactions - txCount),
        windowMs: resolved.rateLimit.windowMs,
      };

      return { tokens, rateLimit, isPaused: paused };
    },
  };

  // Wire up x402 fetch support (lazy-loaded)
  shielded.fetch = async (url, init) => {
    const { shieldedFetch } = await import("./x402");
    return shieldedFetch(shielded, url, { ...init, connection });
  };

  return shielded;
}
