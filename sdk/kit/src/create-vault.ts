/**
 * createVault() — Provision an on-chain Sigil vault.
 *
 * Returns instructions (not a signed transaction) so the caller controls
 * transaction composition, signing, and sending.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";

import { getInitializeVaultInstructionAsync } from "./generated/instructions/initializeVault.js";
import { getRegisterAgentInstruction } from "./generated/instructions/registerAgent.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getAgentOverlayPDA,
} from "./resolve-accounts.js";
import { findNextVaultId } from "./inscribe.js";
import { FULL_PERMISSIONS, toInstruction } from "./types.js";
import { buildOwnerTransaction } from "./owner-transaction.js";
import { signAndEncode, sendAndConfirmTransaction } from "./rpc-helpers.js";
import type { SendAndConfirmOptions } from "./rpc-helpers.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateVaultOptions {
  rpc: Rpc<SolanaRpcApi>;
  network: "devnet" | "mainnet";
  owner: TransactionSigner;
  agent: TransactionSigner;
  permissions?: bigint;
  spendingLimitUsd?: bigint;
  dailySpendingCapUsd?: bigint;
  maxTransactionSizeUsd?: bigint;
  feeDestination?: Address;
  developerFeeRate?: number;
  protocols?: Address[];
  protocolMode?: number;
  maxLeverageBps?: number;
  maxConcurrentPositions?: number;
  maxSlippageBps?: number;
  timelockDuration?: number;
  allowedDestinations?: Address[];
  vaultId?: bigint;
}

export interface CreateVaultResult {
  vaultAddress: Address;
  vaultId: bigint;
  policyAddress: Address;
  agentOverlayAddress: Address;
  initializeVaultIx: Instruction;
  registerAgentIx: Instruction;
}

// ─── createVault() ──────────────────────────────────────────────────────────

export async function createVault(
  options: CreateVaultOptions,
): Promise<CreateVaultResult> {
  // Validate owner ≠ agent
  if (options.owner.address === options.agent.address) {
    throw new Error(
      "Owner and agent must be different keys. " +
        "The owner has full vault authority; the agent has constrained execution only.",
    );
  }

  // Step 1: Resolve vault ID
  const vaultId =
    options.vaultId ??
    (await findNextVaultId(options.rpc, options.owner.address));

  // Step 2: Derive PDAs
  const [vaultAddress] = await getVaultPDA(options.owner.address, vaultId);
  const [policyAddress] = await getPolicyPDA(vaultAddress);
  const [agentOverlayAddress] = await getAgentOverlayPDA(vaultAddress, 0);

  // Step 3: Defaults
  const dailySpendingCapUsd = options.dailySpendingCapUsd ?? 500_000_000n;
  const maxTransactionSizeUsd =
    options.maxTransactionSizeUsd ?? dailySpendingCapUsd;
  const feeDestination = options.feeDestination ?? options.owner.address;
  const protocols = options.protocols ?? [];
  const protocolMode = options.protocolMode ?? 0;

  // Step 4: Build initializeVault instruction
  const initializeVaultIx = await getInitializeVaultInstructionAsync({
    owner: options.owner,
    agentSpendOverlay: agentOverlayAddress,
    feeDestination,
    vaultId,
    dailySpendingCapUsd,
    maxTransactionSizeUsd,
    protocolMode,
    protocols,
    maxLeverageBps: options.maxLeverageBps ?? 0,
    maxConcurrentPositions: options.maxConcurrentPositions ?? 5,
    developerFeeRate: options.developerFeeRate ?? 0,
    maxSlippageBps: options.maxSlippageBps ?? 100,
    timelockDuration: options.timelockDuration ?? 0,
    allowedDestinations: options.allowedDestinations ?? [],
    protocolCaps: protocols.map(() => 0n),
  });

  // Step 5: Build registerAgent instruction
  const registerAgentIx = getRegisterAgentInstruction({
    owner: options.owner,
    vault: vaultAddress,
    agentSpendOverlay: agentOverlayAddress,
    agent: options.agent.address,
    capability: Number(options.permissions ?? FULL_PERMISSIONS),
    spendingLimitUsd: options.spendingLimitUsd ?? 0n,
  });

  return {
    vaultAddress,
    vaultId,
    policyAddress,
    agentOverlayAddress,
    initializeVaultIx: toInstruction(initializeVaultIx),
    registerAgentIx: toInstruction(registerAgentIx),
  };
}

// ─── createAndSendVault() ────────────────────────────────────────────────────

export interface CreateAndSendVaultOptions extends CreateVaultOptions {
  /** Priority fee in microLamports per CU. Default: 0. */
  priorityFeeMicroLamports?: number;
  /** Override compute units. Default: CU_OWNER_ACTION (200,000). */
  computeUnits?: number;
  /** Confirmation options (timeout, poll interval, commitment). */
  confirmOptions?: SendAndConfirmOptions;
}

export interface CreateAndSendVaultResult extends CreateVaultResult {
  /** Confirmed transaction signature. */
  signature: string;
}

/**
 * One-call vault creation: build instructions, compose transaction, sign, send, and confirm.
 *
 * Equivalent to calling createVault() → buildOwnerTransaction() → signAndEncode()
 * → sendAndConfirmTransaction() manually.
 */
export async function createAndSendVault(
  options: CreateAndSendVaultOptions,
): Promise<CreateAndSendVaultResult> {
  const result = await createVault(options);

  const ownerTx = await buildOwnerTransaction({
    rpc: options.rpc,
    owner: options.owner,
    instructions: [result.initializeVaultIx, result.registerAgentIx],
    network: options.network,
    computeUnits: options.computeUnits,
    priorityFeeMicroLamports: options.priorityFeeMicroLamports,
  });

  const encoded = await signAndEncode(options.owner, ownerTx.transaction);
  const signature = await sendAndConfirmTransaction(
    options.rpc,
    encoded,
    options.confirmOptions,
  );

  return { ...result, signature };
}
