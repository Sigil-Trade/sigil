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
import {
  compileTransaction,
  AccountRole,
  fetchEncodedAccounts,
} from "./kit-adapter.js";
import { getSigilModuleLogger, setSigilModuleLogger } from "./logger.js";
import {
  newCorrelationId,
  invokeHook,
  composeHooks,
  type SealHookContext,
} from "./hooks.js";
import {
  runPlugins,
  validatePluginList,
  type SigilPolicyPlugin,
} from "./plugin.js";

import { VaultStatus } from "./generated/types/vaultStatus.js";
import { getValidateAndAuthorizeInstructionAsync } from "./generated/instructions/validateAndAuthorize.js";
import { getFinalizeSessionInstructionAsync } from "./generated/instructions/finalizeSession.js";
import {
  computeScalarIntentDigest,
  computeSealInputDigest,
} from "./seal/intent-digest.js";
import {
  deriveNetworkIdentity,
  type SigilCaip2Chain,
} from "./caip2-network.js";

import {
  resolveVaultState,
  resolveVaultStateForOwner,
  resolveVaultBudget,
  bytesToAddress,
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
  SIGIL_ERROR__SDK__INVALID_NETWORK,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_ALLOWED,
  SIGIL_ERROR__SDK__PROTOCOL_NOT_TARGETED,
  SIGIL_ERROR__SDK__INSTRUCTION_COUNT,
  SIGIL_ERROR__SDK__CAP_EXCEEDED,
  SIGIL_ERROR__SDK__ATA_NON_CANONICAL,
  SIGIL_ERROR__SDK__SEAL_FAILED,
  SIGIL_ERROR__SDK__HOOK_ABORTED,
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
  SIGIL_ERROR__RPC__TX_FAILED,
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
  /**
   * The mint being ACQUIRED on a STABLECOIN-input swap (the swap output).
   *
   * REQUIRED for stablecoin-input acquiring swaps: the on-chain M1 gate (error
   * 6112) mandates that the acquired token land in a VAULT-OWNED account that
   * strictly increases. The SDK derives the vault's canonical ATA for this mint,
   * pins it on validate + finalize, and rewrites the DeFi swap's output
   * destination to it. Sigil never infers what the agent is buying — omitting
   * this on a stablecoin-input swap throws. Must differ from `tokenMint`.
   * Not used for non-stablecoin-input swaps (those use `outputStablecoinAccount`).
   */
  outputSwapMint?: Address;
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
  /**
   * Sprint 2 (B3): optional lifecycle hooks. Observe-only except
   * `onBeforeBuild` which may return `{ skipSeal: true, reason }` to
   * cleanly abort before any RPC. Hook throws are caught and logged
   * via `getSigilModuleLogger().warn` — they do NOT propagate.
   */
  hooks?: import("./hooks.js").SealHooks;
  /**
   * Sprint 2 (B3): stable correlation ID. When omitted, `seal()`
   * generates one via `newCorrelationId()` at the top of the call.
   */
  correlationId?: string;
  /**
   * @internal
   *
   * Sprint 2 (B4): policy plugins threaded from `SigilClientConfig.plugins`
   * via `clientSeal`. Bare-seal callers SHOULD NOT pass plugins here —
   * plugins are client-level configuration that already goes through
   * `validatePluginList()` at client construction. Direct use of this
   * field bypasses that validation.
   *
   * Not exposed on `ClientSealOpts` (by design — prevents per-call
   * plugin override). Only `clientSeal` injects this field after the
   * `...opts` spread so per-call callers cannot override the set of
   * client-level plugins for a single seal invocation.
   */
  plugins?: readonly SigilPolicyPlugin[];
}

/**
 * Result of building (but NOT sending) a Sigil-sealed transaction.
 *
 * `SealResult` is a BUILD-time artifact — it carries the compiled transaction
 * and pre-flight diagnostics. It does NOT include emitted events: events come
 * from on-chain `emit!()` calls during execution, parseable from the resulting
 * transaction's log messages.
 *
 * To consume events, call `executeAndConfirm()` (returns `ExecuteResult` with
 * the signature) and then fetch + parse the transaction logs using the
 * discriminator map in `generated/event-discriminators.ts` (which covers all
 * Phase 3-8 events including AutoRevoked, SandwichIntegrityViolation,
 * ProtectedWritableRejected, StableFloorViolation, RecipientCapExceeded,
 * MintDeltaCapExceeded, AtaAuthorityChanged, OutputBelowFloor,
 * DeclarationInconsistent, OwnershipTransferInitiated/Accepted/Cancelled,
 * and FreezeVaultEvent with `freeze_reason`).
 *
 * `intentDigest` is the AL3 per-call SealInput digest — SHA-256 over the
 * canonical encoding of (vault, agent, mint, amount, target_protocol,
 * network, instructions[]). See `sdk/kit/src/seal/intent-digest.ts` for the
 * canonical-encoding spec. Callers that want intent-binding (Phase 9 Batch I)
 * can surface this digest in their preview UI and re-verify it at
 * execute-time via `computeSealInputDigest(...)`.
 */
