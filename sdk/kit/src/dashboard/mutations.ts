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
  partiallySignTransactionMessageWithSigners,
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
  getPolicyPDA,
} from "../resolve-accounts.js";
import { resolveVaultStateForOwner } from "../state-resolver.js";
import { redactCause } from "../network-errors.js";
import { SIGIL_PROGRAM_ADDRESS, MAX_ALLOWED_PROTOCOLS } from "../types.js";
import type { Network } from "../types.js";
import type { AgentVault } from "../generated/accounts/agentVault.js";
import { fetchAgentVault } from "../generated/accounts/agentVault.js";
import { fetchPolicyConfig } from "../generated/accounts/policyConfig.js";
import {
  computePolicyPreviewDigest,
  computeAgentSetHash,
} from "../policy/compute-policy-preview-digest.js";
import { computeAgentPermsCosignDigest } from "../policy/compute-agent-perms-cosign-digest.js";
import { computeCosignDigest } from "../policy/compute-cosign-digest.js";

// Phase 3: Simple mutations
import { getFreezeVaultInstructionAsync } from "../generated/instructions/freezeVault.js";
import { getReactivateVaultInstructionAsync } from "../generated/instructions/reactivateVault.js";
import { getSetObserveOnlyInstructionAsync } from "../generated/instructions/setObserveOnly.js";
import { getQueueAgentGrantInstructionAsync } from "../generated/instructions/queueAgentGrant.js";
import { getApplyAgentGrantInstructionAsync } from "../generated/instructions/applyAgentGrant.js";
import { getCancelAgentGrantInstructionAsync } from "../generated/instructions/cancelAgentGrant.js";
import { getCloseVaultInstructionAsync } from "../generated/instructions/closeVault.js";
import { enumerateExistingPendingPdasForClose } from "./close-vault.js";
import { getPauseAgentInstructionAsync } from "../generated/instructions/pauseAgent.js";
import { getUnpauseAgentInstructionAsync } from "../generated/instructions/unpauseAgent.js";
import { getRevokeAgentInstructionAsync } from "../generated/instructions/revokeAgent.js";
import { getRegisterAgentInstructionAsync } from "../generated/instructions/registerAgent.js";

// Phase 4: Complex mutations
import { getDepositFundsInstructionAsync } from "../generated/instructions/depositFunds.js";
import { getWithdrawFundsInstructionAsync } from "../generated/instructions/withdrawFunds.js";
import { getQueuePolicyUpdateInstructionAsync } from "../generated/instructions/queuePolicyUpdate.js";
import { getApplyPendingPolicyInstructionAsync } from "../generated/instructions/applyPendingPolicy.js";
import { getCancelPendingPolicyInstructionAsync } from "../generated/instructions/cancelPendingPolicy.js";
import { getQueueAgentPermissionsUpdateInstructionAsync } from "../generated/instructions/queueAgentPermissionsUpdate.js";
import { getApplyAgentPermissionsUpdateInstructionAsync } from "../generated/instructions/applyAgentPermissionsUpdate.js";
import { getCancelAgentPermissionsUpdateInstruction } from "../generated/instructions/cancelAgentPermissionsUpdate.js";
import { getCreatePostAssertionsInstructionAsync } from "../generated/instructions/createPostAssertions.js";
import { getClosePostAssertionsInstructionAsync } from "../generated/instructions/closePostAssertions.js";

// M-2 (pre-redeploy audit 2026-05-21): Phase 8 ownership-transfer ix builders.
// The on-chain handlers live at programs/sigil/src/instructions/
// {initiate,accept,cancel}_ownership_transfer.rs plus the Squads V4
// accept-multisig variant.
import { getInitiateOwnershipTransferInstructionAsync } from "../generated/instructions/initiateOwnershipTransfer.js";
import { getAcceptOwnershipTransferInstructionAsync } from "../generated/instructions/acceptOwnershipTransfer.js";
import { getAcceptOwnershipTransferMultisigInstructionAsync } from "../generated/instructions/acceptOwnershipTransferMultisig.js";
import { getCancelOwnershipTransferInstructionAsync } from "../generated/instructions/cancelOwnershipTransfer.js";
import type { PostAssertionEntry } from "../generated/types/postAssertionEntry.js";
import { validatePostAssertionEntries } from "./post-assertion-validation.js";

import type { TxResult, TxOpts, PolicyChanges } from "./types.js";
import { toDxError } from "./errors.js";
import { SigilSdkDomainError } from "../errors/sdk.js";
import { SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED } from "../errors/codes.js";

// ─── Shared Helper ───────────────────────────────────────────────────────────

const CU_OWNER_ACTION = 200_000;

/**
 * CH-3 (Security audit 2026-05-23 / Jordan): AL2 mainnet confirmation gate
 * embedded inside the mutation builder so direct `mutations.*` imports
 * cannot bypass it. The OwnerClient wrapper layer has its own gate
 * (`OwnerClient.assertMainnetConfirmed`) which catches consumers using the
 * class API — this in-mutation gate is the safety net for consumers who
 * import the mutation function directly.
 *
 * Behavior is intentionally STRICTER than the OwnerClient gate. The
 * OwnerClient gate honours a `requireMainnetConfirmation: false` opt-out
 * via the class config; this mutation-level gate has no such config (a
 * standalone function takes no client config), so on mainnet the caller
 * MUST pass `mainnetConfirmed: true` or the call throws. Devnet ignores
 * the gate entirely.
 *
 * Currently only `createPostAssertions` + `closePostAssertions` invoke
 * this — they are the only standalone mutations whose OwnerClient
 * wrapper is missing (the rest of the mutations are gated at the
 * wrapper). Future standalone mutations should also call this helper.
 *
 * Single source of truth: per the audit finding, the mutation-level gate
 * is the canonical enforcement point. The OwnerClient wrapper gate (when
 * a wrapper exists) double-asserts the same contract; passing
 * `mainnetConfirmed: true` satisfies both layers idempotently.
 */
