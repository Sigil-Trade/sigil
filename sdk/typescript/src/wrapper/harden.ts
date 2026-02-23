import {
  PublicKey,
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN, AnchorProvider, Program } from "@coral-xyz/anchor";
import { ShieldedWallet, WalletLike, isTeeWallet } from "./shield";
import { ResolvedPolicies, TransactionAnalysis } from "./policies";
import { ShieldDeniedError, TeeRequiredError } from "./errors";
import {
  analyzeTransaction,
  extractInstructions,
  resolveTransactionAddressLookupTables,
} from "./inspector";
import { evaluatePolicy, recordTransaction } from "./engine";
import { ShieldState } from "./state";
import { shield } from "./shield";
import { isSystemProgram } from "./registry";
import type { ShieldPolicies, SpendingSummary } from "./policies";
import { AgentShieldClient } from "../client";
import { getVaultPDA, getPolicyPDA } from "../accounts";
import { composePermittedTransaction } from "../composer";
import { IDL } from "../idl-json";

/**
 * Configuration for hardening a shielded wallet to on-chain enforcement.
 */
export interface HardenOptions {
  /** Solana RPC connection */
  connection: Connection;
  /** Owner wallet — vault administrator. Auto-generates a Keypair if omitted. */
  ownerWallet?: WalletLike;
  /** Vault ID (auto-incremented if not provided) */
  vaultId?: number;
  /** Fee destination for the vault */
  feeDestination?: PublicKey;
  /** Developer fee rate (0-500, maps to on-chain rate). Default: 0 */
  developerFeeRate?: number;
  /** Override program ID (for devnet/testing) */
  programId?: PublicKey;
  /** Maximum leverage in basis points. Default: 0 */
  maxLeverageBps?: number;
  /** Maximum concurrent positions. Default: 5 */
  maxConcurrentPositions?: number;
  /** Skip TEE wallet requirement — devnet testing only. Default: false */
  unsafeSkipTeeCheck?: boolean;
  /** Auto-provision a TEE wallet from a custody provider */
  teeProvider?: "crossmint" | "turnkey" | "privy";
}

/**
 * Result of hardening a shielded wallet.
 */
export interface HardenResult {
  /** Hardened wallet with dual enforcement (client-side + on-chain) */
  wallet: ShieldedWallet;
  /** The owner keypair, only set if ownerWallet was NOT provided */
  ownerKeypair?: Keypair;
  /** The vault PDA address */
  vaultAddress: PublicKey;
  /** The vault ID used */
  vaultId: number;
  /** The policy PDA address */
  policyAddress: PublicKey;
}

/**
 * Map resolved client-side policies to on-chain InitializeVaultParams.
 *
 * Multiple per-token SpendLimits collapse to the largest value as the
 * on-chain dailySpendingCap (conservative ceiling). Per-token granularity
 * is enforced client-side. Fields with no on-chain equivalent
 * (blockUnknownPrograms, rateLimit, customCheck) stay client-side only.
 *
 * V2: No per-token allowlists on-chain — tokens are validated via the
 * global OracleRegistry. Protocol mode determines allowlist/denylist behavior.
 */
