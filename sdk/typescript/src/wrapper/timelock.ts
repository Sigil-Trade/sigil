import { PublicKey, Connection } from "@solana/web3.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { PhalnxClient } from "../client";
import { getPendingPolicyPDA, fetchPendingPolicy } from "../accounts";
import { IDL } from "../idl-json";
import type {
  PendingPolicyUpdateAccount,
  QueuePolicyUpdateParams,
} from "../types";
import type { HardenResult } from "./harden";
import type { WalletLike } from "./shield";

/**
 * Wrapper-friendly policy update params using plain numbers instead of BN.
 * Mirrors QueuePolicyUpdateParams but with number types for ergonomics.
 */
export interface TimelockPolicyParams {
  dailySpendingCapUsd?: number | null;
  maxTransactionAmountUsd?: number | null;
  protocolMode?: number | null;
  protocols?: PublicKey[] | null;
  maxLeverageBps?: number | null;
  canOpenPositions?: boolean | null;
  maxConcurrentPositions?: number | null;
  developerFeeRate?: number | null;
  timelockDuration?: number | null;
  allowedDestinations?: PublicKey[] | null;
}

/**
 * Context needed for timelock operations. Owner-signed, not agent-signed.
 */
export interface TimelockContext {
  /** The vault PDA address */
  vaultAddress: PublicKey;
  /** Solana RPC connection */
  connection: Connection;
  /** Owner wallet — signs timelock operations */
  ownerWallet: WalletLike;
  /** Override program ID (for devnet/testing) */
  programId?: PublicKey;
}

/**
 * Vault manager interface for ergonomic repeated timelock operations.
 */
export interface VaultManager {
  /** The vault PDA address */
  vaultAddress: PublicKey;
  /** Queue a timelocked policy update */
  queuePolicyUpdate(params: TimelockPolicyParams): Promise<string>;
  /** Apply a pending policy update after the timelock expires */
  applyPendingPolicy(): Promise<string>;
  /** Cancel a pending policy update */
  cancelPendingPolicy(): Promise<string>;
  /** Fetch the current pending policy update status (null if none) */
  fetchPendingPolicy(): Promise<PendingPolicyUpdateAccount | null>;
}

/**
 * Create a TimelockContext from a HardenResult.
 * Convenience helper — avoids manually extracting fields.
 */
export function timelockContextFromResult(
  result: HardenResult,
  ownerWallet: WalletLike,
  connection: Connection,
): TimelockContext {
  return {
    vaultAddress: result.vaultAddress,
    connection,
    ownerWallet,
    programId: (result as any).wallet?._programId,
  };
}

/**
 * Convert wrapper-friendly TimelockPolicyParams to on-chain QueuePolicyUpdateParams.
 */
function toQueueParams(params: TimelockPolicyParams): QueuePolicyUpdateParams {
  return {
    dailySpendingCapUsd:
      params.dailySpendingCapUsd != null
        ? new BN(params.dailySpendingCapUsd)
        : (params.dailySpendingCapUsd as null | undefined),
    maxTransactionAmountUsd:
      params.maxTransactionAmountUsd != null
        ? new BN(params.maxTransactionAmountUsd)
        : (params.maxTransactionAmountUsd as null | undefined),
    protocolMode: params.protocolMode,
    protocols: params.protocols,
    maxLeverageBps: params.maxLeverageBps,
    canOpenPositions: params.canOpenPositions,
    maxConcurrentPositions: params.maxConcurrentPositions,
    developerFeeRate: params.developerFeeRate,
    timelockDuration:
      params.timelockDuration != null
        ? new BN(params.timelockDuration)
        : (params.timelockDuration as null | undefined),
    allowedDestinations: params.allowedDestinations,
  };
}

/**
 * Create an PhalnxClient configured with the owner wallet.
 */