export interface SealResult {
  ok: true;
  transaction: ReturnType<typeof compileTransaction>;
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
  /**
   * AL3 per-call intent digest (Phase 9 Batch I). 32-byte SHA-256 over the
   * canonical SealInput encoding. Surfaces the exact intent the SDK sealed,
   * so consumers (preview UIs, executeSeal re-verification) can bind owner
   * approval to this specific bundle.
   */
  intentDigest: Uint8Array;
  /**
   * AL4 network identity (Phase 9 Batch J). CAIP-2 chain id of the network
   * the bundle targets. Carries enough information to differentiate
   * mainnet from devnet (and, in future, testnet / localnet) for UI
   * confirmation prompts. The chain id is bound into AL3's `intentDigest`
   * via `network_id` at canonical position 2 (intent-digest.ts), so a
   * bundle approved on devnet cannot be replayed on mainnet without
   * detection.
   */
  network: SigilCaip2Chain;
  /**
   * AL4 isMainnet boolean (Phase 9 Batch J). `true` only when `network`
   * matches the canonical mainnet-beta CAIP-2 chain id. Wire to UI
   * confirmation chrome (mainnet warning banner, etc).
   */
  isMainnet: boolean;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** One decoded account as returned by `fetchEncodedAccounts`. */
type FetchedAccount = Awaited<ReturnType<typeof fetchEncodedAccounts>>[number];

/** A readonly account meta appended to an instruction's remaining_accounts. */
type ReadonlyMeta = { address: Address; role: AccountRole };

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

/**
 * F-Q4 satisfier helper — resolve the mints of VAULT-OWNED Token-2022 token
 * accounts among the sandwiched DeFi instruction's writable accounts.
 *
 * The on-chain F-Q4 gate (`validate_and_authorize` → `destination_check`) vets
 * the mint EXTENSIONS of any vault-owned Token-2022 token account a swap
 * delivers into the vault — a PermanentDelegate / TransferHook /
 * ConfidentialTransfer mint could let a third party drain or hide the holding
 * out-of-band. To do so it reads the token account's mint (bytes[0..32]) and
 * REQUIRES that mint resolvable in validate's `remaining_accounts`, else it
 * reverts `ErrToken2022OutputMintUnresolvable` (6106). The F-Q1a writable set
 * does NOT carry the mint (a mint is read-only in a swap), so this resolves it.
 *
 * Mirrors the on-chain demand EXACTLY (destination_check.rs:166-219): an account
 * triggers the gate iff it is owned by the Token-2022 program, has >= 72 bytes,
 * and its token-account authority (bytes[32..64]) is the vault. For each such
 * account this returns its mint (bytes[0..32]) as a READONLY meta.
 *
 * It is PLUMBING, not enforcement: it only adds read-only classification
 * accounts; the on-chain gate stays the sole enforcer. A mint missed here can
 * only cause a fail-closed 6106 revert (never a drain); a mint added that the
 * gate does not demand is harmless (the gate looks it up by pubkey on demand).
 *
 * @param fetched     results of `fetchEncodedAccounts` over the candidate
 *                    writable accounts (each carries its own on-chain bytes).
 * @param vault       the vault PDA — only token accounts it authorizes are vetted.
 * @param alreadySeen pubkeys already appended to remaining_accounts (the F-Q1a
 *                    writable set) — skip re-adding them.
 * @returns deduped READONLY metas, one per distinct vault-owned T22 output mint.
 */
export function resolveT22OutputMintMetas(
  fetched: ReadonlyArray<FetchedAccount>,
  vault: Address,
  alreadySeen: ReadonlySet<Address>,
): ReadonlyMeta[] {
  const metas: ReadonlyMeta[] = [];
  const mintSeen = new Set<Address>();
  for (const acc of fetched) {
    // Non-existent on-chain (e.g. a lagging RPC view): the gate can only demand
    // a mint for an account it reads as a vault-owned T22 token account.
    if (!acc.exists) continue;
    // Only Token-2022-owned accounts can be vault-owned T22 token accounts.
    if (acc.programAddress !== TOKEN_2022_PROGRAM) continue;
    // Mirror the on-chain length guard (destination_check.rs:180) BEFORE any
    // slice — a token account's base layout is 165+ bytes; <72 cannot be one.
    if (acc.data.length < 72) continue;
    // Token-account authority ("owner" field, bytes[32..64]); only accounts the
    // VAULT authorizes are the swap's deliver-into-vault target.
    const authority = bytesToAddress(acc.data.slice(32, 64));
    if (authority !== vault) continue;
    // The acquired token's mint (bytes[0..32]) — what the gate vets + demands.
    const mint = bytesToAddress(acc.data.slice(0, 32));
    if (alreadySeen.has(mint) || mintSeen.has(mint)) continue;
    mintSeen.add(mint);
    metas.push({ address: mint, role: AccountRole.READONLY });
  }
  return metas;
}

/**
 * M3-01 satisfier helper (derivation half) — the vault's canonical USDC + USDT
 * associated token accounts that finalize's `stable_balance_floor` must see.
 *
 * The on-chain floor (finalize_session) sums the vault's combined USDC+USDT
 * balance and counts ONLY each stablecoin's CANONICAL ATA (M3-01 pin). Sources
 * 1+2 (the named vaultTokenAccount + outputStablecoinAccount) cover the session
 * token and — sometimes — USDC, so a vault that holds reserve in the OTHER
 * stablecoin would under-count and falsely revert. This derives both canonical
 * stablecoin ATAs and drops any already present on finalize (a named account or
 * the F-Q1a writable set); the remainder are fed to finalize's
 * remaining_accounts (on-chain "Source 3").
 *
 * Pure derivation (no RPC) — existence is checked separately — so it is
 * trivially testable. `deriveAta` is legacy-SPL (correct for the current
 * USDC/USDT mints; a Token-2022 stablecoin would need a T22-aware derivation,
 * matching the on-chain SCOPE note in finalize_session.rs).
 */
export async function deriveStablecoinFloorCandidates(
  vault: Address,
  usdcMint: Address,
  usdtMint: Address,
  alreadyPresent: ReadonlySet<Address>,
): Promise<Address[]> {
  const [usdcAta, usdtAta] = await Promise.all([
    deriveAta(vault, usdcMint),
    deriveAta(vault, usdtMint),
  ]);
  return [usdcAta, usdtAta].filter((ata) => !alreadyPresent.has(ata));
}

/**
 * M3-01 satisfier helper (existence half) — given the fetched candidate
 * accounts (parallel to `candidates`), return the EXISTING ones as READONLY
 * metas for finalize's remaining_accounts. A non-existent ATA is harmless
 * on-chain (the floor skips any non-token-program account), but we omit it to
 * save wire bytes. Mirrors the F-Q4 `resolveT22OutputMintMetas` existence gate.
 */
export function resolveStablecoinFloorMetas(
  fetched: ReadonlyArray<FetchedAccount>,
  candidates: ReadonlyArray<Address>,
): ReadonlyMeta[] {
  const metas: ReadonlyMeta[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (fetched[i]?.exists) {
      metas.push({ address: candidates[i], role: AccountRole.READONLY });
    }
  }
  return metas;
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

  // ─── Sprint 2 B3: build hook context + invoke onBeforeBuild ──────────────
  //
  // Context is populated ONCE at the top of seal() so every subsequent hook
  // invocation references the same `correlationId`. onBeforeBuild is the
  // only hook that may abort: returning `{ skipSeal: true, reason }` throws
  // SigilSdkDomainError(HOOK_ABORTED) before any RPC round-trip.
  const _hookCtx: SealHookContext = {
    vault: params.vault,
    agent: params.agent.address,
    tokenMint: params.tokenMint,
    amount: params.amount,
    network: params.network,
    correlationId: params.correlationId ?? newCorrelationId(),
  };
  if (params.hooks?.onBeforeBuild) {
    const abortResult = await invokeHook(
      params.hooks,
      "onBeforeBuild",
      _hookCtx,
      params,
    );
    if (
      abortResult &&
      typeof abortResult === "object" &&
      "skipSeal" in abortResult &&
      abortResult.skipSeal === true
    ) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__HOOK_ABORTED,
        `seal() aborted by onBeforeBuild hook: ${String(abortResult.reason)}`,
        {
          context: {
            hook: "onBeforeBuild",
            reason: String(abortResult.reason),
            correlationId: _hookCtx.correlationId,
          },
        },
      );
    }
  }

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

  // ─── Sprint 2 (B4): run policy plugins ────────────────────────────────────
  //
  // Plugins receive a frozen, redacted snapshot of the resolved vault state.
  // Design notes:
  //   - Ordering: AFTER resolveVaultState + vault-active + agent-registered
  //     + agent-not-paused gates. 2 of 3 real plugin categories (rate
  //     limiting, compliance) require state; running before state would
  //     degrade those to stateless-only.
  //   - Redaction: owner pubkey, full agents[] roster, vault_id, and raw
  //     SpendTracker epochs are intentionally NOT exposed. Plugins see
  //     only what's needed for policy decisions (budget + capability
  //     + vault status). Reduces malicious-plugin exfiltration surface.
  //   - Freeze: outer state + each nested object is frozen via
  //     Object.freeze. Mutation attempts throw in strict mode, silent
  //     no-op in sloppy — neither is a working bypass.
  //   - Rejection: runPlugins throws SigilSdkDomainError(PLUGIN_REJECTED)
  //     on first { allow: false } or plugin throw. The onError hook
  //     fires via executeAndConfirm's catch block on the way out.
  if (params.plugins && params.plugins.length > 0) {
    await runPlugins(params.plugins, {
      vault: params.vault,
      agent: params.agent.address,
      tokenMint: params.tokenMint,
      amount: params.amount,
      network: params.network,
      instructions: params.instructions,
      correlationId: _hookCtx.correlationId,
      state: Object.freeze({
        globalBudget: Object.freeze({ ...state.globalBudget }),
        agentBudget: state.agentBudget
          ? Object.freeze({ ...state.agentBudget })
          : null,
        vaultStatus: state.vault.status,
        capabilityTier: agentEntry.capability,
        maxTransactionUsd: state.maxTransactionUsd,
        resolvedAtTimestamp: state.resolvedAtTimestamp,
      }),
    });
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

  // Step 6d (was 6e): Non-canonical output stablecoin ATA rejection
  // Position-limit check removed — counter system deleted per council decision
  // (9-1 vote, 2026-04-19). Spending caps + per-protocol caps are the
  // load-bearing safety; position count is not tracked on-chain.
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

  // Step 7a-M1 (err 6112): on a STABLECOIN-input acquiring swap, the on-chain
  // finalize gate MANDATES that the acquired token land in a VAULT-OWNED account
  // that strictly increased. seal() must (a) pin that vault-owned output account
  // on validate + finalize and (b) rewrite the swap's output destination (the
  // agent's ATA for the acquired mint) to it. The caller declares the acquired
  // mint via `outputSwapMint` — Sigil never infers what the agent is buying.
  const needsOutputSwap =
    spending &&
    isStablecoinMint(params.tokenMint, net) &&
    defiInstructions.length > 0;
  let outputSwapAccount: Address | undefined;
  let agentSwapAta: Address | undefined;
  if (needsOutputSwap) {
    if (!params.outputSwapMint) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
        `Stablecoin-input acquiring swap requires \`outputSwapMint\` (the mint ` +
          `being acquired). The on-chain M1 gate (error 6112) requires the swap ` +
          `output to land in a vault-owned account; pass the acquired mint so the ` +
          `SDK can pin the vault's ATA. Sigil does not infer what the agent is buying.`,
        { context: { field: "outputSwapMint" } },
      );
    }
    if (params.outputSwapMint === params.tokenMint) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
        `\`outputSwapMint\` must differ from the input \`tokenMint\` (${params.tokenMint}) — ` +
          `a swap must acquire a DIFFERENT mint (on-chain 6112 requires mint != input).`,
        { context: { field: "outputSwapMint", received: params.outputSwapMint } },
      );
    }
    const [vaultSwapAta, agentSwapAtaDerived] = await Promise.all([
      deriveAta(params.vault, params.outputSwapMint),
      deriveAta(params.agent.address, params.outputSwapMint),
    ]);
    // Existence check (mirrors the F-Q8 output-stablecoin check): finalize reads
    // this ATA's post-CPI balance delta, so a missing account reverts on-chain.
    // Surface a warning rather than failing silently.
    try {
      const info = await params.rpc
        .getAccountInfo(vaultSwapAta, { encoding: "base64" })
        .send();
      if (!info || !info.value) {
        warnings.push(
          `Vault output-swap ATA ${vaultSwapAta} (mint ${params.outputSwapMint}) ` +
            `does not exist on-chain. The acquiring swap will fail at finalize ` +
            `(M1 gate 6112). Create it first with createAssociatedTokenAccount.`,
        );
      }
    } catch (err: unknown) {
      const cause = redactCause(err);
      warnings.push(
        `Vault output-swap ATA ${vaultSwapAta} existence check failed due to RPC ` +
          `error (${cause.message ?? cause.name ?? cause.code ?? "unknown"}). ` +
          `Proceeding with the derived address — on-chain will reject if missing.`,
      );
    }
    outputSwapAccount = vaultSwapAta;
    agentSwapAta = agentSwapAtaDerived;
  }

  // Step 7b: Replace agent ATAs with vault ATAs in DeFi instructions
  const ataReplacements = new Map<Address, Address>();
  ataReplacements.set(agentTokenAta, vaultTokenAccount);
  if (agentStablecoinAta && outputStablecoinAccount) {
    ataReplacements.set(agentStablecoinAta, outputStablecoinAccount);
  }
  // M1: route the acquiring swap's output to the vault's ATA (not the agent's).
  if (agentSwapAta && outputSwapAccount) {
    ataReplacements.set(agentSwapAta, outputSwapAccount);
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

  // F-Q1a SATISFIER (not enforcer). The on-chain destination COMPLETENESS
  // invariant requires every writable, non-vault account of the sandwiched
  // DeFi instruction to be resolvable in validate's AND finalize's
  // remaining_accounts, so the guard can read each owner byte and classify it
  // (an absent writable meta is now rejected fail-closed:
  // DestinationAccountUnresolvable). Reviving the per-recipient cap + floor sum
  // depends on the same accounts reaching finalize. We extract every writable
  // account of the *rewritten* DeFi ixs (post agent-ATA->vault-ATA rewrite, so
  // the addresses are exactly what executes — iterating the pre-rewrite list
  // would capture stale agent ATAs) and attach them as READONLY remaining
  // accounts on both wrapper ixs. READONLY grants no write/sign; the compiled
  // message de-dups by pubkey (mergeRoles keeps the DeFi ix's WRITABLE), and
  // accounts already referenced by the DeFi ix cost ~1 index byte each. This
  // only gives the guard visibility — it never changes the route or intent
  // (atomic-guard principle: feed accounts to inspect, never reshape the tx).
  const feePayer = params.agent.address;
  const defiWritableSeen = new Set<Address>();
  const defiWritableReadonlyMetas: ReadonlyMeta[] = [];
  for (const ix of rewrittenDefiInstructions) {
    for (const acc of ix.accounts ?? []) {
      const declaredWritable =
        acc.role === AccountRole.WRITABLE ||
        acc.role === AccountRole.WRITABLE_SIGNER;
      // The fee-payer agent is WRITABLE in the compiled v0 message regardless of
      // the role the DeFi ix declares for it. The on-chain completeness check
      // reads writability from the compiled message (via
      // load_instruction_at_checked), so a DeFi ix that lists the agent as a
      // readonly signer still surfaces it as a writable meta on-chain — include
      // it so completeness is satisfiable. (Vault ATAs that validate marks
      // writable already appear writable in the swap ix, so the fee payer is the
      // only writability divergence between the ix role and the compiled view.)
      const onChainWritable = declaredWritable || acc.address === feePayer;
      if (onChainWritable && !defiWritableSeen.has(acc.address)) {
        defiWritableSeen.add(acc.address);
        defiWritableReadonlyMetas.push({
          address: acc.address,
          role: AccountRole.READONLY,
        });
      }
    }
  }

  // F-Q4 SATISFIER — vault-owned Token-2022 output-mint resolution.
  //
  // When a swap delivers a Token-2022 token INTO a vault-owned ATA, the on-chain
  // F-Q4 gate (validate_and_authorize → destination_check) vets that mint's
  // extensions and REQUIRES the mint resolvable in validate's remaining_accounts
  // (else `ErrToken2022OutputMintUnresolvable` 6106). The F-Q1a writable set
  // above does NOT carry it (a mint is read-only in a swap), so resolve + append
  // it here. Validate is the SOLE consumer — finalize_session does not run
  // destination_check — so these go on validate ONLY.
  //
  // PERF GATE (sound + fail-closed): only fetch when the Token-2022 program
  // appears in the bundle. Writing a vault Token-2022 account REQUIRES invoking
  // Token-2022, and any invoked program must appear in the invoking ix's account
  // list — so a vault-owned T22 account can never be written without T22 showing
  // up here. If this gate were ever wrong it can only SKIP the fetch → an honest
  // T22 swap reverts 6106 (fail-closed DX), never a bypass. Classic-SPL swaps
  // (the common case) skip the fetch entirely, and existing classic/mock seal
  // tests never trigger the extra RPC round-trip.
  //
  // Rule B: this gate is NON-WEIGHTING on security — under-fire is impossible
  // (the program that touches a vault T22 account is always present in the
  // invoking ix's account metas, so the scan cannot miss it), so the round-trip
  // saving never trades against the (fail-closed) security feed. No pre-flight
  // warning is emitted: a gate skip cannot coincide with a vault T22 write, and
  // detecting one would require the very fetch the gate is optimizing away.
  let t22OutputMintReadonlyMetas: ReadonlyMeta[] = [];
  const bundleTouchesToken2022 = rewrittenDefiInstructions.some(
    (ix) =>
      ix.programAddress === TOKEN_2022_PROGRAM ||
      (ix.accounts ?? []).some((acc) => acc.address === TOKEN_2022_PROGRAM),
  );
  if (bundleTouchesToken2022 && defiWritableReadonlyMetas.length > 0) {
    // One batched getMultipleAccounts over the (<=24) writable DeFi accounts.
    const candidateAddresses = defiWritableReadonlyMetas.map((m) => m.address);
    let fetchedCandidates;
    try {
      fetchedCandidates = await fetchEncodedAccounts(
        params.rpc,
        candidateAddresses,
      );
    } catch (err) {
      // Fail CLOSED with CONTEXT (not swallow-and-continue): if the bundle
      // delivers a Token-2022 token into the vault, feeding no mint would make
      // the on-chain gate revert 6106 — a far more opaque failure. Surface a
      // domain-typed, step-named error so the caller knows it was the F-Q4
      // output-mint resolution that failed (mirrors how the sibling stablecoin-
      // ATA and balance fetches contextualize their RPC errors).
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__SEAL_FAILED,
        "F-Q4 output-mint resolution failed: could not fetch the swap's " +
          "writable accounts to detect vault-owned Token-2022 outputs. If the " +
          "bundle delivers a Token-2022 token into the vault, on-chain " +
          "validation would revert 6106 (ErrToken2022OutputMintUnresolvable). " +
          "Retry once the RPC is reachable.",
        { context: { candidateAddresses, cause: redactCause(err) } as never },
      );
    }
    t22OutputMintReadonlyMetas = resolveT22OutputMintMetas(
      fetchedCandidates,
      params.vault,
      defiWritableSeen,
    );
  }

  // Step 8: Build validate_and_authorize instruction.
  //
  // AC-10 (Phase 4): pass `expectedNonce = 0n`. The session PDA is created
  // via `init` (not `init_if_needed`) on every validate, so a fresh session
  // account starts at nonce=0. The on-chain handler requires
  // `session.nonce == expected_nonce`, so callers MUST pass 0 in the
  // steady-state flow. Phase 8 ownership-transfer flow (M-5) reuses the
  // same field with non-close semantics; that path will resolve the stored
  // value off-chain before calling `seal`.
  //
  // D-1 + D-6 (Bucket 2 audit 2026-05-21): AL3 scalar intent digest. We
  // compute SHA-256 over the canonical SealInput SCALARS (magic prefix +
  // intent_version + network + vault + agent + token_mint + amount +
  // target_protocol) — the on-chain verifier in `validate_and_authorize`
  // recomputes the same digest from its handler args and rejects on byte-
  // equal mismatch with `ErrIntentDigestMismatch` (6102). This closes the
  // preview→execute scalar-tamper class (recipient/amount/mint/protocol
  // swap between the user's signed preview and the submitted bundle).
  // The full ix-bound digest (`computeSealInputDigest` above) remains
  // client-side only — ATA-rewrite mapping for on-chain ix binding is
  // v0.17 work.
  const scalarIntentDigest = computeScalarIntentDigest({
    vault: params.vault,
    agent: params.agent.address,
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol,
    network: params.network,
  });
  const validateIxBase = await getValidateAndAuthorizeInstructionAsync({
    agent: params.agent,
    vault: params.vault,
    agentSpendOverlay: agentOverlayPda,
    vaultTokenAccount,
    tokenMintAccount: params.tokenMint,
    protocolTreasuryTokenAccount,
    feeDestinationTokenAccount,
    outputStablecoinAccount,
    outputSwapAccount,
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol,
    expectedPolicyVersion: state.policy.policyVersion ?? 0n,
    expectedNonce: 0n,
    expectedIntentDigest: scalarIntentDigest,
  });

  // F-Q1a satisfier: append the DeFi ix's writable accounts (as READONLY) to
  // validate's remaining_accounts so the on-chain completeness invariant is
  // satisfiable. Spread into a NEW array — Instruction.accounts is readonly.
  const validateIx: Instruction = {
    ...validateIxBase,
    accounts: [
      ...(validateIxBase.accounts ?? []),
      ...defiWritableReadonlyMetas,
      // F-Q4: vault-owned Token-2022 output mints (validate-only consumer; the
      // on-chain gate searches remaining_accounts positionally, so append even
      // when a mint is also a named account such as the input tokenMintAccount).
      ...t22OutputMintReadonlyMetas,
    ],
  };

  const finalizeIxBase = await getFinalizeSessionInstructionAsync({
    payer: params.agent,
    vault: params.vault,
    session: sessionPda,
    sessionRentRecipient: params.agent.address,
    agentSpendOverlay: agentOverlayPda,
    vaultTokenAccount,
    outputStablecoinAccount,
    outputSwapAccount,
  });

  // M3-01: feed the vault's other canonical stablecoin ATA(s) into finalize so
  // the combined USDC+USDT stable_balance_floor sees the vault's FULL stablecoin
  // holdings. On-chain Sources 1+2 only cover the session token + the output
  // stablecoin, so a vault holding reserve in the OTHER stablecoin would
  // under-count and falsely revert ErrStableFloorViolation. Only canonical ATAs
  // count on-chain (M3-01 pin), so feeding exactly those is sufficient + minimal.
  // Gated on stable_balance_floor > 0 — the default (no floor) adds no accounts
  // and no RPC. Existence-checked + de-duped against named/fed metas.
  let stablecoinFloorMetas: ReadonlyMeta[] = [];
  // Coerce defensively: the resolver always decodes this as a bigint, but a
  // hand-built cachedState could pass a number/null (the pending-mutation form
  // of this field uses null). BigInt(x ?? 0n) gates correctly for all of them
  // so the satisfier never SILENTLY skips when a floor is actually set.
  if (BigInt(state.policy.stableBalanceFloor ?? 0n) > 0n) {
    const usdcMintForFloor =
      net === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
    const usdtMintForFloor =
      net === "devnet" ? USDT_MINT_DEVNET : USDT_MINT_MAINNET;
    const alreadyPresent = new Set<Address>([
      vaultTokenAccount,
      ...(outputStablecoinAccount ? [outputStablecoinAccount] : []),
      ...defiWritableReadonlyMetas.map((m) => m.address),
    ]);
    const floorCandidates = await deriveStablecoinFloorCandidates(
      params.vault,
      usdcMintForFloor,
      usdtMintForFloor,
      alreadyPresent,
    );
    if (floorCandidates.length > 0) {
      try {
        const fetchedFloor = await fetchEncodedAccounts(
          params.rpc,
          floorCandidates,
        );
        // fetchEncodedAccounts is contractually length-preserving; if a
        // malformed RPC response ever returned fewer entries, the index-parallel
        // existence filter would drop an ATA silently. Surface it (the drop is
        // still fail-safe: a missing ATA only makes the floor stricter).
        if (fetchedFloor.length !== floorCandidates.length) {
          warnings.push(
            `M3-01 stable-floor: RPC returned ${fetchedFloor.length} of ` +
              `${floorCandidates.length} requested stablecoin ATA(s); any ` +
              `omitted ATA is dropped from the floor (over-strict, never a bypass).`,
          );
        }
        stablecoinFloorMetas = resolveStablecoinFloorMetas(
          fetchedFloor,
          floorCandidates,
        );
      } catch (err: unknown) {
        // Resilient, NOT silent: the on-chain floor still enforces — feeding no
        // extra ATA only makes it stricter (fail-safe), never a bypass. Surface
        // a warning so a vault holding reserve in the OTHER stablecoin can
        // explain a possible on-chain ErrStableFloorViolation. Mirrors the
        // output-stablecoin ATA existence check above.
        const cause = redactCause(err);
        warnings.push(
          `M3-01 stable-floor ATA resolution failed due to RPC error (${cause.message ?? cause.name ?? cause.code ?? "unknown"}). ` +
            `Proceeding without the extra stablecoin ATA(s); if this vault holds ` +
            `reserve in the non-session stablecoin, finalize may revert ` +
            `ErrStableFloorViolation. Retry once the RPC is reachable.`,
        );
      }
    }
  }

  // F-Q1a satisfier: finalize's per-recipient cap + floor sum walk the SAME
  // DeFi metas and resolve them in finalize's own remaining_accounts, so the
  // writable accounts must reach finalize too (validate and finalize each carry
  // their own remaining_accounts).
  const finalizeIx: Instruction = {
    ...finalizeIxBase,
    accounts: [
      ...(finalizeIxBase.accounts ?? []),
      ...defiWritableReadonlyMetas,
      ...stablecoinFloorMetas,
    ],
  };

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

  // ─── Sprint 2 (B3): onBeforeSign hook ──────────────────────────────────────
  //
  // Fires once the transaction is fully composed and size-verified, before
  // seal() returns it to the caller (executeAndConfirm will then sign +
  // send). Observe-only — mutations to compiledTx have no effect on what
  // seal() returns. A hook throw is swallowed + logged via invokeHook's
  // existing semantics (same as the other observe-only hooks).
  //
  // Single fire-point: composed hooks (from executeAndConfirm) propagate
  // through clientSeal → seal() via the opts spread, so firing here
  // covers all three entry paths (executeAndConfirm, SigilVault.execute,
  // bare seal()) with exactly one invocation per seal.
  await invokeHook(params.hooks, "onBeforeSign", _hookCtx, compiledTx);

  // AL3 — Phase 9 Batch I per-call intent digest. Computed over the
  // user-approved (vault, agent, mint, amount, target_protocol, network,
  // instructions[]) projection. Excludes wallet-side mutations (Compute
  // Budget ixs prepended later by signers) so the digest reflects exactly
  // what the user approved, not what the wallet wrapped around it.
  const intentDigest = computeSealInputDigest({
    vault: params.vault,
    agent: params.agent.address,
    tokenMint: params.tokenMint,
    amount: params.amount,
    targetProtocol: params.targetProtocol,
    network: params.network,
    instructions: defiInstructions,
  });

  // AL4 — Phase 9 Batch J network identity. CAIP-2 chain id + derived
  // isMainnet boolean. The chain id is also bound into the AL3 digest
  // above via the network_id byte, so a mainnet bundle cannot be
  // replayed on devnet (and vice versa) without producing a different
  // intentDigest.
  const networkIdentity = deriveNetworkIdentity(params.network);

  return {
    ok: true,
    transaction: compiledTx,
    warnings,
    txSizeBytes: byteLength,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    vaultContext: {
      vaultAddress: params.vault,
      vaultTokenAta: vaultTokenAccount,
      tokenBalance,
      knownRecipients,
    },
    intentDigest,
    network: networkIdentity.network,
    isMainnet: networkIdentity.isMainnet,
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
  /**
   * Structured logger for SDK-internal diagnostics (ALT cache warnings,
   * RPC retries, shield advisories, etc.). When provided to
   * `SigilClient.create()`, it is installed via `setSigilModuleLogger()`
   * so every leaf utility in the SDK routes output through it.
   *
   * Default: `NOOP_LOGGER` — no output.
   *
   * For local development, pass `createConsoleLogger()`. For production,
   * wrap your preferred structured logger (pino, bunyan, OpenTelemetry)
   * in the `SigilLogger` interface shape.
   */
  logger?: import("./logger.js").SigilLogger;
  /**
   * Skip the `getGenesisHash()` network assertion at client construction.
   *
   * **Do not set this in production.** The assertion prevents a very
   * common misconfiguration — pointing a mainnet-built SDK instance at a
   * devnet RPC (or vice versa) — from reaching transaction submission,
   * where it would silently succeed against the wrong cluster and drain
   * funds that weren't supposed to move.
   *
   * Opt-outs are provided only for two narrow cases:
   *   - Local Surfpool / LiteSVM test harnesses whose genesis hash does
   *     not match the canonical devnet or mainnet hashes.
   *   - CI jobs where the RPC is stubbed entirely.
   *
   * When set to `true`, a deprecation-tier warning is emitted via the
   * injected logger so the bypass is observable in audit trails.
   */
  skipGenesisAssertion?: boolean;
  /**
   * Sprint 2 (B3): client-level seal hooks. Fire on every `seal()` +
   * `executeAndConfirm()` call. Compose with per-call hooks
   * (`ClientSealOpts.hooks`) via `composeHooks(clientHooks, perCall)`
   * — client hooks run first.
   */
  hooks?: import("./hooks.js").SealHooks;
  /**
   * Sprint 2 (B4): policy plugins. Run in registration order inside
   * `seal()` pre-flight after `resolveVaultState`; first rejection
   * throws `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`.
   */
  plugins?: readonly import("./plugin.js").SigilPolicyPlugin[];
  /**
   * AL2 mainnet confirmation gate (Phase 9 Batch K). Per Council
   * D-3 this defaults to **`false`** in 0.16.x for back-compat;
   * the default flips to `true` in v1.0.
   *
   * When `true` AND `network === "mainnet"`, every `executeAndConfirm`
   * call requires the per-call opts to carry `mainnetConfirmed: true`
   * or it throws `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED`
   * with full context (vault, network, docs URL, opt-in snippet).
   * Narrow on the string code; there is no numeric alias.
   *
   * When unset on a mainnet client, the SDK emits `console.warn` on
   * every mainnet `executeAndConfirm` to telegraph the v1.0 flip.
   * Set explicitly to `false` to silence the warning during your
   * migration window.
   *
   * Devnet clients ignore this flag entirely — the gate never fires
   * off-mainnet.
   */
  requireMainnetConfirmation?: boolean;
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
  /** Acquired mint for a stablecoin-input swap (M1 / err 6112). See `SealParams.outputSwapMint`. */
  outputSwapMint?: Address;
  protocolAltAddresses?: Address[];
  addressLookupTables?: AddressesByLookupTableAddress;
  cachedState?: ResolvedVaultState;
  maxCacheAgeMs?: number;
  additionalAtaReplacements?: Map<Address, Address>;
  /**
   * Sprint 2 (B3): per-call hooks. Compose with client-level hooks
   * (`SigilClientConfig.hooks`) — client hooks run first, then per-call.
   */
  hooks?: import("./hooks.js").SealHooks;
  /**
   * Sprint 2 (B3): stable correlation ID for trace correlation.
   * Defaults to a fresh `newCorrelationId()` if omitted.
   */
  correlationId?: string;
  /**
   * AL2 explicit mainnet confirmation (Phase 9 Batch K). Pair with
   * `SigilClientConfig.requireMainnetConfirmation: true` to opt into
   * the mainnet gate. When `true`, `executeAndConfirm` on a mainnet
   * client proceeds; when `false` or undefined (with the gate enabled),
   * throws `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED` (legacy
   * numeric code 7020).
   *
   * Devnet clients ignore this flag entirely. Mainnet clients with the
   * gate DISABLED (default in 0.16.x) only `console.warn` if this is
   * undefined — they do not throw. Narrow rejections on the string
   * code `SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED`.
   */
  mainnetConfirmed?: boolean;
}

