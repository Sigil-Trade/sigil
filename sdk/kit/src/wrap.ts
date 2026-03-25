/**
 * wrap() — Protocol-agnostic DeFi instruction wrapping.
 *
 * Takes arbitrary DeFi instructions (from Jupiter API, SAK, GOAT, MCP servers)
 * and sandwiches them with Phalnx security:
 * [ComputeBudget, ValidateAndAuthorize, ...defiIxs, FinalizeSession]
 *
 * All succeed or all revert atomically.
 *
 * Devnet prerequisites (see WRAP-ARCHITECTURE-PLAN-v5.md Phase 4):
 * - Phalnx program deployed at PHALNX_PROGRAM_ADDRESS
 * - PHALNX_ALT_DEVNET updated in alt-config.ts (currently placeholder)
 * - PROTOCOL_TREASURY token accounts initialized for USDC/USDT on devnet
 * - Vault funded with tokens and ATAs created
 */

import type {
  Address,
  AddressesByLookupTableAddress,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import { compileTransaction } from "@solana/kit";

import { ActionType } from "./generated/types/actionType.js";
import { VaultStatus } from "./generated/types/vaultStatus.js";
import { getValidateAndAuthorizeInstructionAsync } from "./generated/instructions/validateAndAuthorize.js";
import { getFinalizeSessionInstructionAsync } from "./generated/instructions/finalizeSession.js";

import {
  resolveVaultState,
  resolveVaultStateForOwner,
  resolveVaultBudget,
  type ResolvedVaultState,
  type ResolvedVaultStateForOwner,
  type EffectiveBudget,
  type ResolvedBudget,
} from "./state-resolver.js";
import { getSessionPDA, getAgentOverlayPDA } from "./resolve-accounts.js";
import {
  composePhalnxTransaction,
  measureTransactionSize,
} from "./composer.js";
import { BlockhashCache, signAndEncode, sendAndConfirmTransaction, type Blockhash, type SendAndConfirmOptions } from "./rpc-helpers.js";
import { AltCache, mergeAltAddresses, verifyPhalnxAlt } from "./alt-loader.js";
import { getPhalnxAltAddress, getExpectedAltContents } from "./alt-config.js";
import { deriveAta } from "./x402/transfer-builder.js";
import {
  type Network,
  isStablecoinMint,
  hasPermission,
  isSpendingAction,
  validateNetwork,
  toInstruction,
  PROTOCOL_TREASURY,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
} from "./types.js";
import { isProtocolAllowed } from "./protocol-resolver.js";
import { getVaultPnL, getVaultTokenBalances, type VaultPnL, type TokenBalance } from "./balance-tracker.js";
import { createVault, type CreateVaultOptions, type CreateVaultResult } from "./create-vault.js";

// ─── Well-known program addresses to strip ──────────────────────────────────

const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WrapParams {
  vault: Address;
  agent: TransactionSigner;
  instructions: Instruction[];
  rpc: Rpc<SolanaRpcApi>;
  network: "devnet" | "mainnet";
  tokenMint: Address;
  amount: bigint;
  actionType?: ActionType;
  targetProtocol?: Address;
  leverageBps?: number;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
  outputStablecoinAccount?: Address;
  blockhash?: Blockhash;
  /**
   * Protocol-specific ALT addresses to merge with the Phalnx ALT for tx compression.
   * Jupiter: extract `addressLookupTableAddresses` from the /swap-instructions response.
   * These rotate per-route — always pass fresh values from the latest API response.
   */
  protocolAltAddresses?: Address[];
  addressLookupTables?: AddressesByLookupTableAddress;
  cachedState?: ResolvedVaultState;
  /** Max age in ms for cachedState before re-resolving. Default: 30_000 (30s). */
  maxCacheAgeMs?: number;
  /** Additional agent ATA → vault ATA replacements for multi-token DeFi routes. */
  additionalAtaReplacements?: Map<Address, Address>;
}

export interface WrapResult {
  ok: true;
  transaction: ReturnType<typeof compileTransaction>;
  actionType: ActionType;
  warnings: string[];
  txSizeBytes: number;
  /** Block height after which the blockhash expires. Sign and send before this. */
  lastValidBlockHeight: bigint;
  /** Vault context for downstream drain detection (eliminates double-resolve) */
  vaultContext?: {
    vaultAddress: Address;
    vaultTokenAta: Address;
    tokenBalance: bigint;
    knownRecipients: Set<string>;
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function normalizeNetwork(network: "devnet" | "mainnet"): Network {
  return network === "mainnet" ? "mainnet-beta" : "devnet";
}

/** Replace agent ATAs with vault ATAs in DeFi instruction account lists. */
export function replaceAgentAtas(
  instructions: Instruction[],
  replacements: Map<Address, Address>,
): Instruction[] {
  if (replacements.size === 0) return instructions;
  return instructions.map((ix) => ({
    ...ix,
    accounts: ix.accounts?.map((acc) => {
      const replacement = replacements.get(acc.address);
      return replacement ? { ...acc, address: replacement } : acc;
    }),
  }));
}

const ACTION_TYPE_KEYS: Record<number, string> = {
  [ActionType.Swap]: "swap",
  [ActionType.OpenPosition]: "openPosition",
  [ActionType.ClosePosition]: "closePosition",
  [ActionType.IncreasePosition]: "increasePosition",
  [ActionType.DecreasePosition]: "decreasePosition",
  [ActionType.Deposit]: "deposit",
  [ActionType.Withdraw]: "withdraw",
  [ActionType.Transfer]: "transfer",
  [ActionType.AddCollateral]: "addCollateral",
  [ActionType.RemoveCollateral]: "removeCollateral",
  [ActionType.PlaceTriggerOrder]: "placeTriggerOrder",
  [ActionType.EditTriggerOrder]: "editTriggerOrder",
  [ActionType.CancelTriggerOrder]: "cancelTriggerOrder",
  [ActionType.PlaceLimitOrder]: "placeLimitOrder",
  [ActionType.EditLimitOrder]: "editLimitOrder",
  [ActionType.CancelLimitOrder]: "cancelLimitOrder",
  [ActionType.SwapAndOpenPosition]: "swapAndOpenPosition",
  [ActionType.CloseAndSwapPosition]: "closeAndSwapPosition",
  [ActionType.CreateEscrow]: "createEscrow",
  [ActionType.SettleEscrow]: "settleEscrow",
  [ActionType.RefundEscrow]: "refundEscrow",
};

// ─── Shared caches (module-level singletons) ────────────────────────────────

const blockhashCache = new BlockhashCache();
const altCache = new AltCache();

// ─── wrap() ─────────────────────────────────────────────────────────────────

/**
 * Wrap arbitrary DeFi instructions with Phalnx security.
 *
 * Sandwiches the provided instructions between validate_and_authorize (before)
 * and finalize_session (after) in an atomic Solana transaction.
 *
 * NOTE: Concurrent calls for the same vault+agent+tokenMint are NOT supported.
 * The on-chain SessionAuthority PDA is deterministic — two concurrent wraps
 * produce colliding session PDAs and only one will succeed on-chain.
 *
 * @throws Error if vault is not active, agent lacks permission, protocol not allowed,
 *   spending cap insufficient, or transaction exceeds 1232 byte limit.
 */
export async function wrap(params: WrapParams): Promise<WrapResult> {
  const warnings: string[] = [];
  const net = normalizeNetwork(params.network);
  validateNetwork(net);

  // Step 1: Resolve vault state (with stale cache detection)
  let state: ResolvedVaultState;
  if (params.cachedState) {
    const ageMs = (Date.now() / 1000 - Number(params.cachedState.resolvedAtTimestamp)) * 1000;
    const maxAge = params.maxCacheAgeMs ?? 30_000;
    if (ageMs > maxAge) {
      state = await resolveVaultState(params.rpc, params.vault, params.agent.address, undefined, net);
    } else {
      state = params.cachedState;
    }
  } else {
    state = await resolveVaultState(params.rpc, params.vault, params.agent.address, undefined, net);
  }

  // Verify vault is active
  if (state.vault.status !== VaultStatus.Active) {
    throw new Error(
      `Vault is not active (status: ${VaultStatus[state.vault.status] ?? state.vault.status})`,
    );
  }

  // Step 2: Validate agent
  const agentEntry = state.vault.agents.find(
    (a) => a.pubkey === params.agent.address,
  );
  if (!agentEntry) {
    throw new Error(
      `Agent ${params.agent.address} is not registered in vault ${params.vault}`,
    );
  }
  if (agentEntry.paused) {
    throw new Error(
      `Agent ${params.agent.address} is paused in vault ${params.vault}`,
    );
  }

  // Step 3: Determine actionType + spending
  const actionType = params.actionType ?? ActionType.Swap;
  const actionKey = ACTION_TYPE_KEYS[actionType];
  if (!actionKey) {
    throw new Error(`Unknown ActionType: ${actionType}`);
  }

  // Escrow actions use standalone instructions, not the validate/finalize composition flow.
  // On-chain validate_and_authorize rejects escrow actions with InvalidSession.
  const ESCROW_ACTIONS = new Set([
    ActionType.CreateEscrow,
    ActionType.SettleEscrow,
    ActionType.RefundEscrow,
  ]);
  if (ESCROW_ACTIONS.has(actionType)) {
    throw new Error(
      `Escrow action "${actionKey}" uses standalone instructions, not wrap(). ` +
      `Use createEscrow/settleEscrow/refundEscrow directly.`,
    );
  }

  const spending = isSpendingAction(actionKey);
  if (spending && params.amount === 0n) {
    throw new Error(
      `Spending action "${actionKey}" requires amount > 0`,
    );
  }
  if (!spending && params.amount !== undefined && params.amount !== 0n) {
    throw new Error(
      `Non-spending action "${actionKey}" requires amount === 0 (on-chain enforces InvalidNonSpendingAmount)`,
    );
  }

  // Step 4: Strip infrastructure instructions
  const defiInstructions = params.instructions.filter(
    (ix) =>
      ix.programAddress !== COMPUTE_BUDGET_PROGRAM &&
      ix.programAddress !== SYSTEM_PROGRAM,
  );

  // Step 5: Determine targetProtocol
  const targetProtocol =
    params.targetProtocol ?? defiInstructions[0]?.programAddress;
  if (!targetProtocol) {
    throw new Error(
      "No target protocol: provide targetProtocol or include DeFi instructions",
    );
  }

  // Step 6: Pre-flight checks
  // 6a: Permission check (hard error)
  if (!hasPermission(agentEntry.permissions, actionKey)) {
    throw new Error(
      `Agent lacks permission for action "${actionKey}"`,
    );
  }

  // 6b: Protocol allowlist (hard error)
  if (!isProtocolAllowed(targetProtocol, state.policy)) {
    throw new Error(
      `Protocol ${targetProtocol} is not allowed by vault policy`,
    );
  }

  // 6c: Cap headroom (advisory warning, not error)
  if (spending && params.amount > 0n) {
    const headroom = state.globalBudget.remaining;
    if (params.amount > headroom) {
      warnings.push(
        `Amount ${params.amount} exceeds remaining daily cap headroom ${headroom}. ` +
          `Transaction may be rejected on-chain.`,
      );
    }
  }

  // 6d: Position limit check for increment actions
  if (
    (actionType === ActionType.OpenPosition ||
      actionType === ActionType.SwapAndOpenPosition) &&
    state.vault.openPositions >= state.policy.maxConcurrentPositions
  ) {
    throw new Error(
      `Position limit reached: ${state.vault.openPositions}/${state.policy.maxConcurrentPositions}`,
    );
  }

  // Step 7: Derive token accounts (parallelized — all pure crypto, no RPC)
  const needsOutputStablecoin =
    spending && !isStablecoinMint(params.tokenMint, net);
  const defaultStableMint =
    net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;

  const [
    vaultTokenAccount,
    outputStablecoinDerived,
    protocolTreasuryTokenAccount,
    feeDestinationTokenAccount,
    [agentOverlayPda],
    [sessionPda],
    agentTokenAta,
    agentStablecoinAta,
  ] = await Promise.all([
    deriveAta(params.vault, params.tokenMint),
    needsOutputStablecoin && !params.outputStablecoinAccount
      ? deriveAta(params.vault, defaultStableMint)
      : Promise.resolve(undefined),
    spending
      ? deriveAta(PROTOCOL_TREASURY, params.tokenMint)
      : Promise.resolve(undefined),
    spending && state.policy.developerFeeRate > 0
      ? deriveAta(state.vault.feeDestination, params.tokenMint)
      : Promise.resolve(undefined),
    getAgentOverlayPDA(params.vault, 0),
    getSessionPDA(params.vault, params.agent.address, params.tokenMint),
    deriveAta(params.agent.address, params.tokenMint),
    needsOutputStablecoin
      ? deriveAta(params.agent.address, defaultStableMint)
      : Promise.resolve(undefined),
  ]);

  const outputStablecoinAccount: Address | undefined =
    params.outputStablecoinAccount ?? outputStablecoinDerived;

  // Step 7b: Replace agent ATAs with vault ATAs in DeFi instructions
  const ataReplacements = new Map<Address, Address>();
  ataReplacements.set(agentTokenAta, vaultTokenAccount);
  if (agentStablecoinAta && outputStablecoinAccount) {
    ataReplacements.set(agentStablecoinAta, outputStablecoinAccount);
  }
  // Merge additional ATA replacements for multi-token DeFi routes
  if (params.additionalAtaReplacements) {
    for (const [agentAta, vaultAta] of params.additionalAtaReplacements) {
      ataReplacements.set(agentAta, vaultAta);
    }
  }
  const rewrittenDefiInstructions = replaceAgentAtas(
    defiInstructions,
    ataReplacements,
  );

  // Step 8: Build validate_and_authorize instruction
  const validateIx = await getValidateAndAuthorizeInstructionAsync({
    agent: params.agent,
    vault: params.vault,
    agentSpendOverlay: agentOverlayPda,
    vaultTokenAccount,
    tokenMintAccount: params.tokenMint,
    protocolTreasuryTokenAccount,
    feeDestinationTokenAccount,
    outputStablecoinAccount,
    actionType,
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol,
    leverageBps: params.leverageBps ?? null,
  });

  const finalizeIx = await getFinalizeSessionInstructionAsync({
    payer: params.agent,
    vault: params.vault,
    session: sessionPda,
    sessionRentRecipient: params.agent.address,
    agentSpendOverlay: agentOverlayPda,
    vaultTokenAccount,
    outputStablecoinAccount,
    success: true,
  });

  // Step 10: Compose + compile + measure
  const blockhash =
    params.blockhash ?? (await blockhashCache.get(params.rpc));

  // Resolve ALTs — Phalnx ALT + protocol ALTs (e.g. Jupiter route-specific)
  let addressLookupTables = params.addressLookupTables;
  if (!addressLookupTables) {
    const phalnxAlt = getPhalnxAltAddress(net);
    const allAlts = mergeAltAddresses(phalnxAlt, params.protocolAltAddresses);
    addressLookupTables = await altCache.resolve(params.rpc, allAlts);

    // Verify Phalnx ALT contents — if stale cache causes mismatch, evict and retry once.
    // This self-heals after ALT extension without requiring manual cache invalidation.
    try {
      verifyPhalnxAlt(addressLookupTables, phalnxAlt, getExpectedAltContents(net));
    } catch (e) {
      // Evict stale cache entry and re-resolve from RPC
      altCache.invalidate();
      addressLookupTables = await altCache.resolve(params.rpc, allAlts);
      // Second attempt throws if still mismatched (real corruption, not staleness)
      verifyPhalnxAlt(addressLookupTables, phalnxAlt, getExpectedAltContents(net));
    }
  }

  const compiledTx = composePhalnxTransaction({
    feePayer: params.agent.address,
    validateIx: toInstruction(validateIx),
    defiInstructions: rewrittenDefiInstructions,
    finalizeIx: toInstruction(finalizeIx),
    blockhash,
    computeUnits: params.computeUnits,
    priorityFeeMicroLamports: params.priorityFeeMicroLamports,
    addressLookupTables,
  });

  const { byteLength, withinLimit } = measureTransactionSize(compiledTx);
  if (!withinLimit) {
    const hasProtocolAlts = params.protocolAltAddresses && params.protocolAltAddresses.length > 0;
    throw new Error(
      `Transaction size ${byteLength} bytes exceeds 1232 byte limit. ` +
        (hasProtocolAlts
          ? `Even with ${params.protocolAltAddresses!.length} protocol ALT(s), the transaction is too large. Reduce instruction count.`
          : `Pass protocolAltAddresses from your DeFi API response (e.g. Jupiter swap-instructions addressLookupTableAddresses).`),
    );
  }

  // Build vaultContext for downstream drain detection
  const usdcMintForNet = net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const usdtMintForNet = net === "devnet" ? USDT_MINT_DEVNET : USDT_MINT_MAINNET;
  const tokenBalance =
    params.tokenMint === usdcMintForNet
      ? state.stablecoinBalances.usdc
      : params.tokenMint === usdtMintForNet
        ? state.stablecoinBalances.usdt
        : 0n;

  // Known recipients: ATA addresses that legitimately receive tokens during Phalnx TXs.
  // Drain detection compares against token account (ATA) addresses in balance deltas,
  // so we must add ATAs here — NOT wallet addresses (which would never match).
  const knownRecipients = new Set<string>();
  knownRecipients.add(vaultTokenAccount); // vault's own token ATA
  if (protocolTreasuryTokenAccount) {
    knownRecipients.add(protocolTreasuryTokenAccount);
  }
  if (feeDestinationTokenAccount) {
    knownRecipients.add(feeDestinationTokenAccount);
  }

  return {
    ok: true,
    transaction: compiledTx,
    actionType,
    warnings,
    txSizeBytes: byteLength,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    vaultContext: {
      vaultAddress: params.vault,
      vaultTokenAta: vaultTokenAccount,
      tokenBalance,
      knownRecipients,
    },
  };
}

// ─── PhalnxClient Types ──────────────────────────────────────────────────

export interface PhalnxClientConfig {
  rpc: Rpc<SolanaRpcApi>;
  vault: Address;
  agent: TransactionSigner;
  network: "devnet" | "mainnet";
  blockhashTtlMs?: number;
}

/**
 * Options for `client.wrap()`.
 *
 * Note: `blockhash` is intentionally omitted — PhalnxClient manages its own
 * BlockhashCache instance, which is what `invalidateCaches()` actually clears.
 * Use the standalone `wrap()` function if you need to supply a custom blockhash.
 */
export interface ClientWrapOpts {
  tokenMint: Address;
  amount: bigint;
  actionType?: ActionType;
  targetProtocol?: Address;
  leverageBps?: number;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
  outputStablecoinAccount?: Address;
  protocolAltAddresses?: Address[];
  addressLookupTables?: AddressesByLookupTableAddress;
  cachedState?: ResolvedVaultState;
  maxCacheAgeMs?: number;
  additionalAtaReplacements?: Map<Address, Address>;
}

export interface ExecuteResult {
  signature: string;
  wrapResult: WrapResult;
}

// ─── PhalnxClient ─────────────────────────────────────────────────────────

/**
 * Primary SDK entry point — stateful client that owns context and caches.
 *
 * Recommended over standalone wrap() for production use:
 * - Holds vault, agent, network, and RPC — no state carrying between calls
 * - Blockhash and ALT caches are isolated per client instance
 * - invalidateCaches() clears instance caches that are actually used
 * - Convenience methods delegate to existing stateless functions
 */
export class PhalnxClient {
  private readonly blockhashCacheInstance: BlockhashCache;
  private readonly altCacheInstance: AltCache;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly agent: TransactionSigner;
  readonly network: "devnet" | "mainnet";

  constructor(config: PhalnxClientConfig) {
    if (!config.rpc) throw new Error("PhalnxClientConfig.rpc is required");
    if (!config.vault) throw new Error("PhalnxClientConfig.vault is required");
    if (!config.agent) throw new Error("PhalnxClientConfig.agent is required");
    if (!config.network) throw new Error("PhalnxClientConfig.network is required");

    this.rpc = config.rpc;
    this.vault = config.vault;
    this.agent = config.agent;
    this.network = config.network;
    this.blockhashCacheInstance = new BlockhashCache(config.blockhashTtlMs);
    this.altCacheInstance = new AltCache();
  }

  /**
   * Wrap DeFi instructions with Phalnx security.
   *
   * Pre-resolves blockhash and ALTs from instance caches, then delegates
   * to the standalone wrap() function. This ensures invalidateCaches()
   * actually clears caches that are read (N-2 fix).
   */
  async wrap(instructions: Instruction[], opts: ClientWrapOpts): Promise<WrapResult> {
    // Parallelize blockhash + ALT resolution (both independent RPC calls)
    const altPromise = opts.addressLookupTables
      ? Promise.resolve(opts.addressLookupTables)
      : this.altCacheInstance.resolve(
          this.rpc,
          mergeAltAddresses(
            getPhalnxAltAddress(normalizeNetwork(this.network)),
            opts.protocolAltAddresses,
          ),
        );

    let [blockhash, addressLookupTables] = await Promise.all([
      this.blockhashCacheInstance.get(this.rpc),
      altPromise,
    ]);

    // Defense-in-depth: verify Phalnx ALT contents even when pre-resolved.
    // On-chain constraints are the real security boundary, but this catches
    // stale ALT data or SDK-layer corruption before the transaction is sent.
    // If stale cache causes mismatch, evict and retry once (self-healing).
    if (!opts.addressLookupTables) {
      const net = normalizeNetwork(this.network);
      const phalnxAlt = getPhalnxAltAddress(net);
      const expected = getExpectedAltContents(net);
      try {
        verifyPhalnxAlt(addressLookupTables, phalnxAlt, expected);
      } catch {
        this.altCacheInstance.invalidate();
        const allAlts = mergeAltAddresses(phalnxAlt, opts.protocolAltAddresses);
        addressLookupTables = await this.altCacheInstance.resolve(this.rpc, allAlts);
        verifyPhalnxAlt(addressLookupTables, phalnxAlt, expected);
      }
    }

    return wrap({
      rpc: this.rpc,
      vault: this.vault,
      agent: this.agent,
      network: this.network,
      instructions,
      ...opts,
      blockhash,
      addressLookupTables,
    });
  }

  /**
   * Wrap + sign + send + confirm in one call.
   *
   * Uses the same signing pattern as TransactionExecutor.signSendConfirm()
   * (transaction-executor.ts:236-265).
   */
  async executeAndConfirm(
    instructions: Instruction[],
    opts: ClientWrapOpts & { confirmOptions?: SendAndConfirmOptions },
  ): Promise<ExecuteResult> {
    const result = await this.wrap(instructions, opts);
    const encoded = await signAndEncode(this.agent, result.transaction);
    const signature = await sendAndConfirmTransaction(
      this.rpc,
      encoded,
      opts.confirmOptions,
    );
    return { signature, wrapResult: result };
  }

  invalidateCaches(): void {
    this.blockhashCacheInstance.invalidate();
    this.altCacheInstance.invalidate();
  }

  // ─── Convenience methods (pure delegation) ─────────────────────────────

  private get networkFull(): Network {
    return this.network === "mainnet" ? "mainnet-beta" : "devnet";
  }

  async getVaultState(): Promise<ResolvedVaultStateForOwner> {
    return resolveVaultStateForOwner(this.rpc, this.vault, undefined, this.networkFull);
  }

  async getAgentBudget(): Promise<ResolvedBudget> {
    return resolveVaultBudget(this.rpc, this.vault, this.agent.address);
  }

  async getPnL(): Promise<VaultPnL> {
    return getVaultPnL(this.rpc, this.vault, this.networkFull);
  }

  async getTokenBalances(): Promise<TokenBalance[]> {
    return getVaultTokenBalances(this.rpc, this.vault, this.networkFull);
  }

  static async createVault(opts: CreateVaultOptions): Promise<CreateVaultResult> {
    return createVault(opts);
  }
}