export function mapPoliciesToVaultParams(
  resolved: ResolvedPolicies,
  vaultId: number,
  feeDestination: PublicKey,
  opts?: {
    developerFeeRate?: number;
    maxLeverageBps?: number;
    maxConcurrentPositions?: number;
  },
): {
  vaultId: any; // BN — constructed at call site
  dailySpendingCap: bigint;
  maxTransactionSize: bigint;
  protocolMode: number;
  protocols: PublicKey[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
  feeDestination: PublicKey;
  developerFeeRate: number;
} {
  // Collapse multiple spend limits to the largest (ceiling cap)
  let maxCap = BigInt(0);

  for (const limit of resolved.spendLimits) {
    if (limit.amount > maxCap) {
      maxCap = limit.amount;
    }
  }

  // Allowed protocols (Set<string>|undefined), cap at 10
  const protocolArr = resolved.allowedProtocols
    ? Array.from(resolved.allowedProtocols)
    : [];
  const protocols = protocolArr.slice(0, 10).map((s) => new PublicKey(s));

  // Protocol mode: if protocols specified, use allowlist (1); else allow all (0)
  const protocolMode = protocols.length > 0 ? 1 : 0;

  // maxTransactionSize: use resolved value, fall back to dailySpendingCap
  const maxTransactionSize = resolved.maxTransactionSize ?? maxCap;

  return {
    vaultId,
    dailySpendingCap: maxCap,
    maxTransactionSize,
    protocolMode,
    protocols,
    maxLeverageBps: opts?.maxLeverageBps ?? 0,
    maxConcurrentPositions: opts?.maxConcurrentPositions ?? 5,
    feeDestination,
    developerFeeRate: opts?.developerFeeRate ?? 0,
  };
}

/**
 * Probe vault PDAs starting from 0 to find the next available vault ID.
 * Returns 0 for a new owner, or the first unused ID.
 */
export async function findNextVaultId(
  connection: Connection,
  ownerPubkey: PublicKey,
  programId?: PublicKey,
): Promise<number> {
  for (let id = 0; id <= 255; id++) {
    const [vaultPda] = getVaultPDA(ownerPubkey, new BN(id), programId);
    const account = await connection.getAccountInfo(vaultPda);
    if (!account) {
      return id;
    }
  }
  throw new Error("All 256 vault slots are in use for this owner.");
}

/**
 * Infer the token mint from a transaction analysis.
 * Uses the first outgoing transfer's mint, falls back to SOL mint.
 */
function inferTokenMint(analysis: TransactionAnalysis): PublicKey {
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  const outgoing = analysis.transfers.find((t) => t.direction === "outgoing");
  if (outgoing && !outgoing.mint.equals(PublicKey.default)) {
    return outgoing.mint;
  }
  return SOL_MINT;
}

/**
 * Infer the total outgoing amount from a transaction analysis.
 */
function inferAmount(analysis: TransactionAnalysis): bigint {
  return analysis.transfers
    .filter((t) => t.direction === "outgoing")
    .reduce((sum, t) => sum + t.amount, BigInt(0));
}

/**
 * Infer the target protocol from a transaction analysis.
 * Returns the first non-system program ID, or SystemProgram.
 */
function inferTargetProtocol(analysis: TransactionAnalysis): PublicKey {
  const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
  for (const pid of analysis.programIds) {
    if (!pid.equals(SYSTEM_PROGRAM)) {
      return pid;
    }
  }
  return SYSTEM_PROGRAM;
}

/**
 * Infer the ActionType from a transaction analysis.
 *
 * Pure SPL token transfer transactions → Transfer.
 * Everything else (Jupiter, Flash Trade, etc.) → Swap.
 */
function inferActionType(
  instructions: TransactionInstruction[],
): { swap: Record<string, never> } | { transfer: Record<string, never> } {
  const TOKEN_2022_PROGRAM = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  );
  const nonSystemIxs = instructions.filter(
    (ix) =>
      !isSystemProgram(ix.programId) &&
      !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  const allAreTokenTransfers =
    nonSystemIxs.length > 0 &&
    nonSystemIxs.every(
      (ix) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) ||
        ix.programId.equals(TOKEN_2022_PROGRAM),
    );
  return allAreTokenTransfers ? { transfer: {} } : { swap: {} };
}

/**
 * Create a hardened wallet that enforces policies both client-side and on-chain.
 *
 * Dual enforcement flow:
 * 1. Client-side policy check (fast deny)
 * 2. If approved, compose transaction with validate+authorize + original ixs + finalize
 * 3. Sign composed transaction with agent's inner wallet
 */