/**
 * Result of `executeAndConfirm()` — a Sigil-sealed transaction that has been
 * signed, sent, and confirmed on-chain.
 *
 * To consume on-chain events emitted by the sealed transaction (e.g.
 * `OwnershipTransferAccepted`, `FreezeVaultEvent`, `SandwichIntegrityViolation`),
 * fetch the transaction with `rpc.getTransaction(signature)` and parse the log
 * messages against `generated/event-discriminators.ts`. Phase 7 + Phase 8 added
 * 12 new event types; all are present in the discriminator map.
 */
export interface ExecuteResult {
  signature: string;
  sealResult: SealResult;
}

// ─── Factory API (PR 3.A — principled factory migration) ────────────────

/**
 * API surface returned by `createSigilClient()`.
 *
 * This is the recommended entry point for agent-side DeFi execution.
 * The factory carries vault context + caches in a closure, exposing a
 * plain object with bound methods. Tree-shakeable, testable, composable.
 *
 * Pattern matches viem's `createPublicClient()` — functional primitives
 * (`seal()`, `createVault()`) as the real API, factory for ergonomics.
 */
export interface SigilClientApi {
  /** RPC connection carried by the client. */
  readonly rpc: Rpc<SolanaRpcApi>;
  /** Vault address. */
  readonly vault: Address;
  /** Agent signer. */
  readonly agent: TransactionSigner;
  /** Network. */
  readonly network: "devnet" | "mainnet";

