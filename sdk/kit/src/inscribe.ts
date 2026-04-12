/**
 * Kit-native inscribe() + withVault() — Vault Provisioning
 *
 * inscribe(): Creates on-chain vault + registers agent
 * withVault(): Convenience — shield + inscribe in one call
 *
 * Uses Codama-generated instruction builders directly.
 * No Anchor, no web3.js.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";

import type { ResolvedPolicies } from "./policies.js";
import { shield, type ShieldedContext, type ShieldOptions } from "./shield.js";
import type { ShieldPolicies } from "./policies.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getPendingPolicyPDA,
} from "./resolve-accounts.js";
import { findVaultsByOwner } from "./state-resolver.js";
import { fetchMaybeAgentVault } from "./generated/accounts/agentVault.js";
import { SIGIL_PROGRAM_ADDRESS } from "./generated/programs/sigil.js";
import { validateNetwork, type Network } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for inscribing a wallet to on-chain enforcement. */
export interface InscribeOptions {
  /** Solana RPC connection */
  rpc: Rpc<SolanaRpcApi>;
  /** Network for token resolution */
  network: Network;
  /** Owner signer — vault administrator */
  owner: TransactionSigner;
  /** Agent signer to register in the vault */
  agent: TransactionSigner;
  /** Agent capability bitmask. Default: FULL_CAPABILITY */
  permissions?: bigint;
  /** Agent spending limit in USD (6 decimals). Default: 500_000_000 ($500) */
  spendingLimitUsd?: bigint;
  /** Vault ID (auto-detected if not provided) */
  vaultId?: bigint;
  /** Fee destination for the vault */
  feeDestination?: Address;
  /** Developer fee rate (0-500). Default: 0 */
  developerFeeRate?: number;
  /** Maximum leverage in basis points. Default: 0 */
  maxLeverageBps?: number;
  /** Maximum concurrent positions. Default: 5 */
  maxConcurrentPositions?: number;
  /** Maximum slippage in BPS for swap verification. Default: 100 (1%) */
  maxSlippageBps?: number;
  /** Timelock duration in seconds. 0 = disabled (default) */
  timelockDuration?: number;
  /** Allowed destination addresses for agent transfers */
  allowedDestinations?: Address[];
  /** Skip TEE wallet requirement — devnet testing only. Default: false */
  unsafeSkipTeeCheck?: boolean;
}

/** Result of inscribing a wallet. */
export interface InscribeResult {
  /** Vault PDA address */
  vaultAddress: Address;
  /** Vault ID used */
  vaultId: bigint;
  /** Policy PDA address */
  policyAddress: Address;
  /** Pending policy PDA address */
  pendingPolicyAddress: Address;
  /** Agent address registered */
  agentAddress: Address;
  /** Owner address */
  ownerAddress: Address;
}

/** Configuration for withVault() convenience wrapper. */
export interface WithVaultOptions {
  /** On-chain vault provisioning configuration. */
  inscribe: InscribeOptions;
  /** Shield policies (client-side enforcement). */
  policies?: ShieldPolicies;
  /** Shield event callbacks. */
  shieldCallbacks?: ShieldOptions;
}

/** Result of withVault(). */
export interface WithVaultResult {
  /** Client-side shield context */
  shield: ShieldedContext;
  /** On-chain vault info */
  inscribe: InscribeResult;
}

// ─── Policy Mapping ─────────────────────────────────────────────────────────

/**
 * Map resolved client-side policies to on-chain vault init parameters.
 *
 * Multiple per-token SpendLimits collapse to the largest value as the
 * on-chain dailySpendingCap (conservative ceiling). Per-token granularity
 * is enforced client-side only.
 */
