/**
 * `@usesigil/kit/previewCreateVault`.
 *
 * Builds a `CreateVaultPreview` that the dashboard split-screen `/onboard`
 * page renders BEFORE the user signs. Wraps the existing `createVault()`
 * + `buildOwnerTransaction()` primitives — does not reinvent PDA derivation,
 * compute-budget construction, or transaction compilation.
 *
 * ## Algorithm
 *
 * 1. **Validate** the config at the API edge. Negative bigints throw
 *    `RangeError`; on-chain hard limits (`MIN_TIMELOCK_DURATION`,
 *    `MAX_DEVELOPER_FEE_RATE`, `MAX_ALLOWED_PROTOCOLS`,
 *    `MAX_ALLOWED_DESTINATIONS`) are mirrored as early throws so the FE
 *    surfaces "your config will be rejected" before signing.
 *    `validateNetwork()` propagates as-is.
 * 2. **Derive 4 PDAs.** `vault` first (it's the seed for the others),
 *    then `policy` / `tracker` / `agent_spend_overlay` in parallel.
 * 3. **Fetch rent** for each PDA size in parallel via
 *    `getMinimumBalanceForRentExemption(size)`. The 4 sizes are pinned to
 *    the on-chain `<account>::SIZE` constants — drift between Rust and TS
 *    is regression-tested.
 * 4. **Build instructions** via `createVault()` (which validates
 *    aggregate caps and rejects owner==agent).
 * 5. **Compile transaction** via `buildOwnerTransaction()` with
 *    `CU_VAULT_CREATION` (400_000) and the caller's optional priority fee.
 * 6. **Compute totalCostUsd** via BigInt-safe math with explicit
 *    mul-before-divide:
 *    `(rentLamports + feeLamports) * solPriceUsd / 1_000_000_000n`.
 *    Units: lamports × (6-decimal-USD per SOL) ÷ (lamports per SOL)
 *      = 6-decimal USD.
 * 7. **Build warnings** for soft-signal issues (cap=0, cap>$1M, allowlist
 *    with no protocols, max-tx > daily-cap). Sorted by `code` ascending so
 *    React keys don't thrash on re-type.
 * 8. **Freeze + return.** The returned object is `Object.freeze`d; the
 *    `pdaList` and `warnings` arrays are also frozen.
 *
 * ## What this does NOT do
 *
 *  - **Submit any transaction.** Preview is read-only RPC: rent + blockhash
 *    + ALT lookup. No `sendTransaction`, no `simulateTransaction`.
 *  - **Sign.** Internally constructs `createNoopSigner(address)` instances
 *    so `buildOwnerTransaction` can compile a fee-payer-bound message.
 *    Wallet adapter signs the returned `unsignedTxBytes` later.
 *  - **Fetch SOL price.** Kit has no oracle. Caller passes
 *    `solPriceUsd: bigint` (6-decimal USD per SOL). Without it, the kit
 *    would have to either pin a default (silent lie) or take an RPC
 *    dependency on a price feed (scope creep).
 */

import type {
  Address,
  AddressesByLookupTableAddress,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
} from "./kit-adapter.js";
import { createNoopSigner } from "./kit-adapter.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getAgentOverlayPDA,
} from "./resolve-accounts.js";
import { createVault } from "./create-vault.js";
import { buildOwnerTransaction } from "./owner-transaction.js";
import { CU_VAULT_CREATION } from "./priority-fees.js";
import {
  validateNetwork,
  SYSTEM_PROGRAM_ADDRESS,
  MAX_DEVELOPER_FEE_RATE,
  MAX_ALLOWED_PROTOCOLS,
  U64_MAX,
  type CapabilityTier,
  type UsdBaseUnits,
  type Network,
  type NetworkInput,
} from "./types.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_PARAMS } from "./errors/codes.js";

// ─── On-chain account sizes (verified against programs/sigil/src/state/*.rs) ─

/**
 * `AgentVault::SIZE` from `programs/sigil/src/state/vault.rs`.
 * Layout: 8 disc + 32 owner + 8 vault_id + 4 vec_prefix + (49 * 10) agents
 *       + 32 fee_destination + 1 status + 1 bump + 8 created_at
 *       + 8 total_transactions + 8 total_volume + 1 active_escrow_count
 *       + 8 total_fees_collected + 8 total_deposited_usd + 8 total_withdrawn_usd
 *       + 8 total_failed_transactions + 1 active_sessions = 634.
 */
const AGENT_VAULT_SIZE = 634;