function assertMutationMainnetConfirmed(
  methodName: string,
  network: "devnet" | "mainnet",
  vault: Address,
  opts?: Pick<TxOpts, "mainnetConfirmed">,
): void {
  if (network !== "mainnet") return;
  if (opts?.mainnetConfirmed === true) return;
  throw new SigilSdkDomainError(
    SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
    `mutations.${methodName} on mainnet requires \`mainnetConfirmed: true\` ` +
      `in the per-call options. Direct imports of mutation builders do not ` +
      `inherit OwnerClient's \`requireMainnetConfirmation\` opt-out — pass ` +
      `\`mainnetConfirmed: true\` to acknowledge the destructive mainnet action. ` +
      `Docs: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md`,
    {
      context: {
        method: methodName,
        network: "mainnet",
        vault: vault.toString(),
      } as never,
    },
  );
}

/**
 * PEN-CROSS-3 (Phase 2 close-up): compute the post-mutation
 * policy_preview_digest for one of the 4 sibling handlers
 * (create_instruction_constraints, apply_close_constraints,
 * create_post_assertions, close_post_assertions).
 *
 * Reads the live PolicyConfig + AgentVault, applies the caller-specified
 * flag override, then returns the canonical digest the on-chain handler
 * will recompute and assert against. The owner signs this exact digest
 * when calling the ix — defends against blind-sign by forcing explicit
 * attestation of the flag flip.
 */
async function siblingHandlerExpectedDigest(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  override: { hasPostAssertions?: number },
): Promise<Uint8Array> {
  const [policyAddress] = await getPolicyPDA(vault);
  const [livePolicy, liveVault] = await Promise.all([
    fetchPolicyConfig(rpc, policyAddress),
    fetchAgentVault(rpc, vault),
  ]);
  return computePolicyPreviewDigest({
    dailySpendingCapUsd: livePolicy.data.dailySpendingCapUsd,
    maxTransactionSizeUsd: livePolicy.data.maxTransactionSizeUsd,
    maxSlippageBps: livePolicy.data.maxSlippageBps,
    developerFeeRate: livePolicy.data.developerFeeRate,
    protocolMode: livePolicy.data.protocolMode,
    protocols: livePolicy.data.protocols,
    destinationMode: livePolicy.data.destinationMode,
    allowedDestinations: livePolicy.data.allowedDestinations,
    timelockDuration: livePolicy.data.timelockDuration,
    sessionExpirySeconds: livePolicy.data.sessionExpirySeconds,
    observeOnly: liveVault.data.observeOnly,
    hasPostAssertions:
      override.hasPostAssertions !== undefined
        ? override.hasPostAssertions
        : livePolicy.data.hasPostAssertions,
    createdAtSlot: livePolicy.data.createdAtSlot,
    // TA-05 (Phase 3): operating_hours is policy-owned. Sibling handlers
    // (constraints/post-assertions) never mutate it — pass through.
    operatingHours: livePolicy.data.operatingHours,
    // TA-07/17 (Phase 3): also pass-through from live policy.
    autoPromoteGrays: livePolicy.data.autoPromoteGrays,
    autoRevokeThreshold: livePolicy.data.autoRevokeThreshold,
    // TA-12/14 (Phase 5): pass-through from live policy — sibling
    // handlers (constraints / post-assertions flips) never mutate the
    // post-execution invariant fields.
    stableBalanceFloor: livePolicy.data.stableBalanceFloor,
    perRecipientDailyCapUsd: livePolicy.data.perRecipientDailyCapUsd,
    // G6 (audit 2026-05-18 cosign opt-in): pass-through from live policy.
    // Sibling handlers never mutate cosign_required — the user changes
    // this via `queue_policy_update` only.
    cosignRequired: livePolicy.data.cosignRequired,
    // D-5 (Bucket 2 audit 2026-05-21, F-RP3-1): pass-through from live
    // policy. Position 21 of the canonical TA-19 digest. Sibling handlers
    // never mutate this — owner sets via queue_policy_update only.
    cosignSessionPubkey: livePolicy.data.cosignSessionPubkey,
    // M-1 (audit 2026-06-11): per-protocol caps (positions 23-24). Sibling
    // handlers never mutate the caps — pass-through from live policy so the
    // re-bind digest matches the on-chain recompute (create_post_assertions
    // .rs:138-139 / close_post_assertions.rs read policy.has_protocol_caps +
    // policy.protocol_caps).
    hasProtocolCaps: livePolicy.data.hasProtocolCaps,
    protocolCaps: livePolicy.data.protocolCaps,
    // HIGH (audit 2026-06-11 follow-up): create_post_assertions.rs:129 and
    // close_post_assertions.rs recompute agent_set_hash from the LIVE vault
    // agents, and :136 reads operator_grant_delay_seconds from live policy.
    // Omitting them here defaulted the digest to EMPTY_AGENT_SET_HASH / 0n,
    // mismatching the on-chain recompute (PolicyPreviewMismatch) for ANY vault
    // with >=1 agent or a non-zero operator-grant delay — i.e. every real vault.
    // vault.agents is the active-agent Vec (register pushes; owner-revoke
    // removes the entry, auto-revoke zeroes its capability in place — either
    // way membership matches the on-chain Vec), mapped 1:1 by
    // computeAgentSetHash (mirrors compute_agent_set_hash).
    agentSetHash: computeAgentSetHash(liveVault.data.agents),
    operatorGrantDelaySeconds: livePolicy.data.operatorGrantDelaySeconds,
  });
}

