/**
 * @usesigil/kit/dashboard — Mutation functions for OwnerClient.
 *
 * Every mutation: build instruction → buildOwnerTransaction → signAndEncode → sendAndConfirmTransaction.
 * Stateless — no caching, no optimistic updates (v0.2).
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "../kit-adapter.js";
import { getProgramDerivedAddress, getAddressEncoder } from "../kit-adapter.js";
import { getSigilModuleLogger } from "../logger.js";
import type { CapabilityTier, UsdBaseUnits } from "../types.js";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type Instruction as KitInstruction,
} from "../kit-adapter.js";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  sendAndConfirmTransaction,
  getBlockhashCache,
} from "../rpc-helpers.js";
import { AccountRole } from "../kit-adapter.js";
import {
  getAgentOverlayPDA,
  getPendingPolicyPDA,
  getPendingCloseConstraintsPDA,
} from "../resolve-accounts.js";
import { resolveVaultStateForOwner } from "../state-resolver.js";
import { redactCause } from "../network-errors.js";
import { SIGIL_PROGRAM_ADDRESS, MAX_ALLOWED_PROTOCOLS } from "../types.js";
import type { Network } from "../types.js";
import type { AgentVault } from "../generated/accounts/agentVault.js";

// Phase 3: Simple mutations
import { getFreezeVaultInstruction } from "../generated/instructions/freezeVault.js";
import { getReactivateVaultInstruction } from "../generated/instructions/reactivateVault.js";
import { getCloseVaultInstructionAsync } from "../generated/instructions/closeVault.js";
import { getSyncPositionsInstruction } from "../generated/instructions/syncPositions.js";
import { getPauseAgentInstruction } from "../generated/instructions/pauseAgent.js";
import { getUnpauseAgentInstruction } from "../generated/instructions/unpauseAgent.js";
import { getRevokeAgentInstruction } from "../generated/instructions/revokeAgent.js";
import { getRegisterAgentInstruction } from "../generated/instructions/registerAgent.js";

// Phase 4: Complex mutations
import { getDepositFundsInstructionAsync } from "../generated/instructions/depositFunds.js";
import { getWithdrawFundsInstructionAsync } from "../generated/instructions/withdrawFunds.js";
import { getQueuePolicyUpdateInstructionAsync } from "../generated/instructions/queuePolicyUpdate.js";
import { getApplyPendingPolicyInstructionAsync } from "../generated/instructions/applyPendingPolicy.js";
import { getCancelPendingPolicyInstructionAsync } from "../generated/instructions/cancelPendingPolicy.js";
import { getQueueAgentPermissionsUpdateInstructionAsync } from "../generated/instructions/queueAgentPermissionsUpdate.js";
import { getApplyAgentPermissionsUpdateInstructionAsync } from "../generated/instructions/applyAgentPermissionsUpdate.js";
import { getCancelAgentPermissionsUpdateInstruction } from "../generated/instructions/cancelAgentPermissionsUpdate.js";
import { getCreateInstructionConstraintsInstructionAsync } from "../generated/instructions/createInstructionConstraints.js";
import { getQueueConstraintsUpdateInstructionAsync } from "../generated/instructions/queueConstraintsUpdate.js";
import { getApplyConstraintsUpdateInstructionAsync } from "../generated/instructions/applyConstraintsUpdate.js";
import { getCancelConstraintsUpdateInstructionAsync } from "../generated/instructions/cancelConstraintsUpdate.js";
import { getQueueCloseConstraintsInstructionAsync } from "../generated/instructions/queueCloseConstraints.js";
import { getApplyCloseConstraintsInstructionAsync } from "../generated/instructions/applyCloseConstraints.js";
import { getCancelCloseConstraintsInstructionAsync } from "../generated/instructions/cancelCloseConstraints.js";

import type {
  TxResult,
  TxOpts,
  PolicyChanges,
  ConstraintEntry,
} from "./types.js";
import { toDxError } from "./errors.js";

// ─── Shared Helper ───────────────────────────────────────────────────────────

const CU_OWNER_ACTION = 200_000;

async function run(
  rpc: Rpc<SolanaRpcApi>,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  instructions: Instruction[],
  opts: TxOpts = {},
): Promise<TxResult> {
  try {
    const cu = opts.computeUnits ?? CU_OWNER_ACTION;
    const allIx: KitInstruction[] = [
      getSetComputeUnitLimitInstruction({
        units: cu,
      }) as unknown as KitInstruction,
      ...(opts.priorityFeeMicroLamports
        ? [
            getSetComputeUnitPriceInstruction({
              microLamports: BigInt(opts.priorityFeeMicroLamports),
            }) as unknown as KitInstruction,
          ]
        : []),
      ...(instructions as unknown as KitInstruction[]),
    ];

    const cache = getBlockhashCache(rpc);
    const blockhash = await cache.get(rpc);
    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(owner.address, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, tx),
      (tx) => appendTransactionMessageInstructions(allIx, tx),
    );

    const txWithSigners = addSignersToTransactionMessage(
      [owner],
      txMessage as any,
    );
    const signedTx = await signTransactionMessageWithSigners(
      txWithSigners as any,
    );
    const wire = getBase64EncodedWireTransaction(signedTx as any);
    const signature = await sendAndConfirmTransaction(rpc, wire);

    return { signature, toJSON: () => ({ signature }) };
  } catch (err: unknown) {
    throw toDxError(err);
  }
}

// toDxError is now in ./errors.ts (shared with reads.ts)

// ─── Client-Side Validation ──────────────────────────────────────────────────
// Fail fast with clear errors instead of burning RPC round-trips.

const U64_MAX = (1n << 64n) - 1n;

function requirePositiveAmount(amount: bigint, field: string): void {
  if (amount <= 0n)
    throw toDxError(new Error(`${field} must be positive, got ${amount}`));
  if (amount > U64_MAX)
    throw toDxError(new Error(`${field} exceeds u64 maximum (${U64_MAX})`));
}

function requireValidAddress(addr: string, field: string): void {
  if (!addr || addr.length < 32 || addr.length > 44)
    throw toDxError(
      new Error(
        `${field} is not a valid Solana address (got ${addr?.length ?? 0} chars)`,
      ),
    );
}

const MAX_CAPABILITY = 2; // 0=Disabled, 1=Observer, 2=Operator

function requireValidPermissions(perms: bigint): void {
  if (perms < 0n) throw toDxError(new Error(`Capability cannot be negative`));
  if (perms === 0n)
    throw toDxError(
      new Error(
        `Capability is 0 (Disabled) — agent would have no permissions. Use 1 (Observer) or 2 (Operator).`,
      ),
    );
  if (perms > BigInt(MAX_CAPABILITY))
    throw toDxError(
      new Error(
        `Capability exceeds maximum (${MAX_CAPABILITY}). Valid values: 0=Disabled, 1=Observer, 2=Operator.`,
      ),
    );
}

function requireU8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw toDxError(
      new Error(`${field} must be an integer 0-255, got ${value}`),
    );
  }
}

function mapProtocolMode(mode: string): number {
  const map: Record<string, number> = {
    unrestricted: 0,
    whitelist: 1,
    blacklist: 2,
  };
  if (!(mode in map))
    throw toDxError(
      new Error(
        `Invalid protocolMode: "${mode}". Must be "unrestricted", "whitelist", or "blacklist".`,
      ),
    );
  return map[mode];
}

/** Derive pendingAgentPerms PDA: seeds = ["pending_agent_perms", vault, agent] */
async function derivePendingAgentPermsPDA(
  vault: Address,
  agent: Address,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: SIGIL_PROGRAM_ADDRESS,
    seeds: [
      new TextEncoder().encode("pending_agent_perms"),
      encoder.encode(vault),
      encoder.encode(agent),
    ],
  });
  return pda;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Simple mutations