/**
 * `PolicyConfig::SIZE` from `programs/sigil/src/state/policy.rs`.
 * Layout: 8 disc + 32 vault + 8 daily_cap + 8 max_tx + 1 protocol_mode
 *       + (4 + 32*10) protocols + 2 dev_fee + 2 slippage + 8 timelock
 *       + (4 + 32*10) allowed_destinations + 1 has_constraints
 *       + 1 has_pending_policy + 1 has_protocol_caps
 *       + (4 + 8*10) protocol_caps + 8 session_expiry + 1 bump
 *       + 8 policy_version + 1 has_post_assertions = 822.
 */
const POLICY_CONFIG_SIZE = 822;

/**
 * `SpendTracker::SIZE` from `programs/sigil/src/state/tracker.rs`.
 * Layout: 8 disc + 32 vault + (16 * 144) buckets + (48 * 10) protocol_counters
 *       + 8 last_write_epoch + 1 bump + 7 padding = 2840.
 */
const SPEND_TRACKER_SIZE = 2_840;

/**
 * `AgentSpendOverlay::SIZE` from `programs/sigil/src/state/agent_spend_overlay.rs`.
 * Layout: 8 disc + 32 vault + (232 * 10) entries + 1 bump + 7 padding
 *       + (8 * 10) lifetime_spend + (8 * 10) lifetime_tx_count = 2528.
 */
const AGENT_SPEND_OVERLAY_SIZE = 2_528;

/** Default priority fee when caller doesn't supply one. Conservative. */
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 10_000;

/** `1_000_000_000` lamports per SOL. */
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Microlamports per lamport. */
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** Heuristic: dailyCapUsd above $1,000,000 (6-decimal base units) → warn. */
const DAILY_CAP_HIGH_THRESHOLD = 1_000_000_000_000n;

/**
 * Upper bound for any 6-decimal USD bigint at the public API edge.
 * Re-exported from `types.U64_MAX` (`18_446_744_073_709_551_615n`). The
 * on-chain program stores these as `u64`; values above overflow there. We
 * reject at the kit edge rather than ship a tx the program will reject.
 */
const MAX_USD_BASE_UNITS = U64_MAX;

/** Mirror of `MIN_TIMELOCK_DURATION` (1800) from `state/mod.rs`. */
const MIN_TIMELOCK_DURATION_SECONDS = 1_800n;

/** Mirror of `MAX_ALLOWED_DESTINATIONS` (10) from `state/mod.rs`. */
const MAX_ALLOWED_DESTINATIONS_COUNT = 10;

// `buildOwnerTransaction` itself enforces the Solana 1,232-byte tx-size
// limit and throws `SIGIL_ERROR__RPC__TX_TOO_LARGE` on overflow, so we
// don't duplicate the check here. The `txSizeBytes` field surfaces the
// measured value for FE rendering ("847 / 1232 bytes used").

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Canonical PDA names matching on-chain Anchor `#[account]` struct names.
 * The order in `pdaList` is also the order accounts are `init`'d on-chain
 * by `initialize_vault` — useful for FE rendering "creation order."
 */
export type VaultPdaName =
  | "AgentVault"
  | "PolicyConfig"
  | "SpendTracker"
  | "AgentSpendOverlay";

/**
 * One PDA that the create-vault transaction will create.
 *
 * `sizeBytes` mirrors the on-chain `<Account>::SIZE` constant.
 * `rentLamports` is the per-PDA rent-exempt minimum at current rent rates,
 * computed via `rpc.getMinimumBalanceForRentExemption(sizeBytes)`.
 *
 * Generic over `name` so the `pdaList` tuple type can pin each slot to a
 * specific account class — `pdaList[0]` is `VaultPdaInfo<"AgentVault">`,
 * not just `VaultPdaInfo`. This lets FE indexing into the list narrow the
 * `name` field down to a single literal.
 */
export interface VaultPdaInfo<N extends VaultPdaName = VaultPdaName> {
  readonly name: N;
  readonly address: Address;
  readonly bump: number;
  readonly sizeBytes: number;
  readonly rentLamports: bigint;
}

/**
 * Soft-signal warnings the FE renders inline before the user signs.
 *
 * **Discriminated union by `code`.** Each warning has the exact set of
 * `field` + `suggestedValue` it carries — no optionals to narrow at the
 * FE. The FE switches on `code`:
 *
 * ```ts
 * switch (warning.code) {
 *   case "daily_cap_unusually_high":
 *     // warning.suggestedValue is bigint, never undefined
 *     return `${warning.message} (suggested: $${formatUsd(warning.suggestedValue)})`;
 *   case "no_protocols_approved":
 *     // no suggestedValue here — TS knows
 *     return warning.message;
 * }
 * ```
 *
 * Every warning code is part of the public API — renaming a code is a
 * breaking change. Adding a new code is a minor bump. Hard rules
 * (timelock < 1800, dev fee > 500 bps, etc.) are NOT warnings — they
 * THROW at the API edge. Warnings only signal soft configuration
 * concerns that the program would still accept.
 */