  /** Seal DeFi instructions with Sigil security (uses instance caches). */
  seal(instructions: Instruction[], opts: ClientSealOpts): Promise<SealResult>;

  /** Seal + sign + send + confirm in one call. */
  executeAndConfirm(
    instructions: Instruction[],
    opts: ClientSealOpts & { confirmOptions?: SendAndConfirmOptions },
  ): Promise<ExecuteResult>;

  /** Invalidate blockhash + ALT caches. */
  invalidateCaches(): void;

  /** Resolve full vault state. */
  getVaultState(): Promise<ResolvedVaultStateForOwner>;

  /** Resolve the agent's 24h rolling budget. */
  getAgentBudget(): Promise<ResolvedBudget>;

  /** Get vault P&L. */
  getPnL(): Promise<VaultPnL>;

  /** Get vault token balances. */
  getTokenBalances(): Promise<TokenBalance[]>;
}

/**
 * Create a Sigil agent client — the primary SDK entry point for AI agents
 * executing DeFi through vault guardrails.
 *
 * The returned object carries vault context and isolated caches in a
 * closure. It is NOT a class — no `instanceof`, no prototype chain, no
 * `this` binding footguns. Methods are plain closure-bound functions.
 *
 * @example
 * ```ts
 * import { createSigilClient, usd, capability } from "@usesigil/kit";
 *
 * const client = createSigilClient({ rpc, vault, agent, network: "devnet" });
 * const result = await client.executeAndConfirm(instructions, {
 *   tokenMint: USDC_MINT_DEVNET,
 *   amount: usd(500_000_000n),
 * });
 * ```
 */