export function mapPoliciesToVaultParams(
  resolved: ResolvedPolicies,
  vaultId: bigint,
  feeDestination: Address,
  opts?: {
    developerFeeRate?: number;
    maxLeverageBps?: number;
    maxConcurrentPositions?: number;
    timelockDuration?: number;
    allowedDestinations?: Address[];
    maxSlippageBps?: number;
  },
): {
  vaultId: bigint;
  dailySpendingCap: bigint;
  maxTransactionSize: bigint;
  protocolMode: number;
  protocols: Address[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
  feeDestination: Address;
  developerFeeRate: number;
  timelockDuration: number;
  allowedDestinations: Address[];
  maxSlippageBps: number;
} {
  // Collapse multiple spend limits to the largest (ceiling cap)
  let maxCap = 0n;
  for (const limit of resolved.spendLimits) {
    if (limit.amount > maxCap) {
      maxCap = limit.amount;
    }
  }

  // Allowed protocols (Set<string>), cap at 10
  const protocolArr = resolved.allowedProtocols
    ? Array.from(resolved.allowedProtocols)
    : [];
  const protocols = protocolArr.slice(0, 10) as Address[];

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
    timelockDuration: opts?.timelockDuration ?? 0,
    allowedDestinations: opts?.allowedDestinations ?? [],
    maxSlippageBps: opts?.maxSlippageBps ?? 100,
  };
}

// ─── Vault ID Probing ───────────────────────────────────────────────────────

/**
 * Probe vault PDAs starting from 0 to find the next available vault ID.
 * Returns 0n for a new owner, or the first unused ID.
 */
export async function findNextVaultId(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<bigint> {
  // Fast path: sequential probe for first 5 slots (common case)
  for (let i = 0n; i < 5n; i++) {
    const [vaultPda] = await getVaultPDA(owner, i, programAddress);
    const account = await fetchMaybeAgentVault(rpc, vaultPda);
    if (!account.exists) {
      return i;
    }
  }

  // Slow path: owner has 5+ vaults — batch-discover via GPA and find max ID
  const vaults = await findVaultsByOwner(rpc, owner, 100);
  if (vaults.length === 0) return 0n;

  let maxId = 0n;
  for (const v of vaults) {
    if (v.vaultId > maxId) maxId = v.vaultId;
  }
  const nextId = maxId + 1n;
  if (nextId >= 256n) {
    throw new Error("All 256 vault slots are in use for this owner.");
  }
  return nextId;
}

// ─── Inscribe ─────────────────────────────────────────────────────────────────

/**
 * Create an on-chain vault and register an agent.
 *
 * This provisions the on-chain enforcement layer:
 * 1. Derives vault PDA (auto-probes next ID if not specified)
 * 2. Returns vault info (does NOT send transactions — caller composes)
 *
 * The actual transaction building and sending is the caller's responsibility
 * using the Codama-generated instruction builders:
 * - getInitializeVaultInstructionAsync()
 * - getRegisterAgentInstructionAsync()
 * - getUpdatePolicyInstructionAsync()
 */
export async function inscribe(
  options: InscribeOptions,
): Promise<InscribeResult> {
  const { rpc, network, owner, agent } = options;
  validateNetwork(network);

  // Validate owner ≠ agent
  if (owner.address === agent.address) {
    throw new Error(
      "Owner and agent must be different keys. " +
        "The owner has full vault authority; the agent has constrained execution only.",
    );
  }

  // Resolve vault ID
  const vaultId =
    options.vaultId ?? (await findNextVaultId(rpc, owner.address));

  // Derive PDAs
  const [vaultAddress] = await getVaultPDA(owner.address, vaultId);
  const [policyAddress] = await getPolicyPDA(vaultAddress);
  const [pendingPolicyAddress] = await getPendingPolicyPDA(vaultAddress);

  return {
    vaultAddress,
    vaultId,
    policyAddress,
    pendingPolicyAddress,
    agentAddress: agent.address,
    ownerAddress: owner.address,
  };
}

// ─── withVault ──────────────────────────────────────────────────────────────

/**
 * Convenience: shield + inscribe in one call.
 *
 * Creates both client-side (shield) and on-chain (vault) enforcement.
 * Auto-configures shield's on-chain sync using the derived vault address.
 * This is the primary entry point for the single-product model.
 */
export async function withVault(
  options: WithVaultOptions,
): Promise<WithVaultResult> {
  // Provision on-chain vault first (derives vault address)
  const inscribeResult = await inscribe(options.inscribe);

  // Auto-configure shield's on-chain sync using the derived vault address
  const shieldOpts: ShieldOptions = {
    ...options.shieldCallbacks,
    onChainSync: {
      rpc: options.inscribe.rpc,
      vaultAddress: inscribeResult.vaultAddress,
      agentAddress: options.inscribe.agent.address,
      network: options.inscribe.network,
    },
  };

  const shieldCtx = shield(options.policies, shieldOpts);

  return {
    shield: shieldCtx,
    inscribe: inscribeResult,
  };
}