export type PreviewWarning =
  | {
      readonly code: "daily_cap_zero";
      readonly severity: "info";
      readonly message: string;
      readonly field: "dailyCapUsd";
    }
  | {
      readonly code: "daily_cap_unusually_high";
      readonly severity: "warning";
      readonly message: string;
      readonly field: "dailyCapUsd";
      /** Recommended cap (the heuristic threshold). */
      readonly suggestedValue: bigint;
    }
  | {
      readonly code: "no_protocols_approved";
      readonly severity: "warning";
      readonly message: string;
      readonly field: "protocols";
    }
  | {
      readonly code: "max_tx_exceeds_daily_cap";
      readonly severity: "warning";
      readonly message: string;
      readonly field: "maxTxSizeUsd";
      /** Recommended max-tx size (clamped to dailyCapUsd). */
      readonly suggestedValue: bigint;
    };

/**
 * Output of `previewCreateVault`. Ships the dashboard's split-screen
 * `/onboard` right column AND the unsigned transaction the FE passes to
 * the wallet adapter for signing — one call, no second build.
 *
 * The object is `Object.freeze`d at runtime, and so are `pdaList` +
 * `warnings`. Note: `Object.freeze` only protects the property bindings
 * and the array containers — it does NOT freeze the underlying
 * `unsignedTxBytes` buffer (typed-array contents are not frozen by
 * `Object.freeze`). The type is `ReadonlyUint8Array` so consumers using
 * the kit's typed alias get compile-time read-only enforcement; vanilla
 * JS callers can still mutate the bytes. If your call site mutates them,
 * the wallet adapter will sign whatever you mutated to — the kit doesn't
 * (and can't) defend the buffer at runtime.
 */
export interface CreateVaultPreview {
  /**
   * The 4 PDAs `initialize_vault` creates, in canonical on-chain `init`
   * order. Pinned as a length-4 tuple so `pdaList[0].name === "AgentVault"`
   * is type-narrowed and FE indexing doesn't need runtime guards.
   */
  readonly pdaList: readonly [
    VaultPdaInfo<"AgentVault">,
    VaultPdaInfo<"PolicyConfig">,
    VaultPdaInfo<"SpendTracker">,
    VaultPdaInfo<"AgentSpendOverlay">,
  ];
  /** Sum of `pdaList[].rentLamports`. The user sinks this into rent at sign time. */
  readonly rentLamports: bigint;
  /** Compute-unit limit set on the tx. Defaults to `CU_VAULT_CREATION` (400,000). */
  readonly computeUnits: number;
  /** `priorityFeeMicroLamports * computeUnits / 1_000_000` (microLamports → lamports). */
  readonly feeLamports: bigint;
  /** `(rentLamports + feeLamports) * solPriceUsd / 1_000_000_000n` — 6-decimal USD. */
  readonly totalCostUsd: bigint;
  /** Same as `pdaList[0].address` (AgentVault). Convenience field. */
  readonly vaultAddress: Address;
  /**
   * Wire-encoded versioned transaction with empty signature placeholders.
   * `ReadonlyUint8Array` for compile-time immutability via the kit's
   * typed alias. Pass to wallet adapter `.signTransaction(bytes)`.
   */
  readonly unsignedTxBytes: ReadonlyUint8Array;
  /** Wire size in bytes; ≤ 1232 (Solana hard limit; `buildOwnerTransaction` enforces). */
  readonly txSizeBytes: number;
  /**
   * Last block height at which the blockhash embedded in
   * `unsignedTxBytes` is still valid. Sourced from the same blockhash
   * `buildOwnerTransaction` baked into the bytes — no race with cache
   * TTL refresh. FE polls block height to detect stale-blockhash before
   * sign and re-previews if needed.
   */
  readonly lastValidBlockHeight: bigint;
  /** Soft warnings; `undefined` when none fire. Sorted by `code` ascending. */
  readonly warnings?: readonly PreviewWarning[];
}

/**
 * Input config for `previewCreateVault`. Mirrors `CreateVaultOptions`
 * field-for-field where overlap exists, with a few preview-specific
 * additions:
 *
 *  - `owner` is `Address` (preview never signs; we synthesize a noop signer).
 *  - `agentAddress` is `Address` (same reason; named differently to match
 *    the FE↔BE contract §3.3 example shape).
 *  - `solPriceUsd` is REQUIRED (kit has no oracle).
 *
 * `priorityFeeMicroLamports` defaults to `10_000` if omitted —
 * conservative-but-not-zero so the preview's `feeLamports` is realistic
 * without requiring callers to estimate first. Tests pin a value for
 * deterministic assertions.
 */