export function createSigilClient(config: SigilClientConfig): SigilClientApi {
  // Validate config (same checks as the deprecated class constructor)
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

  // Sprint 2 (B4): validate plugin list at client construction.
  // plugin.ts docstring promises this runs in createSigilClient /
  // Sigil.quickstart / Sigil.fromVault. The facade path validates via
  // buildInternalState; the direct createSigilClient path must too, or
  // malformed plugins silently load and only fail at first seal().
  if (config.plugins !== undefined) {
    validatePluginList(config.plugins);
  }

  // C3 fix: install the consumer-supplied logger so leaf utilities (alt-
  // loader, shield, dashboard, tee/verify, etc.) route their warnings
  // through it. Without this call the factory silently drops
  // `config.logger` while the deprecated class constructor installs it.
  if (config.logger) {
    setSigilModuleLogger(config.logger);
  }

  // Private state captured in closure (replaces class private fields)
  const rpc = config.rpc;
  const vault = config.vault;
  const agent = config.agent;
  const network = config.network;
  // §RP Batch K HIGH-2: snapshot AL2 flag at factory entry. Subsequent
  // config.requireMainnetConfirmation mutations cannot disable the
  // gate without recreating the client.
  const requireMainnetConfirmation = config.requireMainnetConfirmation;
  if (network !== "devnet" && network !== "mainnet") {
    // §RP Batch K MEDIUM-1: runtime guard for JS / any-cast consumers
    // that pass `cluster: "mainnet-beta"` etc. Type system catches it in
    // pure TS but `.d.ts` doesn't help JS callers.
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_CONFIG,
      `SigilClientConfig.network must be 'devnet' or 'mainnet'; got ${String(network)}.`,
      { context: { field: "network", expected: "'devnet' | 'mainnet'" } },
    );
  }
  const blockhashCache = new BlockhashCache(config.blockhashTtlMs);
  const localAltCache = new AltCache();
  const onErrorCallback = config.onError;
  const networkFull: Network =
    network === "mainnet" ? "mainnet-beta" : "devnet";

  // H3 fix: define seal as a standalone closure-captured function so
  // executeAndConfirm can call it WITHOUT `this`. This prevents
  // `const { executeAndConfirm } = createSigilClient(cfg)` from
  // crashing with TypeError (destructuring loses `this` binding).
  async function clientSeal(
    instructions: Instruction[],
    opts: ClientSealOpts,
  ): Promise<SealResult> {
    // Pre-resolve blockhash + ALTs from instance caches (parallel)
    const altPromise = opts.addressLookupTables
      ? Promise.resolve(opts.addressLookupTables)
      : localAltCache.resolve(
          rpc,
          mergeAltAddresses(
            getSigilAltAddress(normalizeNetwork(network)),
            opts.protocolAltAddresses,
          ),
        );

    let [resolvedBlockhash, addressLookupTables] = await Promise.all([
      blockhashCache.get(rpc),
      altPromise,
    ]);

    // ALT verify-evict-retry (self-healing cache)
    if (!opts.addressLookupTables) {
      const net = normalizeNetwork(network);
      const sigilAlt = getSigilAltAddress(net);
      const expected = getExpectedAltContents(net);
      try {
        verifySigilAlt(addressLookupTables, sigilAlt, expected);
      } catch (err: unknown) {
        const cause = redactCause(err);
        getSigilModuleLogger().debug(
          `[seal] ALT cache verify failed — invalidating and retrying: ${cause.message ?? cause.name ?? cause.code ?? "unknown"}`,
        );
        localAltCache.invalidate();
        const allAlts = mergeAltAddresses(sigilAlt, opts.protocolAltAddresses);
        addressLookupTables = await localAltCache.resolve(rpc, allAlts);
        verifySigilAlt(addressLookupTables, sigilAlt, expected);
      }
    }

    // Sprint 2 (B4): thread client-level plugins into bare seal(). Injected
    // AFTER the `...opts` spread so per-call callers cannot override the
    // client's plugin set for a single invocation. ClientSealOpts has no
    // `plugins` field (by design) — TypeScript rejects per-call plugin
    // passing at compile time.
    return seal({
      rpc,
      vault,
      agent,
      network,
      instructions,
      ...opts,
      blockhash: resolvedBlockhash,
      addressLookupTables,
      ...(config.plugins ? { plugins: config.plugins } : {}),
    });
  }

  return {
    rpc,
    vault,
    agent,
    network,

    seal: clientSeal,

    async executeAndConfirm(instructions, opts) {
      // AL2 mainnet confirmation gate (Phase 9 Batch K). Three states:
      //   1. Devnet client: ignore the gate entirely — no throw, no warn.
      //   2. Mainnet client + requireMainnetConfirmation: true:
      //      - opts.mainnetConfirmed === true → proceed
      //      - else → throw 7020 with full context
      //   3. Mainnet client + requireMainnetConfirmation undefined (0.16.x
      //      default per D-3):
      //      - opts.mainnetConfirmed === undefined → console.warn (telegraphs
      //        the v1.0 flip) and proceed
      //      - opts.mainnetConfirmed set either way → proceed silently
      //   4. Mainnet client + requireMainnetConfirmation: false → proceed
      //      silently (explicit opt-out; no warn).
      if (network === "mainnet") {
        const gateEnabled = requireMainnetConfirmation === true;
        const explicitOptOut = requireMainnetConfirmation === false;
        const confirmed = opts.mainnetConfirmed === true;
        if (gateEnabled && !confirmed) {
          throw new SigilSdkDomainError(
            SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
            "Mainnet confirmation required — pass `mainnetConfirmed: true` " +
              "in the executeAndConfirm options or set " +
              "`requireMainnetConfirmation: false` on the SigilClientConfig. " +
              "Opt-in: executeAndConfirm(ixs, { ..., mainnetConfirmed: true }). " +
              "Opt-out: createSigilClient({ ..., requireMainnetConfirmation: false }). " +
              "Docs: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md",
            {
              context: {
                vault: vault.toString(),
                network: "mainnet",
              },
            },
          );
        }
        if (
          !gateEnabled &&
          !explicitOptOut &&
          opts.mainnetConfirmed === undefined
        ) {
          // §RP Batch K LOW-2 fix: use the structured logger (respects
          // config.logger) instead of raw console.warn so consumers who
          // installed a custom logger (pino, OpenTelemetry, etc.) capture
          // the warning in their pipeline.
          getSigilModuleLogger().warn(
            "[Sigil] @usesigil/kit 0.16.x defaults `requireMainnetConfirmation` to false. " +
              "v1.0 will flip the default to true; mainnet `executeAndConfirm` calls without " +
              "`mainnetConfirmed: true` will throw SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED. " +
              "Adopt the v1.0 default early by setting " +
              "`requireMainnetConfirmation: true` on SigilClientConfig and passing " +
              "`mainnetConfirmed: true` per call, OR silence this warning by explicitly setting " +
              "`requireMainnetConfirmation: false`. " +
              "See: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md",
          );
        }
      }

      // Sprint 2 B3: compose client-level and per-call hooks. Client hooks
      // run first at every stage (onBeforeBuild → ... → onFinalize), then
      // per-call hooks. composeHooks handles the conditional-merge when
      // either side is absent.
      const composedHooks = composeHooks(config.hooks, opts.hooks);
      const correlationId = opts.correlationId ?? newCorrelationId();
      const hookCtx: SealHookContext = {
        vault,
        agent: agent.address,
        tokenMint: opts.tokenMint,
        amount: opts.amount,
        network,
        correlationId,
      };

      try {
        // Calls the closure-captured clientSeal — no `this` dependency.
        // Safe to destructure: `const { executeAndConfirm } = client`.
        const result = await clientSeal(instructions, {
          ...opts,
          hooks: composedHooks,
          correlationId,
        });
        const encoded = await signAndEncode(agent, result.transaction);
        const signature = await sendAndConfirmTransaction(
          rpc,
          encoded,
          opts.confirmOptions,
        );

        // Sprint 2 B3: onAfterSend fires with the signature as soon as
        // the RPC resolves. onFinalize fires last on the success path.
        await invokeHook(composedHooks, "onAfterSend", hookCtx, signature);
        await invokeHook(composedHooks, "onFinalize", hookCtx, { signature });

        return { signature, sealResult: result };
      } catch (err) {
        const sdkError = toSigilAgentError(err);
        // Sprint 2 B3: onError fires in every failure path before the
        // existing onErrorCallback telemetry hook. Error is always
        // rethrown after both fire.
        await invokeHook(
          composedHooks,
          "onError",
          hookCtx,
          err instanceof Error ? err : new Error(String(err)),
        );
        onErrorCallback?.(sdkError, {
          action: opts.amount > 0n ? "spending" : "non-spending",
          tokenMint: opts.tokenMint,
          amount: opts.amount,
        });
        throw sdkError;
      }
    },

    invalidateCaches() {
      blockhashCache.invalidate();
      localAltCache.invalidate();
    },

    async getVaultState() {
      return resolveVaultStateForOwner(rpc, vault, undefined, networkFull);
    },

    async getAgentBudget() {
      return resolveVaultBudget(rpc, vault, agent.address);
    },

    async getPnL() {
      return getVaultPnL(rpc, vault, networkFull);
    },

    async getTokenBalances() {
      return getVaultTokenBalances(rpc, vault, networkFull);
    },
  };
}