function createHardenedWallet(
  original: ShieldedWallet,
  vaultAddress: PublicKey,
  ownerPubkey: PublicKey,
  vaultId: number,
  connection: Connection,
  programId?: PublicKey,
): ShieldedWallet {
  const innerWallet = original.innerWallet;
  const state = original.shieldState;

  // We need the resolved policies and the pause state from the original
  // shield for client-side enforcement. We'll delegate to the original
  // for policy evaluation, but override signTransaction.

  const hardened: ShieldedWallet = {
    publicKey: original.publicKey,
    innerWallet,
    shieldState: state,
    isHardened: true,

    get resolvedPolicies(): ResolvedPolicies {
      return original.resolvedPolicies;
    },

    get isPaused(): boolean {
      return original.isPaused;
    },

    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      // If paused, pass through without enforcement
      if (original.isPaused) {
        return innerWallet.signTransaction(tx);
      }

      // Step 1: Client-side policy check (fast deny)
      let lookupTableAccounts: AddressLookupTableAccount[] | undefined;
      if (
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
        innerWallet.publicKey,
        lookupTableAccounts,
      );
      const violations = evaluatePolicy(
        analysis,
        original.resolvedPolicies,
        state,
      );

      if (violations.length > 0) {
        throw new ShieldDeniedError(violations);
      }

      // Step 2: Extract original instructions and compose with vault enforcement
      const originalIxs = extractInstructions(tx, lookupTableAccounts);
      const tokenMint = inferTokenMint(analysis);
      const amount = inferAmount(analysis);
      const targetProtocol = inferTargetProtocol(analysis);

      const vaultTokenAccount = getAssociatedTokenAddressSync(
        tokenMint,
        vaultAddress,
        true,
      );

      const program = createProgram(connection, innerWallet, programId);

      const composedTx = await composePermittedTransaction(
        program,
        connection,
        {
          vault: vaultAddress,
          owner: ownerPubkey,
          vaultId: new BN(vaultId),
          agent: innerWallet.publicKey,
          actionType: inferActionType(originalIxs),
          tokenMint,
          amount: new BN(amount.toString()),
          targetProtocol,
          defiInstructions: originalIxs,
          vaultTokenAccount,
        },
      );

      // Step 3: Sign the composed transaction with the inner wallet
      const signed = await innerWallet.signTransaction(composedTx);

      // Step 4: Record in client-side state
      recordTransaction(analysis, state);

      return signed as unknown as T;
    },

    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      const results: T[] = [];
      for (const tx of txs) {
        results.push(await hardened.signTransaction(tx));
      }
      return results;
    },

    updatePolicies(policies: ShieldPolicies): void {
      original.updatePolicies(policies);
    },

    resetState(): void {
      original.resetState();
    },

    pause(): void {
      original.pause();
    },

    resume(): void {
      original.resume();
    },

    getSpendingSummary(): SpendingSummary {
      return original.getSpendingSummary();
    },
  };

  // Expose vault metadata for x402 hardened path
  (hardened as any)._vaultAddress = vaultAddress;
  (hardened as any)._vaultId = vaultId;
  (hardened as any)._programId = programId;
  (hardened as any)._ownerPubkey = ownerPubkey;
  (hardened as any)._connection = connection;

  return hardened;
}

/**
 * Create a Program instance for vault operations.
 * Uses the inner wallet as the signer.
 */
function createProgram(
  connection: Connection,
  wallet: WalletLike,
  programId?: PublicKey,
): any {
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  const idl = { ...IDL } as any;
  if (programId) {
    idl.address = programId.toBase58();
  }
  return new Program(idl, provider) as any;
}

/**
 * Create an Anchor Wallet from a WalletLike.
 * If the wallet has a `payer` property (Keypair-based), use it directly.
 * Otherwise create a wrapper that delegates to signTransaction.
 */
function toAnchorWallet(wallet: WalletLike): any {
  return {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction.bind(wallet),
    signAllTransactions:
      wallet.signAllTransactions?.bind(wallet) ??
      ((txs: any[]) =>
        Promise.all(txs.map((tx: any) => wallet.signTransaction(tx)))),
  };
}

/**
 * Harden a shielded wallet with on-chain vault enforcement.
 *
 * Creates an on-chain AgentShield vault, registers the wallet as an agent,
 * and configures policies matching the wrapper config. Requires a TEE-backed
 * wallet unless unsafeSkipTeeCheck is set (devnet only).
 *
 * @example
 * ```typescript
 * import { withVault } from '@agent-shield/sdk';
 *
 * const result = await withVault(teeWallet, { maxSpend: '500 USDC/day' }, {
 *   connection,
 * });
 * // result.wallet is ready with full on-chain enforcement
 * ```
 */