export interface PreviewCreateVaultConfig {
  /** RPC client for blockhash, rent, and ALT resolution. */
  readonly rpc: Rpc<SolanaRpcApi>;
  /** Owner pubkey. Becomes the fee payer on the unsigned tx. */
  readonly owner: Address;
  /** Initial agent's pubkey (gets registered atomically with vault init). */
  readonly agentAddress: Address;
  /** Network determines stablecoin mints + ALT address. */
  readonly network: NetworkInput;
  /** Vault id (u64). Use `0n` for the first vault per owner. */
  readonly vaultId: bigint;
  /** Vault-wide 24h cap in 6-decimal USD base units. `0n` blocks all spending. */
  readonly dailyCapUsd: bigint;
  /** Per-tx max in 6-decimal USD base units. */
  readonly maxTxSizeUsd: bigint;
  /** Per-agent cap in 6-decimal USD base units. */
  readonly spendingLimitUsd: bigint;
  /** Developer fee in BPS (200 = 0.02%, max `MAX_DEVELOPER_FEE_RATE` = 500). */
  readonly developerFeeRate: number;
  /** Max slippage in BPS (max `MAX_SLIPPAGE_BPS` = 5000). */
  readonly maxSlippageBps: number;
  /** Owner-policy timelock in seconds. Min `MIN_TIMELOCK_DURATION` = 1800. */
  readonly timelockDuration: bigint;
  /** Protocol-mode discriminator: 0 = ALL, 1 = ALLOWLIST, 2 = DENYLIST. */
  readonly protocolMode: 0 | 1 | 2;
  /** Up to 10 protocol program addresses for the (allow|deny)list. */
  readonly protocols: readonly Address[];
  /** Per-protocol caps (6-decimal USD base units). Length must match `protocols`. */
  readonly protocolCaps: readonly bigint[];
  /** Up to 10 destination addresses for agent transfers. */
  readonly allowedDestinations: readonly Address[];
  /** Where collected fees flow. Cannot be the system program (0…0). */
  readonly feeDestination: Address;
  /** Capability tier: 0 = Disabled, 1 = Observer, 2 = Operator. Defaults to 2n. */
  readonly capabilityTier?: 0n | 1n | 2n;
  /**
   * Current SOL price in 6-decimal USD base units.
   * E.g., $250 = `250_000_000n`. Required — kit has no oracle.
   */
  readonly solPriceUsd: bigint;
  /**
   * Priority fee in microLamports per CU. Defaults to `10_000` if omitted.
   * Tests should pass `0` for deterministic feeLamports of 0n.
   */
  readonly priorityFeeMicroLamports?: number;
  /** CU limit override. Defaults to `CU_VAULT_CREATION` (400_000). */
  readonly computeUnits?: number;
  /**
   * Pre-fetched blockhash to skip the RPC `getLatestBlockhash` call.
   * Useful for tests + for FE callers that already have a fresh blockhash
   * from an upstream call.
   */
  readonly blockhash?: { blockhash: string; lastValidBlockHeight: bigint };
  /**
   * Pre-resolved address-lookup tables to skip ALT discovery via RPC.
   * Pass `{}` to disable ALT compression entirely (useful for unit tests
   * that don't want to mock `getMultipleAccounts`). Production callers
   * normally omit this so the kit's ALT cache resolves the canonical
   * Sigil ALT for the given network.
   */
  readonly addressLookupTables?: AddressesByLookupTableAddress;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Generate a `CreateVaultPreview` for the dashboard split-screen `/onboard`
 * flow. See module JSDoc for the algorithm and design rationale.
 *
 * @throws {RangeError} If any bigint config field is negative or any count
 *   exceeds its on-chain maximum, or if `timelockDuration < 1800n`,
 *   or if `developerFeeRate > 500`.
 * @throws {SigilSdkDomainError} If `validateNetwork(config.network)` fails,
 *   if `getMinimumBalanceForRentExemption` returns 0n / undefined,
 *   or if `createVault()` rejects the config (e.g., owner == agent,
 *   spendingLimit > dailyCap aggregate).
 */
export async function previewCreateVault(
  config: PreviewCreateVaultConfig,
): Promise<CreateVaultPreview> {
  // 1. Validate config at the API edge (fail fast, descriptive errors).
  validateConfig(config);

  // Normalize "mainnet-beta" → "mainnet" for createVault / buildOwnerTransaction
  // (which use the short literal type) while still accepting either form.
  const buildNetwork = toBuildNetwork(config.network);

  // 2 + 3. Derive PDAs and fetch rent concurrently.
  //
  // Rent depends on size only, not address — fire all 4 rent RPC fetches
  // in parallel with PDA derivation. PDA derivation is pure CPU (sha256
  // in a 0..255 bump search loop) so overlapping it with network latency
  // removes the serial CPU step from the wall-clock path on hot
  // dashboard re-types.
  //
  // `vault` is the seed for the other three PDAs, so we wrap the
  // dependent chain (`getVaultPDA` → policy/tracker/overlay) in a single
  // async IIFE and `Promise.all` it alongside the rent fetches. Wrapping
  // (rather than `await`-ing the vault PDA up front) keeps the rent
  // promises in a Promise.all from the moment they're created, so a
  // rejecting RPC never produces a transient
  // `PromiseRejectionHandledWarning`.
  const vaultChain = (async () => {
    const [vAddr, vBump] = await getVaultPDA(config.owner, config.vaultId);
    const [policy, tracker, overlay] = await Promise.all([
      getPolicyPDA(vAddr),
      getTrackerPDA(vAddr),
      getAgentOverlayPDA(vAddr, 0),
    ]);
    return { vAddr, vBump, policy, tracker, overlay };
  })();
  const [
    { vAddr, vBump, policy, tracker, overlay },
    vaultRent,
    policyRent,
    trackerRent,
    overlayRent,
  ] = await Promise.all([
    vaultChain,
    fetchRentForSize(config.rpc, AGENT_VAULT_SIZE, "AgentVault"),
    fetchRentForSize(config.rpc, POLICY_CONFIG_SIZE, "PolicyConfig"),
    fetchRentForSize(config.rpc, SPEND_TRACKER_SIZE, "SpendTracker"),
    fetchRentForSize(config.rpc, AGENT_SPEND_OVERLAY_SIZE, "AgentSpendOverlay"),
  ]);
  const vaultAddress = vAddr;
  const vaultBump = vBump;
  const [policyAddress, policyBump] = policy;
  const [trackerAddress, trackerBump] = tracker;
  const [overlayAddress, overlayBump] = overlay;

  // 4. Build the pdaList tuple in deterministic on-chain `init` order.
  const pdaList = Object.freeze([
    makePdaInfo(
      "AgentVault",
      vaultAddress,
      vaultBump,
      AGENT_VAULT_SIZE,
      vaultRent,
    ),
    makePdaInfo(
      "PolicyConfig",
      policyAddress,
      policyBump,
      POLICY_CONFIG_SIZE,
      policyRent,
    ),
    makePdaInfo(
      "SpendTracker",
      trackerAddress,
      trackerBump,
      SPEND_TRACKER_SIZE,
      trackerRent,
    ),
    makePdaInfo(
      "AgentSpendOverlay",
      overlayAddress,
      overlayBump,
      AGENT_SPEND_OVERLAY_SIZE,
      overlayRent,
    ),
  ]) as CreateVaultPreview["pdaList"];
  const rentLamports = vaultRent + policyRent + trackerRent + overlayRent;

  // 5. Build the create-vault instructions. `createVault` validates aggregate
  //    caps and owner≠agent for us; we propagate its throws.
  const ownerSigner = createNoopSigner(config.owner);
  const agentSigner = createNoopSigner(config.agentAddress);
  const createResult = await createVault({
    rpc: config.rpc,
    network: buildNetwork,
    owner: ownerSigner,
    agent: agentSigner,
    permissions:
      config.capabilityTier !== undefined
        ? (config.capabilityTier as CapabilityTier)
        : undefined,
    spendingLimitUsd: config.spendingLimitUsd as UsdBaseUnits,
    dailySpendingCapUsd: config.dailyCapUsd as UsdBaseUnits,
    maxTransactionSizeUsd: config.maxTxSizeUsd as UsdBaseUnits,
    feeDestination: config.feeDestination,
    developerFeeRate: config.developerFeeRate,
    protocols: [...config.protocols],
    protocolMode: config.protocolMode,
    maxSlippageBps: config.maxSlippageBps,
    timelockDuration: Number(config.timelockDuration),
    allowedDestinations: [...config.allowedDestinations],
    vaultId: config.vaultId,
    protocolCaps:
      config.protocolCaps.length > 0 ? [...config.protocolCaps] : undefined,
  });

  // 6. Compile the unsigned transaction.
  const computeUnits = config.computeUnits ?? CU_VAULT_CREATION;
  const priorityFeeMicroLamports =
    config.priorityFeeMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  const ownerTx = await buildOwnerTransaction({
    rpc: config.rpc,
    owner: ownerSigner,
    instructions: [
      createResult.initializeVaultIx,
      createResult.registerAgentIx,
    ],
    network: buildNetwork,
    computeUnits,
    priorityFeeMicroLamports,
    ...(config.blockhash !== undefined ? { blockhash: config.blockhash } : {}),
    ...(config.addressLookupTables !== undefined
      ? { addressLookupTables: config.addressLookupTables }
      : {}),
  });

  // 7. feeLamports: microLamports per CU * CU / 1_000_000. Mul-before-divide
  //    in BigInt to avoid number/bigint mixing.
  const feeLamports =
    (BigInt(priorityFeeMicroLamports) * BigInt(computeUnits)) /
    MICRO_LAMPORTS_PER_LAMPORT;

  // 8. totalCostUsd: mul-before-divide preserves precision down to 1 unit of
  //    6-decimal USD.
  const totalCostUsd =
    ((rentLamports + feeLamports) * config.solPriceUsd) / LAMPORTS_PER_SOL;

  const unsignedTxBytes = base64ToUint8Array(ownerTx.wireBase64);

  // 9. lastValidBlockHeight is sourced from the same blockhash baked into the
  //    wire bytes — never re-read the cache (TTL refresh would race the bytes
  //    the user is about to sign).
  const blockhash = ownerTx.blockhash;

  // 10. Warnings (sorted by code) → undefined when empty so the FE skips
  //     rendering the panel.
  const warningsRaw = buildWarnings(config);
  const warnings =
    warningsRaw.length > 0
      ? (Object.freeze(warningsRaw) as readonly PreviewWarning[])
      : undefined;

  const preview: CreateVaultPreview = {
    pdaList,
    rentLamports,
    computeUnits,
    feeLamports,
    totalCostUsd,
    vaultAddress,
    unsignedTxBytes,
    txSizeBytes: ownerTx.txSizeBytes,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    ...(warnings !== undefined ? { warnings } : {}),
  };
  return Object.freeze(preview);
}

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Build one frozen `VaultPdaInfo` entry for `pdaList`. The literal `name`
 * type is preserved so each tuple slot narrows to its specific account class
 * (e.g. `pdaList[0].name === "AgentVault"`).
 */
function makePdaInfo<N extends VaultPdaName>(
  name: N,
  address: Address,
  bump: number,
  sizeBytes: number,
  rentLamports: bigint,
): VaultPdaInfo<N> {
  return Object.freeze({
    name,
    address,
    bump,
    sizeBytes,
    rentLamports,
  }) as VaultPdaInfo<N>;
}

/**
 * Validate config at the API edge. Throws `RangeError` for value-out-of-range
 * (matches the `composeAgentBootstrap` convention) and lets `validateNetwork`
 * propagate its `SigilSdkDomainError`.
 */
function validateConfig(config: PreviewCreateVaultConfig): void {
  // Network — propagates SigilSdkDomainError if invalid.
  validateNetwork(config.network);

  // Negative bigints. `solPriceUsd` rejects 0n too — kit has no oracle, and
  // a price of 0 silently produces `totalCostUsd === 0n` which the FE
  // would render as "Free". Fail loud.
  if (config.vaultId < 0n) {
    throw new RangeError(`vaultId must be >= 0; received ${config.vaultId}`);
  }
  if (config.dailyCapUsd < 0n) {
    throw new RangeError(
      `dailyCapUsd must be >= 0; received ${config.dailyCapUsd}`,
    );
  }
  if (config.maxTxSizeUsd < 0n) {
    throw new RangeError(
      `maxTxSizeUsd must be >= 0; received ${config.maxTxSizeUsd}`,
    );
  }
  if (config.spendingLimitUsd < 0n) {
    throw new RangeError(
      `spendingLimitUsd must be >= 0; received ${config.spendingLimitUsd}`,
    );
  }
  if (config.solPriceUsd <= 0n) {
    throw new RangeError(
      `solPriceUsd must be > 0n; received ${config.solPriceUsd}. ` +
        `The kit has no oracle — caller must supply a fresh, positive price.`,
    );
  }
  if (config.timelockDuration < 0n) {
    throw new RangeError(
      `timelockDuration must be >= 0; received ${config.timelockDuration}`,
    );
  }

  // Upper bounds — `u64::MAX` overflow guards. The on-chain program stores
  // these as `u64`; values above `(1 << 64) - 1` overflow there. Reject at
  // the kit edge.
  if (config.dailyCapUsd > MAX_USD_BASE_UNITS) {
    throw new RangeError(
      `dailyCapUsd must be <= u64::MAX (${MAX_USD_BASE_UNITS}); received ${config.dailyCapUsd}`,
    );
  }
  if (config.maxTxSizeUsd > MAX_USD_BASE_UNITS) {
    throw new RangeError(
      `maxTxSizeUsd must be <= u64::MAX; received ${config.maxTxSizeUsd}`,
    );
  }
  if (config.spendingLimitUsd > MAX_USD_BASE_UNITS) {
    throw new RangeError(
      `spendingLimitUsd must be <= u64::MAX; received ${config.spendingLimitUsd}`,
    );
  }
  if (config.solPriceUsd > MAX_USD_BASE_UNITS) {
    throw new RangeError(
      `solPriceUsd must be <= u64::MAX; received ${config.solPriceUsd}`,
    );
  }

  // `timelockDuration` is a bigint at the API but createVault takes a
  // number. Number can lose precision above 2^53. Reject silently-lossy
  // values rather than ship a tx with a different timelock than the user
  // typed.
  if (config.timelockDuration > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `timelockDuration must be <= Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); ` +
        `received ${config.timelockDuration}. Larger values lose precision in the bigint→number cast.`,
    );
  }