async function run(
  rpc: Rpc<SolanaRpcApi>,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  instructions: Instruction[],
  opts: TxOpts = {},
  // Elevated-cosign surface (audit 2026-06-12): additional signers beyond the
  // owner (e.g. a cosign-session signer for an elevated queue mutation). The
  // cosigner must ALSO be present in the instruction's account metas as a
  // readonly-signer (the elevated wrappers append it); attaching it here makes
  // its signature land in the wire tx. Default [] preserves the owner-only path
  // for every existing non-elevated caller.
  cosigners: readonly TransactionSigner[] = [],
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
      [owner, ...cosigners],
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
  const ix = await getFreezeVaultInstructionAsync({ owner, vault });
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
  const ix = await getReactivateVaultInstructionAsync({
    owner,
    vault,
    newAgent: newAgent?.address ?? null,
    newAgentCapability: newAgent ? Number(newAgent.permissions) : null,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Phase 8 alias for {@link resumeVault} matching the on-chain
 * `reactivate_vault` instruction name. Prefer `reactivateVault` in new
 * code; `resumeVault` is retained for backwards compatibility.
 */
export async function reactivateVault(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  newAgent?: { address: Address; permissions: CapabilityTier },
  opts?: TxOpts,
): Promise<TxResult> {
  return resumeVault(rpc, vault, owner, network, newAgent, opts);
}

/**
 * Phase 8 owner-side observe-only toggle. Setting `newValue: true` puts
 * the vault into read-only mode (all `validate_and_authorize` calls reject
 * with `ErrObserveOnlyEnabled`). Setting `newValue: false` resumes
 * spending. Bumps `policy_version` so concurrent validate_and_authorize
 * calls fail fast with `PolicyVersionMismatch`.
 */
export async function setObserveOnly(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  newValue: boolean,
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getSetObserveOnlyInstructionAsync({
    vault,
    owner,
    newValue,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Phase 8 owner-side queue of a new agent capability grant. The grant
 * becomes effective after `apply_agent_grant` is called (subject to the
 * cosign_required gate if enabled on the policy).
 *
 * `capability` is the on-chain `AgentCapability` discriminant:
 *   - 0 = READ_ONLY
 *   - 1 = OPERATOR
 *   - 2 = FULL
 * `spendingLimitUsd` is in 6-decimal USDC units (e.g. `$500 = 500_000_000n`).
 */
export async function queueAgentGrant(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  capability: number,
  spendingLimitUsd: bigint,
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getQueueAgentGrantInstructionAsync({
    owner,
    vault,
    agent,
    capability,
    spendingLimitUsd,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Phase 8 owner-side apply of a previously-queued agent capability grant.
 * The grant must have been queued via {@link queueAgentGrant}; the apply
 * handler verifies the PendingAgentGrant PDA exists and that any cosign
 * requirement on the policy has been satisfied (or that the grant lowers
 * — not raises — privilege so cosign is bypassable per F-AT-1).
 */
export async function applyAgentGrant(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const [agentSpendOverlay] = await getAgentOverlayPDA(vault);
  const ix = await getApplyAgentGrantInstructionAsync({
    owner,
    vault,
    agentSpendOverlay,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Phase 8 owner-side cancel of a previously-queued agent capability
 * grant. Closes the PendingAgentGrant PDA and returns rent to the owner.
 */
export async function cancelAgentGrant(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getCancelAgentGrantInstructionAsync({
    owner,
    vault,
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

  // Check all PDAs in parallel (E4 fix — batch instead of sequential)
  const allPdas = [pendingPolicyPda, ...agentPdaDerivations];

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
  // 3-4. SFH-01 close: enumerate pending_owner + pending_agent_grant via the
  // dedicated helper. Without these, the on-chain drain blocks for
  // pending_owner + pending_agent_grant silently no-op via the
  // `lamports() > 0` guard, orphaning their rent. Helper performs parallel
  // getAccountInfo and only includes accounts that exist.
  // (M1-04b: pending_close_constraints + pending_constraints drains removed.)
  //
  // HH-1 close (audit 2026-05-23 §RP): the helper's silent-failure on RPC
  // errors is now escalated to ERROR-level log with vault context. If a
  // transient RPC failure during enumeration kept a PDA out of
  // remainingAccounts, the on-chain drain falls through silently and rent
  // is permanently orphaned. The ERROR-level log surfaces this to off-chain
  // monitors / alerting; the close TX still proceeds (best-effort drain
  // semantic preserved).
  let ch2EnumerationHadRpcError = false;
  const ch2PendingAccounts = await enumerateExistingPendingPdasForClose(
    rpc,
    vault,
    undefined,
    (kind, address, cause) => {
      ch2EnumerationHadRpcError = true;
      const c = redactCause(cause);
      getSigilModuleLogger().error(
        `[closeVault] HH-1: RPC enumeration failed for ${kind} ${address} on vault ${vault} — close TX will proceed without it; rent for that PDA WILL stay orphaned if the PDA exists on-chain. Cause: ${
          c.message ?? c.name ?? c.code ?? "unknown"
        }`,
      );
    },
  );
  if (ch2EnumerationHadRpcError) {
    getSigilModuleLogger().error(
      `[closeVault] HH-1: at least one pending-PDA enumeration RPC failed for vault ${vault} — verify rent reclamation via on-chain audit before considering close complete.`,
    );
  }
  for (const pa of ch2PendingAccounts) {
    remainingAccounts.push({ address: pa.address, role: pa.role });
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

// syncPositions mutation DELETED — position counter system removed per council
// decision (9-1 vote, 2026-04-19). See Plans/we-need-to-plan-serialized-summit.md.

export async function pauseAgent(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  // PEN-CROSS-5 (Phase 4 absorption): policy now required for policy_version bump.
  const [policyPda] = await getPolicyPDA(vault);
  const ix = await getPauseAgentInstructionAsync({
    owner,
    vault,
    policy: policyPda,
    agentToPause: agent,
  });
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
  // PEN-CROSS-5 (Phase 4 absorption): policy now required for policy_version bump.
  const [policyPda] = await getPolicyPDA(vault);
  const ix = await getUnpauseAgentInstructionAsync({
    owner,
    vault,
    policy: policyPda,
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
  // PEN-CROSS-5 (Phase 4 absorption): policy now required for policy_version bump.
  const [policyPda] = await getPolicyPDA(vault);
  const ix = await getRevokeAgentInstructionAsync({
    owner,
    vault,
    policy: policyPda,
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
  // PEN-CROSS-5 (Phase 4 absorption): policy now required for policy_version bump.
  const [policyPda] = await getPolicyPDA(vault);
  const ix = await getRegisterAgentInstructionAsync({
    owner,
    vault,
    policy: policyPda,
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
 *
 * On-chain-only (silent pass through SDK, may fail on-chain):
 *   - `allowedDestinations.length` (MAX_ALLOWED_DESTINATIONS on-chain)
 *   - `protocolCaps.length` must equal `approvedApps.length` when has_protocol_caps
 *   - `maxSlippageBps` <= MAX_SLIPPAGE_BPS on-chain
 *   - `sessionExpirySeconds` range (5..=90 when > 0; audit F5-H1)
 */
export async function queuePolicyUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  changes: PolicyChanges,
  opts?: TxOpts,
): Promise<TxResult> {
  // Non-elevated path: cosign_session = Pubkey::default(), no cosigner in
  // remaining_accounts, owner-only signature. Shares buildPolicyUpdateIx (the
  // merged-effective projection + TA-19 digest) with queuePolicyElevated — the
  // single source of truth that prevents digest drift between the two surfaces.
  // An elevated change submitted here (e.g. raising a cap on a cosign_required
  // vault) fails closed on-chain with ErrCosignRequired; use queuePolicyElevated.
  const ix = await buildPolicyUpdateIx(
    rpc,
    owner,
    vault,
    changes,
    DEFAULT_COSIGN_SESSION,
  );
  return run(rpc, owner, network, [ix], opts);
}

// ═══════════════════════════════════════════════════════════════════════════
// Elevated-cosign surface (audit 2026-06-12) — policy path.
//
// queuePolicyElevated / buildQueuePolicyElevated mirror the agent-perms pair for
// policy changes. They share buildPolicyUpdateIx with queuePolicyUpdate (DRY —
// the single source of truth for the merged-effective projection + TA-19 digest;
// duplicating it is the exact digest-drift failure mode the 2026-06-11 audit
// fixed). The only difference between non-elevated and elevated is the
// cosign_session arg (default vs a real cosigner pubkey) + the elevated-only
// change fields, all plumbed through `eff = changes.X ?? live`.
// ═══════════════════════════════════════════════════════════════════════════

/** Pubkey::default() (System Program) — the non-elevated cosign_session arg. */
const DEFAULT_COSIGN_SESSION =
  "11111111111111111111111111111111" as unknown as Address;

/**
 * Shared queue_policy_update instruction builder. Validates `changes`, fetches
 * live policy+vault, projects the merged-effective policy (`eff = changes.X ??
 * live.X` for EVERY field, so omitted fields fall through to live — the
 * non-elevated path is byte-identical to the prior inline impl), computes the
 * TA-19 digest over it, and builds the ix with the supplied `cosignSession`
 * (DEFAULT_COSIGN_SESSION = non-elevated; a real cosigner pubkey = elevated).
 */
async function buildPolicyUpdateIx(
  rpc: Rpc<SolanaRpcApi>,
  owner: TransactionSigner,
  vault: Address,
  changes: PolicyChanges,
  cosignSession: Address,
): Promise<Instruction> {
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
  const [policyPda] = await getPolicyPDA(vault);
  const livePolicy = await fetchPolicyConfig(rpc, policyPda);
  const liveVault = await fetchAgentVault(rpc, vault);

  const newProtocolMode = changes.protocolMode
    ? mapProtocolMode(changes.protocolMode)
    : null;
  const effProtocolMode = newProtocolMode ?? livePolicy.data.protocolMode;
  const effProtocols = changes.approvedApps ?? livePolicy.data.protocols;
  const effDestinationMode =
    changes.destinationMode ?? livePolicy.data.destinationMode;
  const effDestinations =
    changes.allowedDestinations ?? livePolicy.data.allowedDestinations;
  const effDaily = changes.dailyCap ?? livePolicy.data.dailySpendingCapUsd;
  const effMaxTx = changes.maxPerTrade ?? livePolicy.data.maxTransactionSizeUsd;
  const effMaxSlip = changes.maxSlippageBps ?? livePolicy.data.maxSlippageBps;
  const effDeveloperFeeRate =
    changes.developerFeeRate ?? livePolicy.data.developerFeeRate;
  const effTimelock =
    changes.timelock != null
      ? BigInt(changes.timelock)
      : livePolicy.data.timelockDuration;
  const effSessionExpiry =
    changes.sessionExpirySeconds ?? livePolicy.data.sessionExpirySeconds;
  const effHasProtocolCaps =
    changes.hasProtocolCaps ?? livePolicy.data.hasProtocolCaps;
  const effProtocolCaps =
    changes.protocolCaps ?? livePolicy.data.protocolCaps;
  // Elevated-only fields (audit 2026-06-12): same merged-effective projection.
  // Undefined ⇒ live pass-through, so queuePolicyUpdate's digest is unchanged.
  const effStableFloor =
    changes.stableBalanceFloor ?? livePolicy.data.stableBalanceFloor;
  const effPerRecip =
    changes.perRecipientDailyCapUsd ??
    livePolicy.data.perRecipientDailyCapUsd;
  const effCosignRequired =
    changes.cosignRequired ?? livePolicy.data.cosignRequired;
  const effCosignSessionPubkey =
    changes.cosignSessionPubkey ?? livePolicy.data.cosignSessionPubkey;
  const effOperatorDelay =
    changes.operatorGrantDelaySeconds ??
    livePolicy.data.operatorGrantDelaySeconds;

  const newPolicyPreviewDigest = computePolicyPreviewDigest({
    dailySpendingCapUsd: effDaily,
    maxTransactionSizeUsd: effMaxTx,
    maxSlippageBps: effMaxSlip,
    developerFeeRate: effDeveloperFeeRate,
    protocolMode: effProtocolMode,
    protocols: effProtocols,
    destinationMode: effDestinationMode,
    allowedDestinations: effDestinations,
    timelockDuration: effTimelock,
    sessionExpirySeconds: effSessionExpiry,
    observeOnly: liveVault.data.observeOnly,
    hasPostAssertions: livePolicy.data.hasPostAssertions,
    createdAtSlot: livePolicy.data.createdAtSlot,
    operatingHours: livePolicy.data.operatingHours,
    autoPromoteGrays: livePolicy.data.autoPromoteGrays,
    autoRevokeThreshold: livePolicy.data.autoRevokeThreshold,
    stableBalanceFloor: effStableFloor,
    perRecipientDailyCapUsd: effPerRecip,
    cosignRequired: effCosignRequired,
    operatorGrantDelaySeconds: effOperatorDelay,
    hasProtocolCaps: effHasProtocolCaps,
    protocolCaps: effProtocolCaps,
    agentSetHash: computeAgentSetHash(liveVault.data.agents),
    cosignSessionPubkey: effCosignSessionPubkey,
  });

  const ix = await getQueuePolicyUpdateInstructionAsync({
    owner,
    vault,
    dailySpendingCapUsd: changes.dailyCap ?? null,
    maxTransactionAmountUsd: changes.maxPerTrade ?? null,
    protocolMode: newProtocolMode,
    protocols: changes.approvedApps ?? null,
    developerFeeRate: changes.developerFeeRate ?? null,
    maxSlippageBps: changes.maxSlippageBps ?? null,
    timelockDuration:
      changes.timelock != null ? BigInt(changes.timelock) : null,
    allowedDestinations: changes.allowedDestinations ?? null,
    sessionExpirySeconds: changes.sessionExpirySeconds ?? null,
    hasProtocolCaps: changes.hasProtocolCaps ?? null,
    protocolCaps: changes.protocolCaps ?? null,
    destinationMode: changes.destinationMode ?? null,
    operatingHours: null,
    stableBalanceFloor: changes.stableBalanceFloor ?? null,
    perRecipientDailyCapUsd: changes.perRecipientDailyCapUsd ?? null,
    cosignRequired: changes.cosignRequired ?? null,
    cosignSessionPubkey: changes.cosignSessionPubkey ?? null,
    operatorGrantDelaySeconds: changes.operatorGrantDelaySeconds ?? null,
    cosignSession,
    newPolicyPreviewDigest,
  });
  return ix as unknown as Instruction;
}

/**
 * Elevated policy queue — single-builder dual-sign. Caller holds the cosigner
 * key; signs [owner, cosigner] + sends. For true 2-party async use
 * buildQueuePolicyElevated.
 */
export async function queuePolicyElevated(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  changes: PolicyChanges,
  cosigner: TransactionSigner,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(cosigner.address, "Cosigner address");
  if (cosigner.address === owner.address) {
    throw toDxError(
      new Error(
        "Cosigner must be distinct from the owner (on-chain ErrCosignRequired)",
      ),
    );
  }
  const ix = await buildPolicyUpdateIx(rpc, owner, vault, changes, cosigner.address);
  return run(
    rpc,
    owner,
    network,
    [withCosignerSigner(ix, cosigner.address)],
    opts,
    [cosigner],
  );
}

/**
 * Elevated policy queue — partial-sign handoff. Owner-signs + returns the
 * partial tx + the policy cosign digest for the cosigner to complete + send.
 * The cosign digest binds the RAW queued args (mirrors compute_cosign_digest).
 */
export async function buildQueuePolicyElevated(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  changes: PolicyChanges,
  cosignSession: Address,
  opts?: TxOpts,
): Promise<ElevatedCosignBundle> {
  requireValidAddress(cosignSession, "Cosigner address");
  if (cosignSession === owner.address) {
    throw toDxError(
      new Error(
        "Cosigner must be distinct from the owner (on-chain ErrCosignRequired)",
      ),
    );
  }
  const ix = await buildPolicyUpdateIx(rpc, owner, vault, changes, cosignSession);
  const partialTransactionBase64 = await buildOwnerPartialSignedTx(
    rpc,
    owner,
    [withCosignerSigner(ix, cosignSession)],
    opts,
  );
  const cosignDigest = computeCosignDigest({
    cosignSession,
    dailySpendingCapUsd: changes.dailyCap ?? null,
    maxTransactionAmountUsd: changes.maxPerTrade ?? null,
    allowedDestinations: changes.allowedDestinations ?? null,
    protocols: changes.approvedApps ?? null,
    stableBalanceFloor: changes.stableBalanceFloor ?? null,
    perRecipientDailyCapUsd: changes.perRecipientDailyCapUsd ?? null,
    hasProtocolCaps: changes.hasProtocolCaps ?? null,
    protocolCaps: changes.protocolCaps ?? null,
    cosignRequired: changes.cosignRequired ?? null,
  });
  return { partialTransactionBase64, cosignSession, cosignDigest };
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
  // TA-06 (Phase 3): per-agent cooldown_seconds. 0 = disabled. Optional so
  // existing dashboard callers continue compiling; pass non-zero when
  // configuring agents that need pacing.
  cooldownSeconds: bigint = 0n,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  requireValidPermissions(permissions);
  const ix = await getQueueAgentPermissionsUpdateInstructionAsync({
    owner,
    vault,
    agent,
    newCapability: Number(permissions),
    spendingLimitUsd: spendingLimit,
    cooldownSeconds,
    // Round 2 F-RP3-2 fix (audit 2026-05-19): non-elevated path default —
    // System Program / zero-pubkey. The on-chain handler's elevated gate
    // requires a non-default `cosign_session` only when the mutation
    // raises capability, raises spending_limit, OR sets a non-zero
    // cooldown AND `policy.cosign_required == true`. Callers who need
    // the elevated path should use a dedicated wrapper that injects a
    // real cosign-session pubkey + remaining_accounts signer (analogous
    // to `queuePolicyElevated()` for queue_policy_update).
    //
    // CANONICAL `cosign_session` ARG CONTRACT (Round 2 §RP-2 B4 F-3,
    // 2026-05-19) — same shape as the `queuePolicyUpdate` path above:
    //   - Non-elevated (this branch): pass `Pubkey::default()` and
    //     OMIT the cosigner from `remaining_accounts`.
    //   - Elevated (raising capability, raising spending_limit, or
    //     setting non-zero cooldown on a `cosign_required: true` vault):
    //     pass a REAL session pubkey + include it as a signer in
    //     `remaining_accounts`.
    //   - Reject path: passing a non-default `cosign_session` on a
    //     non-elevated queue surfaces `InvalidPermissions` (6036).
    //     INTENTIONAL — the on-chain handler refuses to silently
    //     downgrade a caller's declared intent (Option A behaviour).
    cosignSession: "11111111111111111111111111111111" as unknown as Address,
  });
  return run(rpc, owner, network, [ix], opts);
}

// ═══════════════════════════════════════════════════════════════════════════
// Elevated-cosign surface (audit 2026-06-12).
//
// On a `cosign_required` vault, raising an agent's capability or spending limit,
// or setting a non-zero cooldown, is an ELEVATED mutation: the on-chain
// queue_agent_permissions_update handler requires a non-default `cosign_session`
// that is (a) distinct from the owner and (b) present as a signer in
// remaining_accounts. Two caller models:
//   - queueAgentPermissionsElevated(...)      single-builder dual-sign: caller
//     supplies the cosigner as a TransactionSigner; we sign [owner, cosigner].
//   - buildQueueAgentPermissionsElevated(...)  partial-sign handoff: caller
//     supplies only the cosigner PUBKEY; we owner-partial-sign and return the
//     base64 partial tx + the cosign digest for the cosigner to complete + send.
// ═══════════════════════════════════════════════════════════════════════════

/** Append a cosign-session signer to a generated instruction's account metas. */
function withCosignerSigner(
  ix: Instruction,
  cosignSession: Address,
): Instruction {
  return {
    ...(ix as any),
    accounts: [
      ...((ix as any).accounts ?? []),
      { address: cosignSession, role: AccountRole.READONLY_SIGNER },
    ],
  } as Instruction;
}

/**
 * Assemble the compute-budget-prefixed message and OWNER-partial-sign it (the
 * cosigner — a required signer via the appended account meta — signs later).
 * Returns the base64 wire transaction for handoff. Mirrors run()'s message
 * assembly but does NOT send.
 */
async function buildOwnerPartialSignedTx(
  rpc: Rpc<SolanaRpcApi>,
  owner: TransactionSigner,
  instructions: Instruction[],
  opts: TxOpts = {},
): Promise<string> {
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
  const blockhash = await getBlockhashCache(rpc).get(rpc);
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(owner.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, tx),
    (tx) => appendTransactionMessageInstructions(allIx, tx),
  );
  const withOwner = addSignersToTransactionMessage([owner], txMessage as any);
  const partial = await partiallySignTransactionMessageWithSigners(
    withOwner as any,
  );
  return getBase64EncodedWireTransaction(partial as any);
}

/** Result of a partial-sign elevated build, for cosigner handoff. */
export interface ElevatedCosignBundle {
  /** Base64 wire tx, owner-signed, awaiting the cosigner's signature. */
  partialTransactionBase64: string;
  /** The cosign-session pubkey bound into the transaction. */
  cosignSession: Address;
  /**
   * The cosign digest the on-chain handler recomputes from the queued args.
   * The cosigner can verify this matches what they intend to attest, and the
   * caller can compare it against `PendingAgentPermissionsUpdate.cosignDigest`
   * after the transaction lands.
   */
  cosignDigest: Uint8Array;
}

/**
 * Elevated agent-permissions queue — single-builder dual-sign. The caller holds
 * the cosigner key (server-side / single-operator). Signs [owner, cosigner] and
 * sends. For a true 2-party async flow use `buildQueueAgentPermissionsElevated`.
 */
export async function queueAgentPermissionsElevated(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  agent: Address,
  permissions: CapabilityTier,
  spendingLimit: UsdBaseUnits,
  cooldownSeconds: bigint,
  cosigner: TransactionSigner,
  opts?: TxOpts,
): Promise<TxResult> {
  requireValidAddress(agent, "Agent address");
  requireValidPermissions(permissions);
  requireValidAddress(cosigner.address, "Cosigner address");
  if (cosigner.address === owner.address) {
    throw toDxError(
      new Error(
        "Cosigner must be distinct from the owner (on-chain ErrCosignRequired)",
      ),
    );
  }
  const ix = await getQueueAgentPermissionsUpdateInstructionAsync({
    owner,
    vault,
    agent,
    newCapability: Number(permissions),
    spendingLimitUsd: spendingLimit,
    cooldownSeconds,
    cosignSession: cosigner.address,
  });
  return run(
    rpc,
    owner,
    network,
    [withCosignerSigner(ix, cosigner.address)],
    opts,
    [cosigner],
  );
}

/**
 * Elevated agent-permissions queue — partial-sign handoff. Owner-signs and
 * returns the partial transaction + cosign digest; the cosigner signs and sends
 * out-of-band (true 2-of-2). Validation mirrors the dual-sign path.
 */
export async function buildQueueAgentPermissionsElevated(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  agent: Address,
  permissions: CapabilityTier,
  spendingLimit: UsdBaseUnits,
  cooldownSeconds: bigint,
  cosignSession: Address,
  opts?: TxOpts,
): Promise<ElevatedCosignBundle> {
  requireValidAddress(agent, "Agent address");
  requireValidPermissions(permissions);
  requireValidAddress(cosignSession, "Cosigner address");
  if (cosignSession === owner.address) {
    throw toDxError(
      new Error(
        "Cosigner must be distinct from the owner (on-chain ErrCosignRequired)",
      ),
    );
  }
  const ix = await getQueueAgentPermissionsUpdateInstructionAsync({
    owner,
    vault,
    agent,
    newCapability: Number(permissions),
    spendingLimitUsd: spendingLimit,
    cooldownSeconds,
    cosignSession,
  });
  const partialTransactionBase64 = await buildOwnerPartialSignedTx(
    rpc,
    owner,
    [withCosignerSigner(ix, cosignSession)],
    opts,
  );
  const cosignDigest = computeAgentPermsCosignDigest({
    cosignSession,
    agent,
    newCapability: Number(permissions),
    spendingLimitUsd: spendingLimit,
    cooldownSeconds,
  });
  return { partialTransactionBase64, cosignSession, cosignDigest };
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

// ─── Post-execution assertions (Phase 2) ─────────────────────────────────────
// Composes with pre-execution InstructionConstraints — NOT a replacement.
//
// Pre-execution (createConstraints above): validates instruction args BEFORE
// the DeFi call runs. Fails closed on disallowed instructions.
//
// Post-execution (createPostAssertions below): snapshots account bytes before
// finalize_session, compares against the on-chain PostExecutionAssertions PDA
// after the DeFi call completes, reverts the whole tx on mismatch. Used for
// leverage caps (CrossFieldLte) and similar "state-after-is-bounded" checks.
//
// Both wrappers auto-derive their respective PDAs — callers pass only the
// vault. Validation runs client-side so the caller never burns a round-trip
// on an entry the on-chain validate_entries would reject. See
// `post-assertion-validation.ts` and Phase 2 PRD ISC-6..9.

/**
 * Create the PostExecutionAssertions PDA for a vault and write the entries.
 *
 * Every entry is validated client-side first (see `validatePostAssertionEntries`).
 * A mid-batch rejection throws a DxError with a message pointing at the
 * offending index; the transaction is never built.
 *
 * Idempotency: calling this twice on the same vault without an intervening
 * close returns an Anchor `AccountAlreadyExists` (3010) — Anchor's `init`
 * constraint enforces this at the program boundary. Phase 2 ISC-45.
 *
 * Rent: destination on close is the vault's owner (Anchor `close = owner`
 * on the account), so `closePostAssertions` refunds to the owner signer.
 *
 * @param rpc      RPC client for blockhash resolution + tx submission.
 * @param vault    Vault PDA this assertions set belongs to.
 * @param owner    Owner signer — must match the vault's `owner` field.
 * @param network  Cluster selector (devnet / mainnet).
 * @param entries  1..=4 PostAssertionEntry values. Validated before send.
 * @param opts     Optional TxOpts (compute budget, priority fee).
 * @returns        TxResult with the confirmed signature.
 */
export async function createPostAssertions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  entries: PostAssertionEntry[],
  opts?: TxOpts,
): Promise<TxResult> {
  // Client-side check mirrors on-chain validate_entries. Throws
  // PostAssertionValidationError, which is structurally a DxError (numeric
  // `code`, `message`, `recovery: string[]`) AND carries the typed
  // `validationCode` + `entryIndex` for FE branching. We intentionally do
  // NOT wrap via toDxError — that would collapse the typed fields into
  // DX_ERROR_CODE_UNMAPPED (7999) and break ISC-19's "pinpoint the bad
  // entry" promise. See post-assertion-validation.ts docblock.
  validatePostAssertionEntries(entries);

  // CH-3 (audit 2026-05-23): AL2 gate AFTER client-side validation so the
  // caller learns about entry-shape mistakes (the cheap, fixable error)
  // before they're forced to think about mainnet acknowledgement (the
  // ceremonial gate). Order matches the OwnerClient pattern of running
  // local validation before destructive-action confirmation.
  assertMutationMainnetConfirmed("createPostAssertions", network, vault, opts);

  // PEN-CROSS-3: bind the post-mutation digest (`has_post_assertions=1`).
  const expectedDigest = await siblingHandlerExpectedDigest(rpc, vault, {
    hasPostAssertions: 1,
  });
  const ix = await getCreatePostAssertionsInstructionAsync({
    owner,
    vault,
    entries,
    expectedDigest,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Close the PostExecutionAssertions PDA for a vault. Rent refunds to owner.
 *
 * No-op if the PDA does not exist — Anchor's `close` attribute will reject
 * the instruction with `AccountNotInitialized` if there's nothing to close;
 * the DxError surface communicates this cleanly.
 *
 * After close, `has_post_assertions` on PolicyConfig flips 0 and
 * finalize_session skips the post-assertion scan on future agent txs.
 *
 * @param rpc      RPC client for blockhash resolution + tx submission.
 * @param vault    Vault PDA whose assertions set should be closed.
 * @param owner    Owner signer — receives the rent refund.
 * @param network  Cluster selector.
 * @param opts     Optional TxOpts.
 * @returns        TxResult with the confirmed signature.
 */
export async function closePostAssertions(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  // CH-3 (audit 2026-05-23): AL2 gate. `closePostAssertions` has no
  // client-side validation step (no entries arg), so the gate runs first.
  assertMutationMainnetConfirmed("closePostAssertions", network, vault, opts);

  // PEN-CROSS-3: bind the post-mutation digest (`has_post_assertions=0`).
  const expectedDigest = await siblingHandlerExpectedDigest(rpc, vault, {
    hasPostAssertions: 0,
  });
  const ix = await getClosePostAssertionsInstructionAsync({
    owner,
    vault,
    expectedDigest,
  });
  return run(rpc, owner, network, [ix], opts);
}

// ═══════════════════════════════════════════════════════════════════════════════
// M-2 (pre-redeploy audit 2026-05-21): Phase 8 ownership-transfer mutations.
//
// On-chain reference: programs/sigil/src/instructions/
//   - initiate_ownership_transfer.rs (owner queues transfer + 48h timelock)
//   - accept_ownership_transfer.rs   (new wallet-owner finalises after timelock)
//   - accept_ownership_transfer_multisig.rs (Squads V4 PDA accepts via CPI)
//   - cancel_ownership_transfer.rs   (current owner aborts during timelock)
//
// Cosign gate: when `policy.cosign_required = true`, `queue_policy_update`
// AND `initiate_ownership_transfer` BOTH require a non-owner co-signer in
// `remaining_accounts` (D4 symmetric cosign gate). The mutations below
// expose the `cosignSession` parameter; pass `undefined` when the policy
// does not require cosign.
//
// LBL-01: all four ix derive vault state by reading
// `vault.vault_authority` (immutable) — the on-chain accept handler
// overwrites `vault.owner` but the PDA address stays put.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Queue an ownership transfer for `vault`. The pending PDA carries the
 * target `newOwner` plus the configured timelock (default 48h). The
 * transfer is finalised only by a follow-up `acceptOwnershipTransfer`
 * (wallet) or `acceptOwnershipTransferMultisig` (Squads V4).
 *
 * @param newOwner          The pubkey that will become `vault.owner` after
 *                          accept. MUST NOT be a system program / sysvar
 *                          (rejected on-chain by `ErrInvalidOwnershipTarget`).
 * @param isMultisigTarget  Set to `true` when `newOwner` is a Squads V4
 *                          multisig PDA — the on-chain handler enforces
 *                          that the matching accept variant is used.
 *
 * Cosign behaviour: when `policy.cosign_required = true`, the on-chain
 * handler enforces a non-owner co-signer; pass the cosign session pubkey
 * via the SDK's transaction-signing layer when building the tx. Pre-G6
 * (audit 2026-05-18) policies without cosign opt-in succeed without one.
 *
 * Replays the H-3 "no double-initiate" rule: a second initiate without
 * an intervening `cancelOwnershipTransfer` fails with
 * `ErrPendingOwnershipExists` (6103).
 */
export async function initiateOwnershipTransfer(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  owner: TransactionSigner,
  network: "devnet" | "mainnet",
  newOwner: Address,
  isMultisigTarget: boolean,
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getInitiateOwnershipTransferInstructionAsync({
    owner,
    vault,
    newOwner,
    isMultisigTarget,
  });
  return run(rpc, owner, network, [ix], opts);
}

/**
 * Finalise a previously-initiated ownership transfer when the incoming
 * owner is a wallet (keypair) signer. The new owner MUST be the signer
 * of the enclosing transaction; the on-chain handler verifies their key
 * matches `pending.new_owner`.
 *
 * Timelock: the transfer is only accepted after the configured timelock
 * has elapsed (default 48h). Calls before the window expires fail with
 * `ErrPendingOwnershipNotReady` (6104).
 *
 * Note: the `owner` argument on this function is the NEW owner who
 * accepts — kept as `owner` for parity with the rest of the mutations
 * surface, but semantically `newOwner.address` is what lands on-chain
 * as `vault.owner`. `vault.vault_authority` (the immutable PDA seed)
 * is unchanged by this ix.
 */
export async function acceptOwnershipTransfer(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  newOwner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getAcceptOwnershipTransferInstructionAsync({
    newOwner,
    vault,
  });
  return run(rpc, newOwner, network, [ix], opts);
}

/**
 * Finalise a previously-initiated ownership transfer when the incoming
 * owner is a Squads V4 multisig PDA (NOT a wallet signer). The Squads
 * program is the CPI caller; the multisig PDA itself has no private key.
 *
 * The on-chain handler verifies:
 *   1. `multisig_pda.owner == SQUADS_V4_PROGRAM_ID`
 *   2. `multisig_pda.key() == pending.new_owner`
 *   3. `pending.is_multisig_target == true`
 *
 * Caller is responsible for routing this ix through the Squads V4
 * proposal flow so it reaches the on-chain handler under the Squads
 * program signer seeds. The `feePayer` MUST be a wallet signer that
 * funds the tx; this SDK call accepts that signer separately so the
 * Squads PDA is NOT a signer at the kit transaction-signing layer.
 *
 * Timelock + cosign rules identical to {@link acceptOwnershipTransfer}.
 */
export async function acceptOwnershipTransferMultisig(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  multisigPda: Address,
  feePayer: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getAcceptOwnershipTransferMultisigInstructionAsync({
    multisigPda,
    vault,
  });
  return run(rpc, feePayer, network, [ix], opts);
}

/**
 * Cancel a queued ownership transfer during the timelock window. The
 * `currentOwner` (signer) MUST match `pending.current_owner` (the
 * pubkey that called `initiateOwnershipTransfer`); the on-chain handler
 * rejects with a require-keys-eq violation otherwise.
 *
 * Closes the pending PDA and returns rent to the current owner. After
 * this ix lands, `initiateOwnershipTransfer` is callable again to queue
 * a different target.
 *
 * Cosign behaviour (D4 symmetric gate): if `policy.cosign_required`,
 * cancellation also requires a non-owner co-signer.
 */
export async function cancelOwnershipTransfer(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  currentOwner: TransactionSigner,
  network: "devnet" | "mainnet",
  opts?: TxOpts,
): Promise<TxResult> {
  const ix = await getCancelOwnershipTransferInstructionAsync({
    currentOwner,
    vault,
  });
  return run(rpc, currentOwner, network, [ix], opts);
}
