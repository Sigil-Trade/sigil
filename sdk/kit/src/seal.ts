/**
 * seal() — Protocol-agnostic DeFi instruction sealing.
 *
 * Takes arbitrary DeFi instructions (from Jupiter API, SAK, GOAT, MCP servers)
 * and sandwiches them with Sigil security:
 * [ComputeBudget, ValidateAndAuthorize, ...defiIxs, FinalizeSession]
 *
 * All succeed or all revert atomically.
 *
 * Devnet prerequisites:
 * - Sigil program deployed at SIGIL_PROGRAM_ADDRESS
 * - SIGIL_ALT_DEVNET updated in alt-config.ts (currently placeholder)
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
} from "./kit-adapter.js";
import { compileTransaction, AccountRole } from "./kit-adapter.js";

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
import { composeSigilTransaction, measureTransactionSize } from "./composer.js";
import {
  BlockhashCache,
  getBlockhashCache,
  signAndEncode,
  sendAndConfirmTransaction,
  type Blockhash,
  type SendAndConfirmOptions,
} from "./rpc-helpers.js";
import { AltCache, mergeAltAddresses, verifySigilAlt } from "./alt-loader.js";
import { getSigilAltAddress, getExpectedAltContents } from "./alt-config.js";
import { deriveAta } from "./tokens.js";
import {
  type Network,
  isStablecoinMint,
  validateNetwork,
  normalizeNetwork,
  toInstruction,
  PROTOCOL_TREASURY,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  RECOGNIZED_DEFI_PROGRAMS,
  PROTOCOL_FEE_RATE,
} from "./types.js";
import { isProtocolAllowed } from "./protocol-resolver.js";
import { toSigilAgentError, type AgentError } from "./agent-errors.js";
import { redactCause } from "./network-errors.js";
import {
  getVaultPnL,
  getVaultTokenBalances,
  type VaultPnL,
  type TokenBalance,
} from "./balance-tracker.js";
import { parseTokenBalance } from "./simulation.js";
import {
  createVault,
  type CreateVaultOptions,
  type CreateVaultResult,
} from "./create-vault.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SigilRpcError } from "./errors/rpc.js";
import {
  SIGIL_ERROR__SDK__VAULT_INACTIVE,
  SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
  SIGIL_ERROR__SDK__AGENT_PAUSED,
  SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
  SIGIL_ERROR__SDK__INVALID_AMOUNT,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED,
  SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
  SIGIL_ERROR__SDK__CAP_EXCEEDED,
  SIGIL_ERROR__SDK__ATA_NON_CANONICAL,
  SIGIL_ERROR__SDK__SEAL_FAILED,
  SIGIL_ERROR__RPC__TX_TOO_LARGE,
} from "./errors/codes.js";

// ─── Well-known program addresses to strip ──────────────────────────────────

// PR 3.B F036: use canonical constants from types.ts instead of local dupes.
import {
  TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM_ADDRESS as TOKEN_2022_PROGRAM,
  COMPUTE_BUDGET_PROGRAM_ADDRESS as COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM_ADDRESS as SYSTEM_PROGRAM,
} from "./types.js";

/** Sentinel balance for drain detection when RPC fails to fetch actual balance.
 *  1n makes any outflow trigger percentage-based flags (conservative). */