  // On-chain hard limits — mirror as early throws.
  if (config.timelockDuration < MIN_TIMELOCK_DURATION_SECONDS) {
    throw new RangeError(
      `timelockDuration must be >= ${MIN_TIMELOCK_DURATION_SECONDS}n (MIN_TIMELOCK_DURATION); ` +
        `the on-chain program rejects shorter timelocks. Received ${config.timelockDuration}.`,
    );
  }
  if (
    !Number.isInteger(config.developerFeeRate) ||
    config.developerFeeRate < 0
  ) {
    throw new RangeError(
      `developerFeeRate must be a non-negative integer; received ${config.developerFeeRate}`,
    );
  }
  if (config.developerFeeRate > MAX_DEVELOPER_FEE_RATE) {
    throw new RangeError(
      `developerFeeRate must be <= ${MAX_DEVELOPER_FEE_RATE} BPS (MAX_DEVELOPER_FEE_RATE); ` +
        `received ${config.developerFeeRate}`,
    );
  }
  if (!Number.isInteger(config.maxSlippageBps) || config.maxSlippageBps < 0) {
    throw new RangeError(
      `maxSlippageBps must be a non-negative integer; received ${config.maxSlippageBps}`,
    );
  }
  if (config.protocols.length > MAX_ALLOWED_PROTOCOLS) {
    throw new RangeError(
      `protocols.length must be <= ${MAX_ALLOWED_PROTOCOLS} (MAX_ALLOWED_PROTOCOLS); ` +
        `received ${config.protocols.length}`,
    );
  }
  if (config.allowedDestinations.length > MAX_ALLOWED_DESTINATIONS_COUNT) {
    throw new RangeError(
      `allowedDestinations.length must be <= ${MAX_ALLOWED_DESTINATIONS_COUNT} (MAX_ALLOWED_DESTINATIONS); ` +
        `received ${config.allowedDestinations.length}`,
    );
  }
  // protocol_caps when non-empty must align with allowlist mode and length.
  if (config.protocolCaps.length > 0) {
    if (config.protocolMode !== 1) {
      throw new RangeError(
        `protocolCaps requires protocolMode === 1 (ALLOWLIST); received ${config.protocolMode}`,
      );
    }
    if (config.protocolCaps.length !== config.protocols.length) {
      throw new RangeError(
        `protocolCaps.length (${config.protocolCaps.length}) must equal protocols.length (${config.protocols.length})`,
      );
    }
    for (const cap of config.protocolCaps) {
      if (cap < 0n) {
        throw new RangeError(
          `each protocolCaps entry must be >= 0; received ${cap}`,
        );
      }
      if (cap > MAX_USD_BASE_UNITS) {
        throw new RangeError(
          `each protocolCaps entry must be <= u64::MAX; received ${cap}`,
        );
      }
    }
  }

