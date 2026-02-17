import {
  PublicKey,
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { ShieldedWallet, WalletLike } from "./shield";
import { ResolvedPolicies, TransactionAnalysis } from "./policies";
import { ShieldDeniedError } from "./errors";
import {
  analyzeTransaction,
  extractInstructions,
  resolveTransactionAddressLookupTables,
} from "./inspector";
import { evaluatePolicy, recordTransaction } from "./engine";
import { ShieldState } from "./state";
import { shield } from "./shield";
import type { ShieldPolicies, SpendingSummary } from "./policies";

/**
 * Configuration for hardening a shielded wallet to on-chain enforcement.
 * Requires @agent-shield/sdk as a peer dependency.
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
  /** Developer fee rate (0-50, maps to on-chain rate). Default: 0 */
  developerFeeRate?: number;
  /** Override program ID (for devnet/testing) */
  programId?: PublicKey;
  /** Maximum leverage in basis points. Default: 0 */
  maxLeverageBps?: number;
  /** Maximum concurrent positions. Default: 5 */
  maxConcurrentPositions?: number;
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

// Lazy-loaded SDK module reference
type VaultSDK = typeof import("@agent-shield/sdk");

/**
 * Load the vault SDK dynamically. Throws a clear error if not installed.
 */
async function loadVaultSDK(): Promise<VaultSDK> {
  try {
    return await import("@agent-shield/sdk");
  } catch {
    throw new Error(
      "harden() requires @agent-shield/sdk. Install it with: npm install @agent-shield/sdk",
    );
  }
}

/**
 * Map resolved client-side policies to on-chain InitializeVaultParams.
 *
 * Multiple per-token SpendLimits collapse to the largest value as the
 * on-chain dailySpendingCap (conservative ceiling). Per-token granularity
 * is enforced client-side. Fields with no on-chain equivalent
 * (blockUnknownPrograms, rateLimit, customCheck) stay client-side only.
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
  allowedTokens: PublicKey[];
  allowedProtocols: PublicKey[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
  feeDestination: PublicKey;
  developerFeeRate: number;
} {
  // Collapse multiple spend limits to the largest (ceiling cap)
  let maxCap = BigInt(0);
  const tokenMintSet = new Set<string>();

  for (const limit of resolved.spendLimits) {
    if (limit.amount > maxCap) {
      maxCap = limit.amount;
    }
    // Collect token mints from spend limits
    tokenMintSet.add(limit.mint);
  }

  // Merge explicitly allowed tokens (deduped) — allowedTokens is Set<string>|undefined
  if (resolved.allowedTokens) {
    for (const t of resolved.allowedTokens) {
      tokenMintSet.add(t);
    }
  }

  // Cap at 10 tokens (on-chain limit)
  const allowedTokens = Array.from(tokenMintSet)
    .slice(0, 10)
    .map((s) => new PublicKey(s));

  // Allowed protocols (Set<string>|undefined), cap at 10
  const protocolArr = resolved.allowedProtocols
    ? Array.from(resolved.allowedProtocols)
    : [];
  const allowedProtocols = protocolArr
    .slice(0, 10)
    .map((s) => new PublicKey(s));

  // maxTransactionSize: use resolved value, fall back to dailySpendingCap
  const maxTransactionSize = resolved.maxTransactionSize ?? maxCap;

  return {
    vaultId,
    dailySpendingCap: maxCap,
    maxTransactionSize,
    allowedTokens,
    allowedProtocols,
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
  sdk: VaultSDK,
  connection: Connection,
  ownerPubkey: PublicKey,
  programId?: PublicKey,
): Promise<number> {
  for (let id = 0; id <= 255; id++) {
    const BN = (await import("@coral-xyz/anchor")).BN;
    const [vaultPda] = sdk.getVaultPDA(ownerPubkey, new BN(id), programId);
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
  const SOL_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );
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
  const SYSTEM_PROGRAM = new PublicKey(
    "11111111111111111111111111111111",
  );
  for (const pid of analysis.programIds) {
    if (!pid.equals(SYSTEM_PROGRAM)) {
      return pid;
    }
  }
  return SYSTEM_PROGRAM;
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
  sdk: VaultSDK,
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

      const { BN } = await import("@coral-xyz/anchor");

      const composedTx = await sdk.composePermittedTransaction(
        // We need a Program instance — create a minimal client
        // The SDK's composePermittedTransaction needs program + connection
        // We'll use the lower-level compose function
        await createProgram(sdk, connection, innerWallet, programId),
        connection,
        {
          vault: vaultAddress,
          owner: ownerPubkey,
          vaultId: new BN(vaultId),
          agent: innerWallet.publicKey,
          actionType: { swap: {} },
          tokenMint,
          amount: new BN(amount.toString()),
          targetProtocol,
          defiInstructions: originalIxs,
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

  return hardened;
}

/**
 * Create a Program instance for the vault SDK.
 * Uses the inner wallet as the signer.
 */
async function createProgram(
  sdk: VaultSDK,
  connection: Connection,
  wallet: WalletLike,
  programId?: PublicKey,
): Promise<any> {
  const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
  const provider = new AnchorProvider(
    connection,
    wallet as any,
    { commitment: "confirmed" },
  );
  const idl = { ...sdk.IDL } as any;
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
      ((txs: any[]) => Promise.all(txs.map((tx: any) => wallet.signTransaction(tx)))),
  };
}

/**
 * Upgrade a shielded wallet from client-side enforcement (Level 1)
 * to on-chain vault enforcement (Level 3).
 *
 * This creates an on-chain AgentShield vault, registers the wallet
 * as an agent, and configures policies matching the wrapper config.
 *
 * Requires @agent-shield/sdk to be installed:
 * ```
 * npm install @agent-shield/sdk
 * ```
 *
 * @example
 * ```typescript
 * import { shield } from '@agent-shield/solana';
 * import { harden } from '@agent-shield/solana/harden';
 *
 * const protected = shield(wallet, { maxSpend: '500 USDC/day' });
 * const result = await harden(protected, {
 *   connection,
 *   feeDestination: myFeeWallet,
 * });
 * // result.wallet is now hardened with dual enforcement
 * ```
 */
export async function harden(
  shieldedWallet: ShieldedWallet,
  options: HardenOptions,
): Promise<HardenResult> {
  const sdk = await loadVaultSDK();

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

  // Create client with owner wallet (owner signs vault creation + agent registration)
  const client = new sdk.AgentShieldClient(
    options.connection,
    toAnchorWallet(ownerWallet),
    options.programId,
  );

  // Find next vault ID if not provided
  const vaultId = options.vaultId ??
    await findNextVaultId(sdk, options.connection, ownerPubkey, options.programId);

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
  const { BN } = await import("@coral-xyz/anchor");
  const vaultParams = {
    vaultId: new BN(mapped.vaultId),
    dailySpendingCap: new BN(mapped.dailySpendingCap.toString()),
    maxTransactionSize: new BN(mapped.maxTransactionSize.toString()),
    allowedTokens: mapped.allowedTokens,
    allowedProtocols: mapped.allowedProtocols,
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
    sdk,
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
 * Create a shielded wallet and harden it to on-chain enforcement in one call.
 * Equivalent to `shield(wallet, policies)` followed by `harden(shielded, options)`.
 *
 * @example
 * ```typescript
 * import { withVault } from '@agent-shield/solana';
 *
 * const result = await withVault(wallet, { maxSpend: '500 USDC/day' }, {
 *   connection,
 * });
 * // result.wallet is ready to use with dual enforcement
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