function createOwnerClient(ctx: TimelockContext): PhalnxClient {
  const anchorWallet = {
    publicKey: ctx.ownerWallet.publicKey,
    signTransaction: ctx.ownerWallet.signTransaction.bind(ctx.ownerWallet),
    signAllTransactions:
      ctx.ownerWallet.signAllTransactions?.bind(ctx.ownerWallet) ??
      ((txs: any[]) =>
        Promise.all(txs.map((tx: any) => ctx.ownerWallet.signTransaction(tx)))),
  };
  return new PhalnxClient(ctx.connection, anchorWallet as any, ctx.programId);
}

/**
 * Create an Anchor Program for read-only operations (no wallet needed for fetches).
 */
function createReadProgram(connection: Connection, programId?: PublicKey): any {
  // Use a dummy wallet for read-only operations
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any[]) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet as any, {
    commitment: "confirmed",
  });
  const idl = { ...IDL } as any;
  if (programId) {
    idl.address = programId.toBase58();
  }
  return new Program(idl, provider);
}

// --- Standalone Functions ---

/**
 * Queue a timelocked policy update. Owner-signed.
 *
 * The update will be pending for `timelockDuration` seconds before it
 * can be applied via `applyPendingPolicy()`.
 */
export async function queuePolicyUpdate(
  ctx: TimelockContext,
  params: TimelockPolicyParams,
): Promise<string> {
  const client = createOwnerClient(ctx);
  return client.queuePolicyUpdate(ctx.vaultAddress, toQueueParams(params));
}

/**
 * Apply a pending policy update after the timelock has expired. Owner-signed.
 *
 * Throws if no pending update exists or the timelock hasn't elapsed.
 */
export async function applyPendingPolicy(
  ctx: TimelockContext,
): Promise<string> {
  const client = createOwnerClient(ctx);
  return client.applyPendingPolicy(ctx.vaultAddress);
}

/**
 * Cancel a pending policy update. Owner-signed.
 *
 * Can be called at any time while an update is pending.
 */
export async function cancelPendingPolicy(
  ctx: TimelockContext,
): Promise<string> {
  const client = createOwnerClient(ctx);
  return client.cancelPendingPolicy(ctx.vaultAddress);
}

/**
 * Fetch the current pending policy update status. Read-only (no signer needed).
 *
 * Returns null if no pending update exists.
 */
export async function fetchPendingPolicyStatus(
  ctx: Omit<TimelockContext, "ownerWallet">,
): Promise<PendingPolicyUpdateAccount | null> {
  const program = createReadProgram(ctx.connection, ctx.programId);
  return fetchPendingPolicy(program, ctx.vaultAddress);
}

/**
 * Create a VaultManager for ergonomic repeated timelock operations.
 *
 * Creates a single PhalnxClient and reuses it across calls, avoiding
 * per-call client construction overhead.
 *
 * @example
 * ```typescript
 * const result = await withVault(teeWallet, policies, options);
 * const manager = createVaultManager(result, ownerWallet, connection);
 *
 * await manager.queuePolicyUpdate({ dailySpendingCapUsd: 1000_000_000 });
 * // ... wait for timelock ...
 * await manager.applyPendingPolicy();
 * ```
 */
export function createVaultManager(
  result: HardenResult,
  ownerWallet: WalletLike,
  connection: Connection,
): VaultManager {
  const ctx = timelockContextFromResult(result, ownerWallet, connection);
  const client = createOwnerClient(ctx);
  const readProgram = createReadProgram(connection, ctx.programId);

  return {
    vaultAddress: result.vaultAddress,

    async queuePolicyUpdate(params: TimelockPolicyParams): Promise<string> {
      return client.queuePolicyUpdate(
        result.vaultAddress,
        toQueueParams(params),
      );
    },

    async applyPendingPolicy(): Promise<string> {
      return client.applyPendingPolicy(result.vaultAddress);
    },

    async cancelPendingPolicy(): Promise<string> {
      return client.cancelPendingPolicy(result.vaultAddress);
    },

    async fetchPendingPolicy(): Promise<PendingPolicyUpdateAccount | null> {
      return fetchPendingPolicy(readProgram, result.vaultAddress);
    },
  };
}