  // `feeDestination` cannot be the system program (Pubkey::default = all-1s
  // base58); the on-chain program rejects it at line 91-93 of
  // initialize_vault.rs with `InvalidFeeDestination`.
  if (config.feeDestination === SYSTEM_PROGRAM_ADDRESS) {
    throw new RangeError(
      `feeDestination must not be the system program ` +
        `(${SYSTEM_PROGRAM_ADDRESS}); the on-chain program rejects it as ` +
        `InvalidFeeDestination`,
    );
  }

  // Optional numeric overrides — must be non-negative integers. Negatives
  // and NaN both produce silent drift (negative fee in preview but skipped
  // on-chain; non-integer throws deep in BigInt(...)).
  if (config.priorityFeeMicroLamports !== undefined) {
    if (
      !Number.isInteger(config.priorityFeeMicroLamports) ||
      config.priorityFeeMicroLamports < 0
    ) {
      throw new RangeError(
        `priorityFeeMicroLamports must be a non-negative integer; received ${config.priorityFeeMicroLamports}`,
      );
    }
  }
  if (config.computeUnits !== undefined) {
    if (!Number.isInteger(config.computeUnits) || config.computeUnits <= 0) {
      throw new RangeError(
        `computeUnits must be a positive integer; received ${config.computeUnits}`,
      );
    }
  }
}