const DRAIN_DETECTION_MIN_BALANCE = 1n;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SealParams {
  /** On-chain vault PDA address. */
  vault: Address;
  /** Agent signer — must be registered in the vault's agent list. */
  agent: TransactionSigner;
  /** DeFi instructions to seal. ComputeBudget and System instructions are stripped automatically. */
  instructions: Instruction[];
  /** RPC client for state resolution and blockhash fetching. */
  rpc: Rpc<SolanaRpcApi>;
  /** Network identifier. Accepts `"devnet"` or `"mainnet"` (normalized to `"mainnet-beta"` internally). */
  network: "devnet" | "mainnet";
  /**
   * Token mint being spent FROM the vault.
   *
   * For swaps: the input mint (what leaves the vault).
   * For transfers: the transferred token's mint.
   *
   * The SDK uses this to derive the vault's ATA and rewrite agent ATAs
   * in the DeFi instructions to point at the vault's token account.
   */
  tokenMint: Address;
  /**
   * Amount in the token's native base units.
   *
   * - Stablecoin input (USDC/USDT): base units = USD with 6 decimals.
   *   Example: $100 USDC = 100_000_000n (100 * 10^6).
   *
   * - Non-stablecoin input (SOL, BONK, etc.): raw token base units.
   *   Example: 1 SOL = 1_000_000_000n (10^9 lamports).
   *   Non-stablecoin amounts are NOT cap-checked (by design) —
   *   finalize_session measures actual stablecoin balance delta instead.
   *
   * Must be > 0 for spending actions, 0 for non-spending actions.
   */
  amount: bigint;
  /** Protocol program address. Auto-detected from first DeFi instruction if omitted. */
  targetProtocol?: Address;
  /** Override compute unit budget. Default: auto-estimated from action type. */
  computeUnits?: number;
  /** Priority fee in microLamports per CU. Default: 0 (no priority fee). */
  priorityFeeMicroLamports?: number;
  /** Output stablecoin ATA for non-stablecoin input swaps. Vault's canonical ATA derived if omitted. */
  outputStablecoinAccount?: Address;
  /** Pre-fetched blockhash. If omitted, fetched via RPC (cached 30s). */
  blockhash?: Blockhash;
  /**
   * Protocol-specific ALT addresses to merge with the Sigil ALT for tx compression.
   * Jupiter: extract `addressLookupTableAddresses` from the /swap-instructions response.
   * These rotate per-route — always pass fresh values from the latest API response.
   */
  protocolAltAddresses?: Address[];
  /** Pre-resolved ALT contents. If omitted, Sigil ALT resolved automatically. */
  addressLookupTables?: AddressesByLookupTableAddress;
  /** Pre-resolved vault state. Skips RPC fetch if fresh enough (see maxCacheAgeMs). */
  cachedState?: ResolvedVaultState;
  /** Max age in ms for cachedState before re-resolving. Default: 30_000 (30s). */
  maxCacheAgeMs?: number;
  /** Additional agent ATA → vault ATA replacements for multi-token DeFi routes. */
  additionalAtaReplacements?: Map<Address, Address>;
}

export interface SealResult {
  ok: true;
  transaction: ReturnType<typeof compileTransaction>;
  /** Whether this action is spending (amount > 0). */
  isSpending: boolean;
  warnings: string[];
  txSizeBytes: number;
  /** Block height after which the blockhash expires. Sign and send before this. */
  lastValidBlockHeight: bigint;
  /** Vault context for downstream drain detection (eliminates double-resolve). */
  vaultContext?: {
    vaultAddress: Address;
    vaultTokenAta: Address;
    tokenBalance: bigint;
    knownRecipients: Set<string>;
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

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
      // Only replace WRITABLE accounts — read-only accounts (authorities, oracles)
      // should keep their original address to avoid instruction malfunction.
      // ATAs in DeFi instructions are always WRITABLE (they receive/send tokens).
      if (
        replacement &&
        (acc.role === AccountRole.WRITABLE ||
          acc.role === AccountRole.WRITABLE_SIGNER)
      ) {
        return { ...acc, address: replacement };
      }
      return acc;
    }),
  }));
}

// ACTION_TYPE_KEYS removed — ActionType enum eliminated in v6.
// Spending is now determined by amount > 0n.

// ─── Shared caches ──────────────────────────────────────────────────────────
// Per-RPC blockhash cache lives in `rpc-helpers.getBlockhashCache(rpc)`; see
// its JSDoc for why we no longer hold a module-level singleton.
const altCache = new AltCache();

// ─── seal() ─────────────────────────────────────────────────────────────────

/**
 * Seal arbitrary DeFi instructions with Sigil security.
 *
 * Sandwiches the provided instructions between validate_and_authorize (before)
 * and finalize_session (after) in an atomic Solana transaction.
 *
 * NOTE: Concurrent calls for the same vault+agent+tokenMint are NOT supported.
 * The on-chain SessionAuthority PDA is deterministic — two concurrent seals
 * produce colliding session PDAs and only one will succeed on-chain.
 *
 * @throws Error if vault is not active, agent lacks permission, protocol not allowed,
 *   spending cap insufficient, or transaction exceeds 1232 byte limit.
 */
