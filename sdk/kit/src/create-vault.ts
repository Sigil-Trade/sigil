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
} from "./kit-adapter.js";
import type { Instruction } from "./kit-adapter.js";

import { getInitializeVaultInstructionAsync } from "./generated/instructions/initializeVault.js";
import { getRegisterAgentInstruction } from "./generated/instructions/registerAgent.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getAgentOverlayPDA,
} from "./resolve-accounts.js";
import { findNextVaultId } from "./inscribe.js";
import {
  FULL_PERMISSIONS,
  toInstruction,
  type CapabilityTier,
  type UsdBaseUnits,
} from "./types.js";
import { buildOwnerTransaction } from "./owner-transaction.js";
import { signAndEncode, sendAndConfirmTransaction } from "./rpc-helpers.js";
import type { SendAndConfirmOptions } from "./rpc-helpers.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import {
  SIGIL_ERROR__SDK__OWNER_AGENT_COLLISION,
  SIGIL_ERROR__SDK__INVALID_CAPABILITY,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
} from "./errors/codes.js";
import { validateAgentCapAggregate } from "./helpers/validate-cap-aggregate.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateVaultOptions {
  rpc: Rpc<SolanaRpcApi>;
  network: "devnet" | "mainnet";
  owner: TransactionSigner;
  agent: TransactionSigner;
  permissions?: CapabilityTier;
  /**
   * Per-agent spending cap in USD base units (6-decimal). Required since
   * v0.9.0 — previously defaulted silently to `0n` which made the agent
   * unable to spend. Closes Pentester F3 / D11: force callers to think
   * about the cap rather than inherit an invisible default.
   *
   * Pass `0n` explicitly to register an Observer-class agent (read-only,
   * no spending authority).
   *
   * Use `SAFETY_PRESETS.development.spendingLimitUsd` (100_000_000n =
   * $100) for local/test envs, or set explicitly in production.
   */
  spendingLimitUsd: UsdBaseUnits;
  /**
   * Vault-wide daily cap in USD base units (6-decimal). Required since
   * v0.9.0 — previously defaulted silently to 500_000_000n. Closes
   * Pentester F5 / D11: force callers to specify the vault's blast
   * radius rather than inherit the $500/day default.
   *
   * Constraint: `spendingLimitUsd` ≤ `dailySpendingCapUsd` — enforced
   * by `validateAgentCapAggregate` at construction time.
   */
  dailySpendingCapUsd: UsdBaseUnits;
  maxTransactionSizeUsd?: UsdBaseUnits;
  feeDestination?: Address;
  developerFeeRate?: number;
  protocols?: Address[];
  protocolMode?: number;
  /**
   * Per-protocol daily caps in USD base units (6-decimal). Index-aligned
   * with `protocols`. Required when `protocolMode === 1` (ALLOWLIST) AND
   * caps are desired. Must satisfy `protocolCaps.length === protocols.length`
   * — the on-chain program rejects mismatched lengths with
   * `ProtocolCapsMismatch`. A value of `0n` for an entry means no cap for
   * that protocol (global cap still applies). Default: empty array (no
   * per-protocol caps; only the global cap enforces).
   */
  protocolCaps?: bigint[];
  maxSlippageBps?: number;
  /**
   * Timelock duration in seconds for owner-initiated policy changes.
   * Required since v0.9.0 — previously defaulted silently to 0 (no
   * timelock). Closes Pentester F7 / D11: force callers to specify an
   * intentional delay between queue and apply so compromised-key attacks
   * have a window to be noticed and canceled.
   *
   * Minimum: `MIN_TIMELOCK_DURATION = 1800` (30 min) enforced on-chain.
   * Use `SAFETY_PRESETS.development.timelockDuration` (1800) for local
   * envs, `SAFETY_PRESETS.production.timelockDuration` (86400, 24h) for
   * prod.
   *
   * Pass `0` explicitly to acknowledge no timelock protection (e.g., for
   * throwaway test vaults); the on-chain program will reject the call
   * if MIN_TIMELOCK_DURATION is enforced for the target feature flag.
   */
  timelockDuration: number;
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
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__OWNER_AGENT_COLLISION,
      "Owner and agent must be different keys. " +
        "The owner has full vault authority; the agent has constrained execution only.",
      {
        context: {
          owner: options.owner.address,
          agent: options.agent.address,
        },
      },
    );
  }

  // v0.9.0: validate REQUIRED fields — reject explicit undefined and
  // reject any non-bigint for the two cap fields (runtime guard for JS
  // consumers who bypass the TS type check).
  if (
    typeof options.spendingLimitUsd === "undefined" ||
    typeof options.spendingLimitUsd !== "bigint"
  ) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      "createVault: `spendingLimitUsd` is required (v0.9.0). Pass an " +
        "explicit bigint in USD base units. Use `0n` for an Observer-class " +
        "agent. See SAFETY_PRESETS for recommended values.",
      { context: { field: "spendingLimitUsd" } },
    );
  }
  if (
    typeof options.dailySpendingCapUsd === "undefined" ||
    typeof options.dailySpendingCapUsd !== "bigint"
  ) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      "createVault: `dailySpendingCapUsd` is required (v0.9.0). Pass an " +
        "explicit bigint in USD base units. See SAFETY_PRESETS for " +
        "recommended values.",
      { context: { field: "dailySpendingCapUsd" } },
    );
  }
  if (
    typeof options.timelockDuration === "undefined" ||
    typeof options.timelockDuration !== "number"
  ) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      "createVault: `timelockDuration` is required (v0.9.0). Pass an " +
        "explicit number of seconds. Use `SAFETY_PRESETS.production." +
        "timelockDuration` (86400) for prod.",
      { context: { field: "timelockDuration" } },
    );
  }

  // Aggregate cap guard (D12, Pentester F3) — this is the first agent,
  // so `existingAgentCaps: []`. Subsequent addAgent calls (Sprint 2)
  // pass the current vault's agent caps.
  validateAgentCapAggregate({
    vaultDailyCap: options.dailySpendingCapUsd,
    existingAgentCaps: [],
    newAgentCap: options.spendingLimitUsd,
  });

  // Validate capability fits the on-chain 2-bit enum.
  //
  // The v6 on-chain program enforces `capability <= 2` (0 = Disabled,
  // 1 = Observer, 2 = Operator). A consumer passing an old-style bitmask
  // would silently truncate in the `Number(...)` coercion below and then
  // fail `InvalidPermissions` on-chain after paying compute budget. Catching
  // it client-side turns a one-RTT-late devnet rejection into an immediate,
  // descriptive error. Granular per-action restriction lives in
  // `InstructionConstraints`, not on the capability field.
  if (options.permissions !== undefined) {
    const cap = options.permissions;
    if (cap < 0n || cap > 2n) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CAPABILITY,
        `Invalid capability ${cap}. The on-chain program expects a 2-bit enum ` +
          `(0 = Disabled, 1 = Observer, 2 = Operator) — not a bitmask. ` +
          `Use FULL_CAPABILITY (2n) for an agent that needs spending authority, ` +
          `and move granular per-action restriction into InstructionConstraints.`,
      );
    }
  }

  // Step 1: Resolve vault ID
  const vaultId =
    options.vaultId ??
    (await findNextVaultId(options.rpc, options.owner.address));

  // Step 2: Derive PDAs
  const [vaultAddress] = await getVaultPDA(options.owner.address, vaultId);
  const [policyAddress] = await getPolicyPDA(vaultAddress);
  const [agentOverlayAddress] = await getAgentOverlayPDA(vaultAddress, 0);

  // Step 3: Resolve remaining fields with intentional defaults.
  //
  // `spendingLimitUsd`, `dailySpendingCapUsd`, and `timelockDuration` are
  // REQUIRED (v0.9.0) — no defaults. The fields below retain defaults
  // because they don't silently reduce security posture:
  //   - maxTransactionSizeUsd defaults to dailySpendingCapUsd (caller's
  //     explicit cap becomes the per-tx ceiling unless narrower)
  //   - feeDestination defaults to the owner's key (same principal)
  //   - protocols=[] + protocolMode=0 means "all protocols allowed" —
  //     this is a policy decision, not a silent reduction
  const maxTransactionSizeUsd =
    options.maxTransactionSizeUsd ?? options.dailySpendingCapUsd;
  const feeDestination = options.feeDestination ?? options.owner.address;
  const protocols = options.protocols ?? [];
  const protocolMode = options.protocolMode ?? 0;

  // Step 4: Build initializeVault instruction
  //
  // `protocolCaps`: forward caller-supplied caps if provided; otherwise
  // default to all-zeros (no per-protocol caps, global cap still applies).
  // The on-chain program enforces `protocol_caps.len() == protocols.len()`
  // when `protocol_caps` is non-empty, so empty + zeros are equivalent in
  // effect; the empty path saves a Vec allocation on-chain.
  const protocolCaps =
    options.protocolCaps !== undefined
      ? options.protocolCaps
      : protocols.map(() => 0n);

  const initializeVaultIx = await getInitializeVaultInstructionAsync({
    owner: options.owner,
    agentSpendOverlay: agentOverlayAddress,
    feeDestination,
    vaultId,
    dailySpendingCapUsd: options.dailySpendingCapUsd,
    maxTransactionSizeUsd,
    protocolMode,
    protocols,
    developerFeeRate: options.developerFeeRate ?? 0,
    maxSlippageBps: options.maxSlippageBps ?? 100,
    timelockDuration: options.timelockDuration,
    allowedDestinations: options.allowedDestinations ?? [],
    protocolCaps,
  });

  // Step 5: Build registerAgent instruction
  const registerAgentIx = getRegisterAgentInstruction({
    owner: options.owner,
    vault: vaultAddress,
    agentSpendOverlay: agentOverlayAddress,
    agent: options.agent.address,
    capability: Number(options.permissions ?? FULL_PERMISSIONS),
    spendingLimitUsd: options.spendingLimitUsd,
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