/**
 * Async factory: run the genesis-hash assertion + delegate to
 * {@link createSigilClient}. Returns the factory's `SigilClientApi`
 * (which properly wires plugins, hooks, and caches) — NOT the
 * deprecated `SigilClient` class (which does not wire plugins/hooks).
 *
 * This is what `Sigil.quickstart()` / `Sigil.fromVault()` use under
 * the hood to get both:
 *   - genesis-hash cluster safety (previously only on the class path)
 *   - working plugin + hook wiring (only on the factory path)
 *
 * @param config - Full client config. All fields (plugins, hooks,
 *   logger) are forwarded to the factory after the assertion passes.
 * @throws `SigilRpcError` if `getGenesisHash()` fails after retries.
 * @throws `SigilSdkDomainError(INVALID_CONFIG)` if the cluster hash
 *   does not match `config.network`.
 */
export async function createSigilClientAsync(
  config: SigilClientConfig,
): Promise<SigilClientApi> {
  // Install logger FIRST so `assertGenesisHash` diagnostics route
  // through it. createSigilClient will re-install it (idempotent).
  if (config.logger) {
    setSigilModuleLogger(config.logger);
  }
  if (config.skipGenesisAssertion === true) {
    getSigilModuleLogger().warn(
      "[createSigilClientAsync] skipGenesisAssertion=true — RPC cluster " +
        `is NOT verified against configured network "${config.network}". ` +
        "Only safe for local test harnesses.",
    );
  } else {
    await assertGenesisHash(config.rpc, config.network);
  }
  return createSigilClient(config);
}