export async function seal(params: SealParams): Promise<SealResult> {
  const warnings: string[] = [];
  const net = normalizeNetwork(params.network);
  validateNetwork(net);

  // Step 1: Resolve vault state (with stale cache detection)
  let state: ResolvedVaultState;
  if (params.cachedState) {
    const ageMs =
      (Date.now() / 1000 - Number(params.cachedState.resolvedAtTimestamp)) *
      1000;
    const maxAge = params.maxCacheAgeMs ?? 30_000;
    if (ageMs > maxAge) {
      state = await resolveVaultState(
        params.rpc,
        params.vault,
        params.agent.address,
        undefined,
        net,
      );
    } else {
      state = params.cachedState;
    }
  } else {
    state = await resolveVaultState(
      params.rpc,
      params.vault,
      params.agent.address,
      undefined,
      net,
    );
  }

  // Verify vault is active
  if (state.vault.status !== VaultStatus.Active) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__VAULT_INACTIVE,
      `Vault is not active (status: ${VaultStatus[state.vault.status] ?? state.vault.status})`,
      {
        context: {
          vault: params.vault,
          status:
            String(VaultStatus[state.vault.status]) ??
            String(state.vault.status),
        },
      },
    );
  }

  // Step 2: Validate agent
  const agentEntry = state.vault.agents.find(
    (a) => a.pubkey === params.agent.address,
  );
  if (!agentEntry) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
      `Agent ${params.agent.address} is not registered in vault ${params.vault}`,
      { context: { vault: params.vault, agent: params.agent.address } },
    );
  }
  if (agentEntry.paused) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_PAUSED,
      `Agent ${params.agent.address} is paused in vault ${params.vault}`,
      { context: { vault: params.vault, agent: params.agent.address } },
    );
  }

  // Step 3: Determine spending from amount (ActionType eliminated in v6)
  const spending = params.amount > 0n;
  const U64_MAX = 18446744073709551615n;
  if (params.amount < 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `Amount must be non-negative, got ${params.amount}. ` +
        `Sigil amounts are unsigned 64-bit integers (0 to ${U64_MAX}).`,
      { context: { received: params.amount.toString() } },
    );
  }
  if (params.amount > U64_MAX) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `Amount exceeds u64 maximum, got ${params.amount}. ` +
        `Sigil amounts are unsigned 64-bit integers (0 to ${U64_MAX}).`,
      { context: { received: params.amount.toString() } },
    );
  }

  // Step 4: Strip infrastructure instructions
  const defiInstructions = params.instructions.filter(
    (ix) =>
      ix.programAddress !== COMPUTE_BUDGET_PROGRAM &&
      ix.programAddress !== SYSTEM_PROGRAM,
  );

  // Step 4b: SPL Token blocking — mirrors on-chain scan_instruction_shared().
  // Blocked: Approve(4), ApproveChecked(13), Transfer(3), TransferChecked(12),
  // SetAuthority(6), CloseAccount(9), Burn(8), BurnChecked(15), Token-2022:26.
  for (const ix of defiInstructions) {
    if (
      (ix.programAddress === TOKEN_PROGRAM ||
        ix.programAddress === TOKEN_2022_PROGRAM) &&
      ix.data &&
      ix.data.length > 0
    ) {
      const disc = ix.data[0];
      if (disc === 4) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
          "Top-level SPL Token Approve not allowed in sealed transactions. " +
            "DeFi programs handle approvals via CPI.",
          { context: { operation: "Approve", vault: params.vault } },
        );
      }
      if (disc === 13) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
          "Top-level SPL Token ApproveChecked not allowed in sealed transactions. " +
            "DeFi programs handle approvals via CPI.",
          { context: { operation: "ApproveChecked", vault: params.vault } },
        );
      }
      if (
        disc === 3 ||
        disc === 12 ||
        (ix.programAddress === TOKEN_2022_PROGRAM && disc === 26)
      ) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
          "Top-level SPL Token Transfer not allowed in sealed transactions. " +
            "Token movement from the vault must route through an approved DeFi program's CPI (the policy engine validates the program + instruction). " +
            "Vault withdrawals to the owner are an owner-only operation and cannot be performed by an agent via seal().",
          { context: { operation: "Transfer", vault: params.vault } },
        );
      }
      if (disc === 6 || disc === 9) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
          "Top-level SPL Token SetAuthority/CloseAccount not allowed in sealed transactions. " +
            "These operations could damage or destroy vault token accounts.",
          {
            context: {
              operation: "SetAuthority/CloseAccount",
              vault: params.vault,
            },
          },
        );
      }
      if (disc === 8 || disc === 15) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
          "Top-level SPL Token Burn/BurnChecked not allowed in sealed transactions. " +
            "Delegate burn authority could destroy vault funds.",
          { context: { operation: "Burn/BurnChecked", vault: params.vault } },
        );
      }
    }
  }

  // Step 5: Determine targetProtocol
  const targetProtocol =
    params.targetProtocol ?? defiInstructions[0]?.programAddress;
  if (!targetProtocol) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED,
      "No target protocol: provide targetProtocol or include DeFi instructions",
    );
  }

  // Step 6: Pre-flight checks
  // 6a: Permission check — capability-based (v6: agent must have non-zero capability)
  if (agentEntry.capability === 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
      `Agent ${params.agent.address} has zero capability in vault ${params.vault}`,
      { context: { vault: params.vault, agent: params.agent.address } },
    );
  }

  // 6b: Protocol allowlist (hard error)
  if (!isProtocolAllowed(targetProtocol, state.policy)) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED,
      `Protocol ${targetProtocol} is not allowed by vault policy`,
      { context: { protocol: targetProtocol, vault: params.vault } },
    );
  }

  // 6b2: DeFi instruction count enforcement (mirrors on-chain v&a.rs:325-354)
  if (spending) {
    const defiCount = defiInstructions.filter((ix) =>
      RECOGNIZED_DEFI_PROGRAMS.has(ix.programAddress as string),
    ).length;
    const isStablecoinInput = isStablecoinMint(params.tokenMint, net);
    if (isStablecoinInput && defiCount > 1) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
        "At most 1 recognized DeFi instruction for stablecoin input " +
          "(prevents round-trip fee avoidance).",
        { context: { expected: 1, got: defiCount } },
      );
    }
    if (!isStablecoinInput && defiCount !== 1) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
        "Exactly 1 recognized DeFi instruction required for non-stablecoin input.",
        { context: { expected: 1, got: defiCount } },
      );
    }
  }

  // 6c: Cap headroom — fee-inclusive check (hard error)
  // On-chain finalize_session measures actual_spend which includes fees deducted
  // from the vault balance. SDK must account for fees to avoid submitting TXs
  // that will definitely fail and waste priority fees.
  if (spending && params.amount > 0n) {
    const FEE_DENOM = 1_000_000n;
    const ceilFee = (amount: bigint, rate: bigint): bigint =>
      (amount * rate + FEE_DENOM - 1n) / FEE_DENOM;
    const protocolFee = ceilFee(params.amount, BigInt(PROTOCOL_FEE_RATE));
    const devFee = ceilFee(
      params.amount,
      BigInt(state.policy.developerFeeRate),
    );
    const totalWithFees = params.amount + protocolFee + devFee;
    const headroom = state.globalBudget.remaining;
    if (totalWithFees > headroom) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__CAP_EXCEEDED,
        `Amount ${params.amount} + fees (protocol: ${protocolFee}, dev: ${devFee}) = ${totalWithFees} ` +
          `exceeds remaining daily cap headroom ${headroom}. ` +
          `Reduce amount or wait for rolling window to free capacity.`,
        {
          context: {
            vault: params.vault,
            agent: params.agent.address,
            cap: headroom,
            attempted: totalWithFees,
          },
        },
      );
    }
  }

  // 6d: Position limit check — if vault is at max positions, warn.
  // Without ActionType, we cannot know if this is a position-opening action.
  // On-chain enforces the hard limit; SDK provides a best-effort warning.
  if (
    spending &&
    state.vault.openPositions >= state.policy.maxConcurrentPositions &&
    state.policy.maxConcurrentPositions > 0
  ) {
    warnings.push(
      `Position limit may be reached: ${state.vault.openPositions}/${state.policy.maxConcurrentPositions}. ` +
        `On-chain will reject if this is a position-opening action.`,
    );
  }

  // Step 6e: Non-canonical output stablecoin ATA rejection
  if (
    params.outputStablecoinAccount &&
    spending &&
    !isStablecoinMint(params.tokenMint, net)
  ) {
    const stableMint = net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
    const canonicalAta = await deriveAta(params.vault, stableMint);
    if (params.outputStablecoinAccount !== canonicalAta) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__ATA_NON_CANONICAL,
        `Non-canonical output stablecoin ATA. Expected ${canonicalAta}, ` +
          `got ${params.outputStablecoinAccount}. ` +
          `Use the vault's canonical ATA for balance tracking consistency.`,
        {
          context: {
            expected: canonicalAta,
            got: params.outputStablecoinAccount,
          },
        },
      );
    }
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
      ? deriveAta(params.vault, defaultStableMint).then(async (ata) => {
          // Fix 7: Verify output stablecoin ATA exists to prevent fee burn on missing account
          try {
            const info = await params.rpc
              .getAccountInfo(ata, { encoding: "base64" })
              .send();
            if (!info || !info.value) {
              warnings.push(
                `Output stablecoin ATA ${ata} does not exist on-chain. ` +
                  `Transaction will fail at validate_and_authorize. ` +
                  `Create it first with createAssociatedTokenAccount.`,
              );
            }
          } catch (err: unknown) {
            // Previously silent. Surfacing a warning here makes a transient
            // RPC outage distinguishable from an actually-missing ATA, so
            // the user isn't puzzled when on-chain validation fails with an
            // opaque message a second later.
            const cause = redactCause(err);
            warnings.push(
              `Output stablecoin ATA ${ata} existence check failed due to RPC error (${cause.message ?? cause.name ?? cause.code ?? "unknown"}). Proceeding with derived address — on-chain will reject if missing.`,
            );
          }
          return ata;
        })
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
      if (ataReplacements.has(agentAta)) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__INVALID_PARAMS,
          `additionalAtaReplacements key ${agentAta} conflicts with canonical ` +
            `ATA replacement. Cannot override vault token account mappings.`,
          {
            context: { field: "additionalAtaReplacements", received: agentAta },
          },
        );
      }
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
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol,
    expectedPolicyVersion: state.policy.policyVersion ?? 0n,
  });

  const finalizeIx = await getFinalizeSessionInstructionAsync({
    payer: params.agent,
    vault: params.vault,
    session: sessionPda,
    sessionRentRecipient: params.agent.address,
    agentSpendOverlay: agentOverlayPda,
    vaultTokenAccount,
    outputStablecoinAccount,
  });

  // Step 10: Compose + compile + measure
  const blockhash =
    params.blockhash ?? (await getBlockhashCache(params.rpc).get(params.rpc));

  // Resolve ALTs — Sigil ALT + protocol ALTs (e.g. Jupiter route-specific)
  let addressLookupTables = params.addressLookupTables;
  if (!addressLookupTables) {
    const sigilAlt = getSigilAltAddress(net);
    const allAlts = mergeAltAddresses(sigilAlt, params.protocolAltAddresses);
    addressLookupTables = await altCache.resolve(params.rpc, allAlts);

    // Verify Sigil ALT contents — if stale cache causes mismatch, evict and retry once.
    // This self-heals after ALT extension without requiring manual cache invalidation.
    try {
      verifySigilAlt(
        addressLookupTables,
        sigilAlt,
        getExpectedAltContents(net),
      );
    } catch (e) {
      // Evict stale cache entry and re-resolve from RPC
      altCache.invalidate();
      addressLookupTables = await altCache.resolve(params.rpc, allAlts);
      // Second attempt throws if still mismatched (real corruption, not staleness)
      verifySigilAlt(
        addressLookupTables,
        sigilAlt,
        getExpectedAltContents(net),
      );
    }
  }

  const compiledTx = composeSigilTransaction({
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
    const hasProtocolAlts =
      params.protocolAltAddresses && params.protocolAltAddresses.length > 0;
    throw new SigilRpcError(
      SIGIL_ERROR__RPC__TX_TOO_LARGE,
      `Transaction size ${byteLength} bytes exceeds 1232 byte limit. ` +
        (hasProtocolAlts
          ? `Even with ${params.protocolAltAddresses!.length} protocol ALT(s), the transaction is too large. Reduce instruction count.`
          : `Pass protocolAltAddresses from your DeFi API response (e.g. Jupiter swap-instructions addressLookupTableAddresses).`),
      { context: { byteLength, limit: 1232 } },
    );
  }

  // Build vaultContext for downstream drain detection
  const usdcMintForNet =
    net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const usdtMintForNet =
    net === "devnet" ? USDT_MINT_DEVNET : USDT_MINT_MAINNET;
  let tokenBalance: bigint;
  if (params.tokenMint === usdcMintForNet) {
    tokenBalance = state.stablecoinBalances.usdc;
  } else if (params.tokenMint === usdtMintForNet) {
    tokenBalance = state.stablecoinBalances.usdt;
  } else {
    // Non-stablecoin: fetch actual balance from vault's token ATA.
    // Without this, drain detection is blind (totalVaultBalance=0 skips all checks).
    // We DO NOT silently fall back to 0n — that disables drain detection entirely.
    // If we can't verify the balance, we tell the caller explicitly.
    try {
      const info = await params.rpc
        .getAccountInfo(vaultTokenAccount, { encoding: "base64" })
        .send();
      if (info?.value?.data?.[0]) {
        tokenBalance = parseTokenBalance(info.value.data[0]);
      } else {
        // Account doesn't exist → vault genuinely has 0 tokens of this mint.
        // This is a legitimate state (vault created but not yet funded for this token).
        tokenBalance = 0n;
      }
    } catch (err) {
      // RPC unavailable: use sentinel so any token outflow triggers drain detection.
      // Conservative (intentional false positives) rather than disabling checks.
      tokenBalance = DRAIN_DETECTION_MIN_BALANCE;
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(
        "Failed to fetch non-stablecoin token balance via RPC. " +
          "Drain detection uses minimum balance sentinel (all outflows will be flagged). " +
          `This is a conservative fallback — verify RPC connectivity. Error: ${errMsg}`,
      );
    }
  }

  // Known recipients: ATA addresses that legitimately receive tokens during Sigil TXs.
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
    isSpending: spending,
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

// ─── SigilClient Types ──────────────────────────────────────────────────

export interface SigilClientConfig {
  rpc: Rpc<SolanaRpcApi>;
  vault: Address;
  agent: TransactionSigner;
  network: "devnet" | "mainnet";
  blockhashTtlMs?: number;
  /** Callback invoked on any error during executeAndConfirm(). For telemetry/logging. Error is always rethrown. */
  onError?: (
    error: AgentError,
    context: { action: string; tokenMint: Address; amount: bigint },
  ) => void;
}

/**
 * Options for `client.seal()`.
 *
 * Note: `blockhash` is intentionally omitted — SigilClient manages its own
 * BlockhashCache instance, which is what `invalidateCaches()` actually clears.
 * Use the standalone `seal()` function if you need to supply a custom blockhash.
 */
export interface ClientSealOpts {
  tokenMint: Address;
  amount: bigint;
  targetProtocol?: Address;
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
  sealResult: SealResult;
}

// ─── SigilClient ─────────────────────────────────────────────────────────

/**
 * Primary SDK entry point — stateful client that owns context and caches.
 *
 * Recommended over standalone seal() for production use:
 * - Holds vault, agent, network, and RPC — no state carrying between calls
 * - Blockhash and ALT caches are isolated per client instance
 * - invalidateCaches() clears instance caches that are actually used
 * - Convenience methods delegate to existing stateless functions
 *
 * Cache scoping: SigilClient keeps its own per-instance `BlockhashCache`
 * (configurable via `config.blockhashTtlMs`) so TTL can differ per client.
 * Stateless helpers (`seal()`, `buildOwnerTransaction()`, dashboard
 * mutations) use the process-wide `getBlockhashCache(rpc)` registry
 * instead. Calling `invalidateCaches()` on this client does NOT flush the
 * registry entry for the same RPC, and vice versa — keep the two paths
 * isolated or call `.invalidate()` on both if you need a full flush.
 */
export class SigilClient {
  private readonly blockhashCacheInstance: BlockhashCache;
  private readonly altCacheInstance: AltCache;
  private readonly onErrorCallback?: SigilClientConfig["onError"];
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly agent: TransactionSigner;
  readonly network: "devnet" | "mainnet";

  constructor(config: SigilClientConfig) {
    if (!config.rpc)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "SigilClientConfig.rpc is required",
        { context: { field: "rpc", expected: "Rpc<SolanaRpcApi>" } },
      );
    if (!config.vault)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "SigilClientConfig.vault is required",
        { context: { field: "vault", expected: "Address" } },
      );
    if (!config.agent)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "SigilClientConfig.agent is required",
        { context: { field: "agent", expected: "TransactionSigner" } },
      );
    if (!config.network)
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "SigilClientConfig.network is required",
        { context: { field: "network", expected: "'devnet' | 'mainnet'" } },
      );

    this.rpc = config.rpc;
    this.vault = config.vault;
    this.agent = config.agent;
    this.network = config.network;
    this.blockhashCacheInstance = new BlockhashCache(config.blockhashTtlMs);
    this.altCacheInstance = new AltCache();
    this.onErrorCallback = config.onError;
  }

  /**
   * Seal DeFi instructions with Sigil security.
   *
   * Pre-resolves blockhash and ALTs from instance caches, then delegates
   * to the standalone seal() function. This ensures invalidateCaches()
   * actually clears caches that are read (N-2 fix).
   */
  async seal(
    instructions: Instruction[],
    opts: ClientSealOpts,
  ): Promise<SealResult> {
    // Parallelize blockhash + ALT resolution (both independent RPC calls)
    const altPromise = opts.addressLookupTables
      ? Promise.resolve(opts.addressLookupTables)
      : this.altCacheInstance.resolve(
          this.rpc,
          mergeAltAddresses(
            getSigilAltAddress(normalizeNetwork(this.network)),
            opts.protocolAltAddresses,
          ),
        );

    let [blockhash, addressLookupTables] = await Promise.all([
      this.blockhashCacheInstance.get(this.rpc),
      altPromise,
    ]);

    // Defense-in-depth: verify Sigil ALT contents even when pre-resolved.
    // On-chain constraints are the real security boundary, but this catches
    // stale ALT data or SDK-layer corruption before the transaction is sent.
    // If stale cache causes mismatch, evict and retry once (self-healing).
    if (!opts.addressLookupTables) {
      const net = normalizeNetwork(this.network);
      const sigilAlt = getSigilAltAddress(net);
      const expected = getExpectedAltContents(net);
      try {
        verifySigilAlt(addressLookupTables, sigilAlt, expected);
      } catch (err: unknown) {
        // Cache-corruption self-healing — evict and retry once. Log the
        // redacted cause so the "why did this retry" signal isn't lost
        // silently; if we see this in telemetry, it means the ALT on
        // chain was updated or the cache was serving stale data.
        const cause = redactCause(err);
        console.debug(
          `[seal] ALT cache verify failed — invalidating and retrying: ${cause.message ?? cause.name ?? cause.code ?? "unknown"}`,
        );
        this.altCacheInstance.invalidate();
        const allAlts = mergeAltAddresses(sigilAlt, opts.protocolAltAddresses);
        addressLookupTables = await this.altCacheInstance.resolve(
          this.rpc,
          allAlts,
        );
        verifySigilAlt(addressLookupTables, sigilAlt, expected);
      }
    }

    return seal({
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
   * Seal + sign + send + confirm in one call.
   *
   * Uses the same signing pattern as TransactionExecutor.signSendConfirm()
   * (transaction-executor.ts:236-265).
   */
  async executeAndConfirm(
    instructions: Instruction[],
    opts: ClientSealOpts & { confirmOptions?: SendAndConfirmOptions },
  ): Promise<ExecuteResult> {
    try {
      const result = await this.seal(instructions, opts);
      const encoded = await signAndEncode(this.agent, result.transaction);
      const signature = await sendAndConfirmTransaction(
        this.rpc,
        encoded,
        opts.confirmOptions,
      );
      return { signature, sealResult: result };
    } catch (err) {
      const sdkError = toSigilAgentError(err);
      this.onErrorCallback?.(sdkError, {
        action: opts.amount > 0n ? "spending" : "non-spending",
        tokenMint: opts.tokenMint,
        amount: opts.amount,
      });
      throw sdkError;
    }
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
    return resolveVaultStateForOwner(
      this.rpc,
      this.vault,
      undefined,
      this.networkFull,
    );
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

  static async createVault(
    opts: CreateVaultOptions,
  ): Promise<CreateVaultResult> {
    return createVault(opts);
  }
}