/**
 * Resolve a `NetworkInput` to the `"devnet" | "mainnet"` shape that
 * `createVault` and `buildOwnerTransaction` accept. `validateNetwork` has
 * already gated the input by the time this runs.
 */
function toBuildNetwork(network: NetworkInput): "devnet" | "mainnet" {
  // After validateNetwork, network is one of "devnet", "mainnet", "mainnet-beta".
  // createVault accepts only the short literal; "mainnet-beta" → "mainnet".
  return network === "devnet" ? "devnet" : "mainnet";
}

/**
 * Wrap `getMinimumBalanceForRentExemption` with explicit defensive checks.
 * If the RPC returns `0n` or anything non-bigint, we surface a typed
 * `SigilSdkDomainError` instead of producing a preview that lies about
 * cost. Caller errors propagate with cause attached.
 */
async function fetchRentForSize(
  rpc: Rpc<SolanaRpcApi>,
  size: number,
  pdaName: VaultPdaName,
): Promise<bigint> {
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(size)).send();
  if (typeof rent !== "bigint") {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `getMinimumBalanceForRentExemption returned non-bigint for ${pdaName} (size=${size})`,
      { context: { field: pdaName, received: typeof rent } },
    );
  }
  // Reject 0n AND negatives. Rent must always be positive — a "free" PDA
  // doesn't exist on Solana, and a negative rent is non-physical and would
  // produce a negative `totalCostUsd` (FE displays "you'll be paid to
  // create this vault"). Both indicate a misbehaving RPC; surface as a
  // typed throw so the caller can retry / switch RPC.
  if (rent <= 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `getMinimumBalanceForRentExemption returned ${rent} for ${pdaName} (size=${size}); ` +
        `expected a positive lamport value. RPC may be misconfigured or returning stale data.`,
      { context: { field: pdaName, received: rent } },
    );
  }
  return rent;
}