// ─── Genesis-hash assertion (D18 — closes F10 cluster mismatch) ─────────────
//
// Every @ usesigil / kit transaction assumes the RPC is on the cluster the
// SDK was configured for. A devnet-configured client hitting a mainnet
// RPC (or vice versa) would silently submit a tx against the wrong
// cluster, deriving ATAs from the wrong stablecoin mints and in the
// worst case succeeding against live funds. getGenesisHash() is the
// canonical cluster discriminant.

/** Canonical devnet genesis hash — Solana cluster identifier. */
export const SOLANA_DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Canonical mainnet-beta genesis hash — Solana cluster identifier. */
export const SOLANA_MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * Module-level cache of observed genesis hashes, keyed by RPC object
 * identity. Lives for the process lifetime; tests reset with
 * `_resetGenesisHashCache()`. Kept as a `let` binding so the reset
 * helper can swap in a fresh WeakMap — `Map`/`WeakMap` don't support
 * per-instance clearing in ways that would let us keep a const.
 *
 * NOTE on caching key (M3 from review): WeakMap uses object identity,
 * so two independent `rpc = await createRpc(url)` calls (e.g., module
 * reload in tests) each pay one `getGenesisHash()` RTT before hitting
 * the cache. Acceptable for long-lived agent processes; documented
 * here so production readers know to hold a single rpc instance.
 */
let _genesisHashCache = new WeakMap<object, string>();

/** @internal — exposed for test resets only. */
export function _resetGenesisHashCache(): void {
  _genesisHashCache = new WeakMap();
}

/**
 * Retry helper — 3 attempts, 200ms exponential backoff. Matches the
 * behavior documented in SDK-REDESIGN-PLAN D4.
 */
async function withRetry<T>(
  op: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 200,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delayMs = baseDelayMs * 2 ** i;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Assert that `rpc.getGenesisHash()` matches the canonical hash for
 * `network`. Throws `SigilRpcError(SIGIL_ERROR__SDK__INVALID_NETWORK)`
 * on mismatch or repeated RPC failure.
 *
 * Results are cached per-RPC-instance via WeakMap so repeated
 * `SigilClient.create()` calls against the same RPC do not re-fetch.
 */
async function assertGenesisHash(
  rpc: Rpc<SolanaRpcApi>,
  network: "devnet" | "mainnet",
): Promise<void> {
  const rpcKey = rpc as unknown as object;
  const cached = _genesisHashCache.get(rpcKey);
  const expected =
    network === "mainnet"
      ? SOLANA_MAINNET_GENESIS_HASH
      : SOLANA_DEVNET_GENESIS_HASH;

  let observed = cached;
  if (!observed) {
    try {
      observed = await withRetry(() => rpc.getGenesisHash().send());
    } catch (err) {
      // RPC transport failure (retries exhausted) → RPC domain error.
      // This is different from C-review C1: the cluster mismatch below
      // is an SDK-domain configuration error, not an RPC transport error.
      throw new SigilRpcError(
        SIGIL_ERROR__RPC__TX_FAILED,
        `getGenesisHash() failed after 3 attempts — cannot verify RPC cluster ` +
          `matches configured network "${network}". Set skipGenesisAssertion: true ` +
          `only if you are using a local validator (Surfpool/LiteSVM) whose ` +
          `genesis does not match devnet or mainnet.`,
        { cause: err, context: { network, attempts: 3 } as never },
      );
    }
    // M7 fix: reject non-string / wrong-length responses — don't cache
    // a malformed hash that would permanently poison subsequent .create()
    // calls for this rpc instance.
    if (typeof observed !== "string" || observed.length < 32) {
      throw new SigilRpcError(
        SIGIL_ERROR__RPC__TX_FAILED,
        `getGenesisHash() returned a malformed response — expected a 44-char ` +
          `base58 string, got ${observed === null ? "null" : typeof observed}. ` +
          `Check that your RPC provider implements the getGenesisHash method.`,
        { context: { network, observed: String(observed) } as never },
      );
    }
    _genesisHashCache.set(rpcKey, observed);
  }

  if (observed !== expected) {
    // Cluster mismatch is an SDK-domain config error, not an RPC error.
    // Consumers narrow on `SigilSdkDomainError + SIGIL_ERROR__SDK__INVALID_NETWORK`
    // to catch this specifically.
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_NETWORK,
      `Genesis hash mismatch — RPC is on a different cluster than configured. ` +
        `Expected "${network}" (${expected}) but RPC returned ${observed}. ` +
        `A common cause: the SDK was built with --features devnet but the RPC URL ` +
        `points at mainnet (or vice versa). Either fix the RPC URL, rebuild the ` +
        `SDK with the matching feature flag, or set skipGenesisAssertion: true ` +
        `(NOT recommended in production).`,
      {
        context: {
          network,
          expected,
          observed,
        } as never,
      },
    );
  }
}