// ═══════════════════════════════════════════════════════════════════════════════

export async function freezeVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = getFreezeVaultInstruction({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function resumeVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  newAgent?: { address: Address; permissions: CapabilityTier },
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = getReactivateVaultInstruction({
    owner,
    vault,
    newAgent: newAgent?.address ?? null,
    newAgentCapability: newAgent ? Number(newAgent.permissions) : null,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Permanently closes vault and reclaims rent.
 *
 * TOCTOU note: vault state is read before TX is built. If pending PDAs are
 * created/destroyed between the read and TX execution, the on-chain program
 * will reject the TX. This is a known race window — retry on failure.
 */
export async function closeVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const net: Network = network === "mainnet" ? "mainnet-beta" : "devnet";

  // Resolve vault state to determine which remaining_accounts are needed
  const state = await resolveVaultStateForOwner(rpc, vault, undefined, net);
  const policy = state.policy as any;
  const vaultData = state.vault as AgentVault;

  const [overlayPda] = await getAgentOverlayPDA(vault, 0);
  const ix = await getCloseVaultInstructionAsync({
    owner,
    vault,
    agentSpendOverlay: overlayPda,
  });

  // Build remaining_accounts for pending PDA cleanup (close_vault.rs:68-142)
  // All accounts verified via getAccountInfo before inclusion — no blind trust.
  const remainingAccounts: { address: Address; role: AccountRole }[] = [];

  // Derive all PDAs that MIGHT exist, then check them in parallel
  const [pendingPolicyPda] = await getPendingPolicyPDA(vault);

  const agents = vaultData.agents || [];
  const agentPdaDerivations = await Promise.all(
    agents.map((agent) => derivePendingAgentPermsPDA(vault, agent.pubkey)),
  );

  const [pendingCloseConstraintsPda] =
    await getPendingCloseConstraintsPDA(vault);

  // Check all PDAs in parallel (E4 fix — batch instead of sequential)
  const allPdas = [
    pendingPolicyPda,
    ...agentPdaDerivations,
    pendingCloseConstraintsPda,
  ];

  const existenceChecks = await Promise.all(
    allPdas.map(async (pda) => {
      try {
        const info = await rpc
          .getAccountInfo(pda, { encoding: "base64" })
          .send();
        return info?.value ? pda : null;
      } catch (err: unknown) {
        // RPC failure is NOT the same as "account absent" — logging it
        // here makes a transient outage observable rather than silently
        // omitting the PDA from remaining_accounts, which would surface
        // downstream as an opaque "AccountMissing" from close_vault.
        const cause = redactCause(err);
        getSigilModuleLogger().warn(
          `[close_vault] existence check failed for ${pda} — treating as absent: ${cause.message ?? cause.name ?? cause.code ?? "unknown"}`,
        );
        return null;
      }
    }),
  );

  // Add existing PDAs as remaining_accounts in order:
  // 1. pending_policy (if exists) — must be first per close_vault.rs:95-98
  if (existenceChecks[0]) {
    remainingAccounts.push({
      address: existenceChecks[0],
      role: AccountRole.WRITABLE,
    });
  }
  // 2. pending_agent_perms (one per agent that has a pending update)
  for (let i = 0; i < agents.length; i++) {
    if (existenceChecks[1 + i]) {
      remainingAccounts.push({
        address: existenceChecks[1 + i]!,
        role: AccountRole.WRITABLE,
      });
    }
  }
  // 3. pending_close_constraints (if exists) — E1 fix: correct seed "pending_close_constraints"
  const constraintsIdx = 1 + agents.length;
  if (existenceChecks[constraintsIdx]) {
    remainingAccounts.push({
      address: existenceChecks[constraintsIdx]!,
      role: AccountRole.WRITABLE,
    });
  }

  // Append remaining accounts to instruction if any exist
  const finalIx =
    remainingAccounts.length > 0
      ? {
          ...ix,
          accounts: [
            ...(ix as any).accounts,
            ...remainingAccounts.map((a) => ({
              address: a.address,
              role: a.role,
            })),
          ],
        }
      : ix;

  return run(rpc, owner, network, [finalIx], {
    computeUnits: opts?.computeUnits ?? 400_000,
    priorityFeeMicroLamports: opts?.priorityFeeMicroLamports,
  });
}

export async function syncPositions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  actualPositions: number,
  opts?: TxOpts,
): Promise<TxResult> {
  requireU8(actualPositions, "actualPositions");
  const ix = getSyncPositionsInstruction({ owner, vault, actualPositions });
  return run(rpc, owner, network, [ix], opts);
}

export async function pauseAgent(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  const ix = getPauseAgentInstruction({ owner, vault, agentToPause: agent });
  return run(rpc, owner, network, [ix], opts);
}

export async function unpauseAgent(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  const ix = getUnpauseAgentInstruction({
    owner,
    vault,
    agentToUnpause: agent,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function revokeAgent(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  const [overlayPda] = await getAgentOverlayPDA(vault, 0);
  const ix = getRevokeAgentInstruction({
    owner,
    vault,
    agentSpendOverlay: overlayPda,
    agentToRemove: agent,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function addAgent(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  permissions: CapabilityTier,
  spendingLimit: UsdBaseUnits,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  requireValidPermissions(permissions);
  const [overlayPda] = await getAgentOverlayPDA(vault, 0);
  const ix = getRegisterAgentInstruction({
    owner,
    vault,
    agentSpendOverlay: overlayPda,
    agent,
    capability: Number(permissions),
    spendingLimitUsd: spendingLimit,
  });
  return run(rpc, owner, network, [ix], opts);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Complex mutations
// ═══════════════════════════════════════════════════════════════════════════════

export async function deposit(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  mint: Address,
  amount: bigint,
  opts?: TxOpts,
): Promise<TxResult> {
  requirePositiveAmount(amount, "Deposit amount");
  requireValidAddress(mint, "Token mint");
  const ix = await getDepositFundsInstructionAsync({
    owner,
    vault,
    mint,
    amount,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function withdraw(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  mint: Address,
  amount: bigint,
  opts?: TxOpts,
): Promise<TxResult> {
  requirePositiveAmount(amount, "Withdraw amount");
  requireValidAddress(mint, "Token mint");
  const ix = await getWithdrawFundsInstructionAsync({
    owner,
    vault,
    mint,
    amount,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Queue a policy update. Client-side pre-validation catches the most common
 * mistakes before an RPC round-trip, but is not exhaustive — on-chain remains
 * the source of truth for all rejections.
 *
 * Client-validated (throws before sending):
 *   - `timelock` >= 1800s (30 min)
 *   - `dailyCap`, `maxPerTrade` > 0n
 *   - `developerFeeRate` <= 500 BPS
 *   - `approvedApps.length` <= MAX_ALLOWED_PROTOCOLS
 *   - `maxConcurrentPositions` within u8 (0-255) via requireU8
 *
 * On-chain-only (silent pass through SDK, may fail on-chain):
 *   - `allowedDestinations.length` (MAX_ALLOWED_DESTINATIONS on-chain)
 *   - `protocolCaps.length` must equal `approvedApps.length` when has_protocol_caps
 *   - `maxSlippageBps` <= MAX_SLIPPAGE_BPS on-chain
 *   - `sessionExpirySlots` range (10..=450 when > 0)
 */
export async function queuePolicyUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  changes: PolicyChanges,
  opts?: TxOpts,
): Promise<TxResult> {
  if (Object.keys(changes).length === 0) {
    throw toDxError(new Error("At least one policy change is required"));
  }
  if (changes.timelock != null && changes.timelock < 1800) {
    throw toDxError(
      new Error(
        `Timelock must be >= 1800 seconds (30 minutes). Got ${changes.timelock}. On-chain rejects TimelockTooShort.`,
      ),
    );
  }
  if (changes.dailyCap != null)
    requirePositiveAmount(changes.dailyCap, "Daily cap");
  if (changes.maxPerTrade != null)
    requirePositiveAmount(changes.maxPerTrade, "Max per trade");
  if (changes.developerFeeRate != null && changes.developerFeeRate > 500) {
    throw toDxError(
      new Error(
        `Developer fee rate cannot exceed 500 BPS (0.05%). Got ${changes.developerFeeRate}.`,
      ),
    );
  }
  if (
    changes.approvedApps &&
    changes.approvedApps.length > MAX_ALLOWED_PROTOCOLS
  ) {
    throw toDxError(
      new Error(
        `approvedApps length exceeds on-chain MAX_ALLOWED_PROTOCOLS (${MAX_ALLOWED_PROTOCOLS}). Got ${changes.approvedApps.length}. On-chain rejects TooManyAllowedProtocols.`,
      ),
    );
  }
  if (changes.maxConcurrentPositions != null) {
    requireU8(changes.maxConcurrentPositions, "maxConcurrentPositions");
  }
  const ix = await getQueuePolicyUpdateInstructionAsync({
    owner,
    vault,
    dailySpendingCapUsd: changes.dailyCap ?? null,
    maxTransactionAmountUsd: changes.maxPerTrade ?? null,
    protocolMode: changes.protocolMode
      ? mapProtocolMode(changes.protocolMode)
      : null,
    protocols: changes.approvedApps ?? null,
    maxLeverageBps: changes.leverageLimit ?? null,
    canOpenPositions: changes.canOpenPositions ?? null,
    maxConcurrentPositions: changes.maxConcurrentPositions ?? null,
    developerFeeRate: changes.developerFeeRate ?? null,
    maxSlippageBps: changes.maxSlippageBps ?? null,
    timelockDuration:
      changes.timelock != null ? BigInt(changes.timelock) : null,
    allowedDestinations: changes.allowedDestinations ?? null,
    sessionExpirySlots: changes.sessionExpirySlots ?? null,
    hasProtocolCaps: changes.hasProtocolCaps ?? null,
    protocolCaps: changes.protocolCaps ?? null,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function applyPendingPolicy(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getApplyPendingPolicyInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function cancelPendingPolicy(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getCancelPendingPolicyInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function queueAgentPermissions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  permissions: CapabilityTier,
  spendingLimit: UsdBaseUnits,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  requireValidPermissions(permissions);
  const ix = await getQueueAgentPermissionsUpdateInstructionAsync({
    owner,
    vault,
    agent,
    newCapability: Number(permissions),
    spendingLimitUsd: spendingLimit,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function applyAgentPermissions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  const [overlayPda] = await getAgentOverlayPDA(vault, 0);
  const pendingPda = await derivePendingAgentPermsPDA(vault, agent);
  const ix = await getApplyAgentPermissionsUpdateInstructionAsync({
    owner,
    vault,
    agentSpendOverlay: overlayPda,
    pendingAgentPerms: pendingPda,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function cancelAgentPermissions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  const pendingPda = await derivePendingAgentPermsPDA(vault, agent);
  const ix = getCancelAgentPermissionsUpdateInstruction({
    owner,
    vault,
    pendingAgentPerms: pendingPda,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function createConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  entries: ConstraintEntry[],
  opts?: TxOpts,
): Promise<TxResult> {
  if (!entries || entries.length === 0)
    throw toDxError(new Error("Constraint entries must be a non-empty array"));
  const ix = await getCreateInstructionConstraintsInstructionAsync({
    owner,
    vault,
    entries,
    strictMode: opts?.strictMode ?? true,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function queueConstraintsUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  entries: ConstraintEntry[],
  opts?: TxOpts,
): Promise<TxResult> {
  if (!entries || entries.length === 0)
    throw toDxError(new Error("Constraint entries must be a non-empty array"));
  const ix = await getQueueConstraintsUpdateInstructionAsync({
    owner,
    vault,
    entries,
    strictMode: opts?.strictMode ?? true,
  });
  return run(rpc, owner, network, [ix], opts);
}

export async function applyConstraintsUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getApplyConstraintsUpdateInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function cancelConstraintsUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getCancelConstraintsUpdateInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function queueCloseConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getQueueCloseConstraintsInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function applyCloseConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getApplyCloseConstraintsInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}

export async function cancelCloseConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getCancelCloseConstraintsInstructionAsync({ owner, vault });
  return run(rpc, owner, network, [ix], opts);
}