/**
 * Build the warnings array. Sorted by `code` ascending so the FE's React
 * keys are stable across re-types (no banner flicker). Returns an empty
 * array when nothing fires; the caller converts to `undefined` for the
 * preview shape.
 */
function buildWarnings(config: PreviewCreateVaultConfig): PreviewWarning[] {
  const warnings: PreviewWarning[] = [];

  if (config.dailyCapUsd === 0n) {
    warnings.push({
      code: "daily_cap_zero",
      severity: "info",
      message:
        "Daily spending cap is 0. The vault will accept deposits but the " +
        "agent cannot execute any spending action until the cap is raised.",
      field: "dailyCapUsd",
    });
  }

  if (config.dailyCapUsd > DAILY_CAP_HIGH_THRESHOLD) {
    warnings.push({
      code: "daily_cap_unusually_high",
      severity: "warning",
      message:
        "Daily spending cap exceeds $1,000,000 — confirm this matches the " +
        "intended risk tolerance.",
      field: "dailyCapUsd",
      suggestedValue: DAILY_CAP_HIGH_THRESHOLD,
    });
  }

  if (config.protocolMode === 1 && config.protocols.length === 0) {
    warnings.push({
      code: "no_protocols_approved",
      severity: "warning",
      message:
        "Protocol mode is ALLOWLIST but no protocols are listed; the agent " +
        "cannot reach any DeFi protocol with this policy.",
      field: "protocols",
    });
  }

  if (config.maxTxSizeUsd > config.dailyCapUsd) {
    warnings.push({
      code: "max_tx_exceeds_daily_cap",
      severity: "warning",
      message:
        "Max transaction size exceeds daily cap; a single transaction can " +
        "consume the entire 24h budget.",
      field: "maxTxSizeUsd",
      suggestedValue: config.dailyCapUsd,
    });
  }

  // Sort by code ascending so the FE's React keys stay stable.
  warnings.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  // Freeze each warning so callers can't mutate after return. The cast
  // preserves the discriminated-union type Object.freeze would erase to
  // `Readonly<PreviewWarning>`.
  return warnings.map((w) => Object.freeze(w) as PreviewWarning);
}

/**
 * Decode a base64 string to `Uint8Array`. Uses `atob` (built-in in browser
 * and Node ≥ 16) so the kit stays Node-only-free. Validates input shape
 * defensively — `atob` will throw `InvalidCharacterError` on non-base64.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Re-export `Network` so consumers importing `PreviewCreateVaultConfig`
 * have the related type for narrowing without a second import.
 */
export type { Network };