// ─── SigilClient (deprecated class) ─────────────────────────────────────

/**
 * @deprecated Use `createSigilClient(config)` or the async factory
 * `SigilClient.create(config)` instead. This class will be removed at
 * v1.0. The factory returns the same API surface as a plain object with
 * closure-bound methods — no `this` binding issues, tree-shakeable, and
 * aligned with the viem/Kit functional pattern.
 *
 * Migration:
 * ```ts
 * // Before:
 * const client = new SigilClient({ rpc, vault, agent, network });
 * // After (factory):
 * const client = createSigilClient({ rpc, vault, agent, network });
 * // After (async with genesis assertion):
 * const client = await SigilClient.create({ rpc, vault, agent, network });
 * ```
 */
/**
 * Module-private construction token for SigilClient. `SigilClient.create()`
 * is the only holder — direct `new SigilClient(config)` calls from outside
 * the class body cannot obtain this symbol and fail the runtime guard in
 * the private constructor.
 */
const CLIENT_CONSTRUCT_TOKEN: unique symbol = Symbol("SigilClient.construct");

export class SigilClient {
  private readonly blockhashCacheInstance: BlockhashCache;
  private readonly altCacheInstance: AltCache;
  private readonly onErrorCallback?: SigilClientConfig["onError"];
  /**
   * AL2 mainnet confirmation flag, snapshotted at construction (Phase 9
   * Batch K §RP HIGH-2 fix). Captured by value so subsequent
   * `config.requireMainnetConfirmation = ...` mutations cannot silently
   * disable the gate post-construction.
   */
  private readonly requireMainnetConfirmation?: boolean;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly agent: TransactionSigner;
  readonly network: "devnet" | "mainnet";

  /**
   * Private constructor — Sprint 2 carryover.
   *
   * Sprint 1 deprecated `new SigilClient(config)` in favor of the
   * async factory `SigilClient.create(config)` which runs the
   * genesis-hash assertion. Sprint 2 completes the migration by
   * making the constructor `private`: external callers now get a TS
   * compile error, and the runtime guard below throws on JS consumers
   * that cast through `any` to bypass the compile-time check.
   *
   * The class remains exported so:
   *   - `SigilClient.create()` static factory still works.
   *   - `instanceof SigilClient` checks in tests still resolve.
   *   - The type `SigilClient` is still a first-class position.
   *
   * @internal — construction token is a module-private symbol only
   *   `SigilClient.create()` holds a reference to.
   */
  private constructor(
    config: SigilClientConfig,
    _constructToken: symbol = Symbol.for("SigilClient.forbid"),
  ) {
    // Runtime guard: anyone who reaches this constructor without the
    // exact module-private token (i.e., via `any`-cast or JS bypass)
    // gets thrown out. `.create()` passes CLIENT_CONSTRUCT_TOKEN.
    if (_constructToken !== CLIENT_CONSTRUCT_TOKEN) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        "SigilClient: direct construction is not allowed. " +
          "Use `await SigilClient.create(config)` — which also runs the " +
          "genesis-hash assertion — or `createSigilClient(config)` for " +
          "the factory variant.",
        { context: { field: "constructor", expected: "SigilClient.create" } },
      );
    }
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

    if (config.network !== "devnet" && config.network !== "mainnet") {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        `SigilClientConfig.network must be 'devnet' or 'mainnet'; got ${String(config.network)}. Phase 9 Batch K §RP MEDIUM-1 hardens this against JS / any-cast bypass.`,
        { context: { field: "network", expected: "'devnet' | 'mainnet'" } },
      );
    }

    this.rpc = config.rpc;
    this.vault = config.vault;
    this.agent = config.agent;
    this.network = config.network;
    // §RP HIGH-2: snapshot AL2 flag at construction. Post-construction
    // mutation of config.requireMainnetConfirmation cannot disable the
    // gate without recreating the client.
    this.requireMainnetConfirmation = config.requireMainnetConfirmation;
    this.blockhashCacheInstance = new BlockhashCache(config.blockhashTtlMs);
    this.altCacheInstance = new AltCache();
    this.onErrorCallback = config.onError;

    // Install module logger so leaf utilities (alt-loader, shield,
    // dashboard, etc.) route warnings through the consumer's logger.
    // If config.logger is undefined, NOOP_LOGGER remains in place.
    if (config.logger) {
      setSigilModuleLogger(config.logger);
    }
  }

  /**
   * Async factory — constructs a `SigilClient` and asserts the RPC's
   * genesis hash matches the configured `network`. Preferred entry
   * point for production use.
   *
   * Throws `SigilRpcError` if:
   *   - the RPC fails 3 consecutive `getGenesisHash()` attempts, or
   *   - the returned genesis hash does not match the canonical devnet /
   *     mainnet hash.
   *
   * Set `config.skipGenesisAssertion: true` to bypass for local test
   * harnesses (Surfpool, LiteSVM) — a warning is emitted in that case.
   *
   * @example
   * ```ts
   * const client = await SigilClient.create({
   *   rpc, vault, agent, network: "devnet",
   *   logger: createConsoleLogger(),
   * });
   * ```
   */
  static async create(config: SigilClientConfig): Promise<SigilClient> {
    // Install logger first so assertGenesisHash diagnostics route correctly.
    if (config.logger) {
      setSigilModuleLogger(config.logger);
    }

    if (config.skipGenesisAssertion === true) {
      getSigilModuleLogger().warn(
        "[SigilClient.create] skipGenesisAssertion=true — RPC cluster " +
          `is NOT verified against configured network "${config.network}". ` +
          "Only safe for local test harnesses.",
      );
    } else {
      // Assert BEFORE constructing — if genesis check throws, no client
      // with a misconfigured RPC is ever returned to the caller.
      await assertGenesisHash(config.rpc, config.network);
    }

    // Sprint 2 carryover: pass the module-private construction token
    // so the private-ctor runtime guard accepts the call. External
    // callers cannot obtain this symbol and are rejected — forcing
    // them through `.create()` which runs the genesis-hash assertion.
    return new SigilClient(config, CLIENT_CONSTRUCT_TOKEN);
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
        getSigilModuleLogger().debug(
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
    // §RP CRITICAL fix (Batch K): the legacy class path MUST mirror
    // the AL2 gate from `createSigilClient.executeAndConfirm` — otherwise
    // any consumer still on `SigilClient.create()` bypasses the gate on
    // mainnet. Reuses the snapshotted requireMainnetConfirmation field
    // captured at construction (§RP HIGH-2 fix).
    if (this.network === "mainnet") {
      const gateEnabled = this.requireMainnetConfirmation === true;
      const explicitOptOut = this.requireMainnetConfirmation === false;
      const confirmed = opts.mainnetConfirmed === true;
      if (gateEnabled && !confirmed) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
          "Mainnet confirmation required — pass `mainnetConfirmed: true` " +
            "in the executeAndConfirm options or set " +
            "`requireMainnetConfirmation: false` on the SigilClientConfig. " +
            "Opt-in: executeAndConfirm(ixs, { ..., mainnetConfirmed: true }). " +
            "Opt-out: SigilClient.create({ ..., requireMainnetConfirmation: false }). " +
            "Docs: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md",
          {
            context: {
              vault: this.vault.toString(),
              network: "mainnet",
            },
          },
        );
      }
      if (
        !gateEnabled &&
        !explicitOptOut &&
        opts.mainnetConfirmed === undefined
      ) {
        getSigilModuleLogger().warn(
          "[Sigil] @usesigil/kit 0.16.x defaults `requireMainnetConfirmation` to false. " +
            "v1.0 will flip the default to true; mainnet `executeAndConfirm` calls without " +
            "`mainnetConfirmed: true` will throw SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED. " +
            "See: https://github.com/Sigil-Trade/sigil/blob/main/sdk/kit/MIGRATION.md",
        );
      }
    }

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