export async function harden(
  shieldedWallet: ShieldedWallet,
  options: HardenOptions,
): Promise<HardenResult> {
  // Resolve owner: use provided wallet or auto-generate a keypair
  let ownerKeypair: Keypair | undefined;
  let ownerWallet: WalletLike;

  if (options.ownerWallet) {
    ownerWallet = options.ownerWallet;
  } else {
    ownerKeypair = Keypair.generate();
    ownerWallet = {
      publicKey: ownerKeypair.publicKey,
      async signTransaction<T extends Transaction | VersionedTransaction>(
        tx: T,
      ): Promise<T> {
        if (tx instanceof VersionedTransaction) {
          tx.sign([ownerKeypair!]);
          return tx;
        }
        (tx as Transaction).partialSign(ownerKeypair!);
        return tx;
      },
    };
  }

  const agentPubkey = shieldedWallet.innerWallet.publicKey;
  const ownerPubkey = ownerWallet.publicKey;

  // Validate owner != agent
  if (ownerPubkey.equals(agentPubkey)) {
    throw new Error(
      "Owner and agent must be different keys. The wallet passed to shield() is the agent key. " +
        "Provide a different ownerWallet in HardenOptions, or omit it to auto-generate one.",
    );
  }

  // Enforce TEE requirement — production agents must use TEE custody
  if (!options.unsafeSkipTeeCheck && !isTeeWallet(shieldedWallet.innerWallet)) {
    throw new TeeRequiredError();
  }

  // Create client with owner wallet (owner signs vault creation + agent registration)
  const client = new AgentShieldClient(
    options.connection,
    toAnchorWallet(ownerWallet),
    options.programId,
  );

  // Find next vault ID if not provided
  const vaultId =
    options.vaultId ??
    (await findNextVaultId(options.connection, ownerPubkey, options.programId));

  // Map policies to vault params
  const feeDestination = options.feeDestination ?? ownerPubkey;
  const mapped = mapPoliciesToVaultParams(
    shieldedWallet.resolvedPolicies,
    vaultId,
    feeDestination,
    {
      developerFeeRate: options.developerFeeRate,
      maxLeverageBps: options.maxLeverageBps,
      maxConcurrentPositions: options.maxConcurrentPositions,
    },
  );

  // Convert bigints to BN for the SDK
  const vaultParams = {
    vaultId: new BN(mapped.vaultId),
    dailySpendingCapUsd: new BN(mapped.dailySpendingCap.toString()),
    maxTransactionSizeUsd: new BN(mapped.maxTransactionSize.toString()),
    protocolMode: mapped.protocolMode,
    protocols: mapped.protocols,
    maxLeverageBps: mapped.maxLeverageBps,
    maxConcurrentPositions: mapped.maxConcurrentPositions,
    feeDestination: mapped.feeDestination,
    developerFeeRate: mapped.developerFeeRate,
  };

  // Create vault (signed by owner)
  try {
    await client.createVault(vaultParams);
  } catch (err: any) {
    throw new Error(
      `Failed to create on-chain vault: ${err.message ?? err}. ` +
        "Ensure the owner wallet has enough SOL for rent.",
    );
  }

  // Derive vault PDA address
  const [vaultAddress] = client.getVaultPDA(ownerPubkey, new BN(vaultId));
  const [policyAddress] = client.getPolicyPDA(vaultAddress);

  // Register agent (signed by owner)
  try {
    await client.registerAgent(vaultAddress, agentPubkey);
  } catch (err: any) {
    throw new Error(
      `Vault created at ${vaultAddress.toBase58()} but agent registration failed: ${err.message ?? err}. ` +
        "You can manually register the agent using the vault SDK: " +
        `client.registerAgent(new PublicKey("${vaultAddress.toBase58()}"), agentPubkey)`,
    );
  }

  // Build hardened wallet with dual enforcement
  const wallet = createHardenedWallet(
    shieldedWallet,
    vaultAddress,
    ownerPubkey,
    vaultId,
    options.connection,
    options.programId,
  );

  return {
    wallet,
    ownerKeypair,
    vaultAddress,
    vaultId,
    policyAddress,
  };
}

/**
 * The primary developer-facing function. Wraps a wallet with client-side policy
 * enforcement and hardens it to on-chain vault enforcement in one call.
 *
 * One call = full protection: client-side fast deny + on-chain vault enforcement.
 *
 * @example
 * ```typescript
 * import { withVault } from '@agent-shield/sdk';
 *
 * // Simplest path: bring your TEE wallet
 * const result = await withVault(teeWallet, { maxSpend: '500 USDC/day' }, {
 *   connection,
 * });
 *
 * // Devnet testing (no TEE required)
 * const result = await withVault(wallet, { maxSpend: '500 USDC/day' }, {
 *   connection,
 *   unsafeSkipTeeCheck: true,
 * });
 * ```
 */
export async function withVault(
  wallet: WalletLike,
  policies: ShieldPolicies | undefined,
  options: HardenOptions,
): Promise<HardenResult> {
  const shielded = shield(wallet, policies);
  return harden(shielded, options);
}
