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
import { getRegisterAgentInstructionAsync } from "./generated/instructions/registerAgent.js";
import { getQueueAgentGrantInstructionAsync } from "./generated/instructions/queueAgentGrant.js";
import { fetchMaybePendingAgentGrant } from "./generated/accounts/pendingAgentGrant.js";
import {
  getVaultPDA,
  getPolicyPDA,
  getAgentOverlayPDA,
  getPendingAgentGrantPDA,
} from "./resolve-accounts.js";
import { findNextVaultId } from "./inscribe.js";
import {
  FULL_PERMISSIONS,
  CAPABILITY_OPERATOR,
  SINGLE_KEY_OPERATOR_DELAY_FLOOR,
  toInstruction,
  type CapabilityTier,
  type UsdBaseUnits,
} from "./types.js";
import { computePolicyPreviewDigest } from "./policy/compute-policy-preview-digest.js";
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
  /**
   * Advisory max slippage in basis points (default 100 = 1%). ADVISORY ONLY:
   * `max_slippage_bps` is stored on-chain and bound into the TA-19 policy
   * digest, but the deployed program does NOT reject a swap by realized
   * slippage — the Jupiter slippage check was demolished in Phase 1 and
   * enforcement is delegated to the off-chain SDK / the DeFi instruction's own
   * guard (e.g. Jupiter's `slippageBps`). On-chain spending enforcement is
   * outcome-based: `finalize_session` measures the actual stablecoin balance
   * delta against the caps. Set the real slippage bound on the swap
   * instruction you pass to `seal()`; treat this field as a recorded hint.
   */
  maxSlippageBps?: number;
  /**
   * Phase 2 TA-19: observe-only mode at vault creation. When `true`, all
   * `validate_and_authorize` calls reject with `ObserveOnlyModeBlocksExecute`.
   * Used to stand up a vault that baselines agent behaviour before the owner
   * opens the execute path. Default: `false` (full execute permitted, gated
   * by policy).
   */
  observeOnly?: boolean;
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
  /**
   * PEN-CROSS-2 (Phase 2 close-up): the slot to bind into the TA-19 digest.
   * If omitted, `createVault` reads `rpc.getSlot()` — that's what production
   * callers should do so the digest matches the slot the on-chain handler
   * captures at execution.
   *
   * Tests / fixtures that don't care about replay protection (PDA derivation
   * smoke tests) can pass a fixed bigint here to avoid mocking `getSlot`.
   */
  createdAtSlot?: bigint;
  /**
   * TA-05 (Phase 3): 24-bit UTC operating-hours bitmask. Bit `n` (0..=23)
   * set → spending allowed during UTC hour `n`. Default `0x00FFFFFF` (all
   * 24h enabled — equivalent to "no operating-hours constraint").
   *
   * Upper 8 bits MUST be zero; on-chain handler rejects otherwise with
   * `ErrOutsideOperatingHours` (6084). Bound by TA-19 at canonical
   * digest position 15.
   *
   * Production callers narrowing for market-hours / business-hours
   * vaults should pass an explicit mask (e.g. `0x0001E000` for 13-17 UTC).
   */
  operatingHours?: number;
  /**
   * TA-07 (Phase 3): if true, NEW destinations added via
   * queue_policy_update skip the 24h graylist friction. Default false —
   * the owner pays the friction cost by default. Bound by TA-19 at
   * canonical digest position 16.
   */
  autoPromoteGrays?: boolean;
  /**
   * TA-17 (Phase 3): consecutive-failure threshold after which an
   * agent's capability is auto-revoked. Range 3..=20 (on-chain reject
   * out-of-range with `InvalidPermissions`). Default 5.
   *
   * Only on-chain policy-violation codes 6083-6100 count — external
   * causes (CU exhaustion, nonce desync, auth) do NOT increment.
   * Bound by TA-19 at canonical digest position 17.
   */
  autoRevokeThreshold?: number;

  /**
   * TA-12 (Phase 5 post-execution invariant): hard stable balance floor in
   * USD base units (6 decimals). The combined USDC + USDT vault balance is
   * asserted >= this value at finalize_session AND at agent_transfer's
   * post-CPI re-read. Default 0 = no floor enforcement.
   *
   * Lowering this on a live vault is an elevated mutation per TA-09 and
   * requires cosign (closed by G3 audit fix).
   *
   * Bound by TA-19 at canonical digest position 18.
   */
  stableBalanceFloor?: bigint;

  /**
   * TA-14 (Phase 5 post-execution invariant): per-recipient daily cap in
   * USD base units (6 decimals). Each unique recipient's rolling 24h
   * outflow is asserted <= this value at finalize. Per-recipient slots
   * are bounded at 10 with age-based eviction (no LRU churn).
   *
   * Default 0 = no per-recipient cap (global daily cap still applies).
   * Raising this on a live vault is elevated per TA-09 (closed by G3).
   *
   * Bound by TA-19 at canonical digest position 19.
   */
  perRecipientDailyCapUsd?: bigint;

  /**
   * G6 (audit 2026-05-18 cosign opt-in): owner's opt-in to TA-09 cosign
   * enforcement on elevated mutations. Default `false` (low-friction —
   * owner signature alone authorizes elevated mutations).
   *
   * When `true`, future calls to `queue_policy_update` with elevated
   * mutations require a non-default `cosignSession` pubkey + a
   * corresponding signer in `remaining_accounts`. Use this for solo-key
   * owners who want Sigil-native per-mutation co-signature. Vaults whose
   * owner is a Squads V4 multisig PDA (`detectSquadsV4Owner` returns
   * `isSquadsMultisig: true`) typically leave this `false` because
   * multisig at the Solana layer already enforces multi-signer auth.
   *
   * Disabling cosign on a live vault where this is `true` is itself an
   * elevated mutation (one-way ratchet — `queue_policy_update` requires
   * cosign to flip true → false).
   *
   * Bound by TA-19 at canonical digest position 20.
   */
  cosignRequired?: boolean;

  /**
   * How the FIRST agent is seated when it is requested at OPERATOR capability
   * (`permissions` ≥ 2, which is the default). F-Q6.
   *
   * A freshly-created vault is ALWAYS single-key (EOA owner, cosign off —
   * `initialize_vault` rejects `cosignRequired: true` at creation and sets
   * `owner_type = EOA`). On a single-key vault the program FORBIDS instantly
   * seating an OPERATOR via `register_agent` (reverts 6107
   * `ErrOperatorGrantRequiresTimelock`): the mandatory time-delay is the
   * missing 2nd authorization factor.
   *
   * - `"queued-grant"` (default): compose `[initialize_vault,
   *   queue_agent_grant(agent, OPERATOR)]`. The agent is NOT seated at
   *   creation; the owner calls `apply_agent_grant` after the effective delay
   *   (`SINGLE_KEY_OPERATOR_DELAY_FLOOR` = 600 s for a fresh vault) to activate
   *   it. The returned {@link CreateVaultResult.operatorGrant} carries the
   *   countdown. This is the ONLY path that does not revert for the default
   *   single-key + OPERATOR case.
   * - `"immediate"`: compose `[initialize_vault, register_agent(OPERATOR)]`.
   *   This is legal ONLY for a vault that already carries a 2nd factor
   *   (a bound cosigner, or a multisig owner) at a zero configured delay —
   *   NEITHER of which a freshly-created vault can have. `createVault`
   *   therefore rejects this combination client-side (fail-fast) rather than
   *   emit a transaction guaranteed to revert 6107. Retained for API
   *   symmetry and for OBSERVER/DISABLED first agents (where seating is always
   *   immediate regardless of this flag).
   *
   * Ignored when the first agent's capability is below OPERATOR (OBSERVER /
   * DISABLED) — those seat immediately via `register_agent` with no timelock.
   *
   * @default "queued-grant"
   */
  firstOperatorSeating?: "queued-grant" | "immediate";
}

/**
 * Describes the queued OPERATOR grant emitted on the F-Q6 `"queued-grant"`
 * path so the UI can render an activation countdown ("Operator activates in
 * ~10:00"). Present on {@link CreateVaultResult.operatorGrant} only when the
 * first agent was seated via `queue_agent_grant`.
 */
export interface OperatorGrantInfo {
  /** Always `true` — the grant is queued, not yet applied. */
  queued: true;
  /** The agent the OPERATOR grant was queued for. */
  agent: Address;
  /** The queued capability (OPERATOR = 2). */
  capability: 2;
  /**
   * Effective timelock in seconds the owner must wait before
   * `apply_agent_grant` is accepted. `SINGLE_KEY_OPERATOR_DELAY_FLOOR` (600)
   * for a freshly-created single-key vault.
   */
  delaySeconds: number;
  /**
   * Absolute unix time (seconds) the grant becomes applyable
   * (`queued_at + delaySeconds`). Unknowable at instruction-build time, so
   * `createVault` leaves it `undefined`; `createAndSendVault` populates it
   * from the confirmed on-chain `PendingAgentGrant`.
   */
  appliesAfterUnix?: number;
}

export interface CreateVaultResult {
  vaultAddress: Address;
  vaultId: bigint;
  policyAddress: Address;
  agentOverlayAddress: Address;
  initializeVaultIx: Instruction;
  /**
   * `register_agent` instruction — present ONLY when the first agent is seated
   * directly (OBSERVER/DISABLED capability). `undefined` on the default
   * queued-grant OPERATOR path, where {@link queueAgentGrantIx} is present
   * instead. Prefer {@link instructions} for the ready-to-send composition.
   */
  registerAgentIx?: Instruction;
  /**
   * `queue_agent_grant` instruction — present ONLY on the F-Q6 queued-grant
   * OPERATOR path. Pairs with {@link operatorGrant}.
   */
  queueAgentGrantIx?: Instruction;
  /**
   * The ordered `[initialize_vault, <seat>]` composition for this vault, ready
   * to sign and send. Use this instead of hand-assembling from the individual
   * `*Ix` fields — it always holds the correct second instruction
   * (`register_agent` or `queue_agent_grant`).
   */
  instructions: Instruction[];
  /**
   * Present IFF an OPERATOR grant was queued (the `"queued-grant"` path). Tells
   * the caller the agent is not yet active and carries the activation
   * countdown.
   */
  operatorGrant?: OperatorGrantInfo;
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
  // descriptive error. Granular per-action enforcement is the policy allowlist
  // + post-execution assertions, not the capability field.
  if (options.permissions !== undefined) {
    const cap = options.permissions;
    if (cap < 0n || cap > 2n) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CAPABILITY,
        `Invalid capability ${cap}. The on-chain program expects a 2-bit enum ` +
          `(0 = Disabled, 1 = Observer, 2 = Operator) — not a bitmask. ` +
          `Use FULL_CAPABILITY (2n) for an agent that needs spending authority; ` +
          `granular per-action enforcement is the policy allowlist + assertions.`,
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
  //   - protocolMode defaults to ALLOWLIST (1) — the ONLY mode the V2 program
  //     accepts. Phase 2 Option A deleted the permissive ALL (0) / DENYLIST
  //     modes; `initialize_vault.rs:125` hard-rejects any mode != 1. The old
  //     default of 0 ("all protocols allowed") built an init the deployed
  //     program reverts on, so it is corrected here.
  const maxTransactionSizeUsd =
    options.maxTransactionSizeUsd ?? options.dailySpendingCapUsd;
  const feeDestination = options.feeDestination ?? options.owner.address;
  const protocols = options.protocols ?? [];
  const protocolMode = options.protocolMode ?? 1;

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

  const allowedDestinations = options.allowedDestinations ?? [];
  const observeOnly = options.observeOnly ?? false;

  // F-11 (initialize_vault.rs:190): an ACTIVE (non-observe_only) vault MUST
  // carry at least one protocol OR destination on its allowlist, else the
  // program rejects with `ActiveVaultRequiresAllowlist` (6073) — a vault that
  // allows nothing is silently inert. Fail fast in the SDK with an actionable
  // message rather than letting the owner-signed init revert on-chain.
  if (
    !observeOnly &&
    protocols.length === 0 &&
    allowedDestinations.length === 0
  ) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      "createVault: an active (non-observeOnly) vault must allowlist at least " +
        "one protocol or destination — otherwise the on-chain program rejects " +
        "it as inert (ActiveVaultRequiresAllowlist, 6073). Pass `protocols` " +
        "and/or `allowedDestinations`, or set `observeOnly: true`.",
      {
        context: {
          field: "protocols/allowedDestinations",
          received: { protocolMode, protocols: 0, allowedDestinations: 0 },
        },
      },
    );
  }
  // PEN-CROSS-2 (Phase 2 close-up): the on-chain `initialize_vault` handler
  // captures `Clock::get()?.slot` at handler entry and binds it into the
  // canonical digest. The SDK must encode that same slot in the digest the
  // owner signs. We use the RPC's current slot — typically off by 0-1 from
  // the slot the handler executes in. If a slot rollover lands between
  // `getSlot()` and execution, the user sees a recoverable
  // `PolicyPreviewMismatch` and the SDK consumer retries with a fresh slot.
  //
  // Callers can override `createdAtSlot` for tests / fixtures that don't have
  // a live RPC. Production submission paths should let this RPC-fetch run.
  const createdAtSlot =
    options.createdAtSlot ??
    (await options.rpc.getSlot({ commitment: "confirmed" }).send());
  // Phase 2 TA-19: compute the canonical policy-preview digest off-chain.
  // The on-chain `initialize_vault` handler recomputes this from the resulting
  // policy state and rejects with `PolicyPreviewMismatch` if they differ.
  // session_expiry_seconds is always 0 at init (uses default); has_constraints
  // + has_post_assertions are always 0 at init (constraints are created later).
  const previewDigest = computePolicyPreviewDigest({
    dailySpendingCapUsd: options.dailySpendingCapUsd,
    maxTransactionSizeUsd,
    maxSlippageBps: options.maxSlippageBps ?? 100,
    // PEN-CROSS-6: developer_fee_rate is bound by the digest. Mirror the
    // same default the ix arg uses below to keep digest and storage in sync.
    developerFeeRate: options.developerFeeRate ?? 0,
    protocolMode,
    protocols,
    destinationMode: 0, // Phase 2 Option A: RESTRICTED is the only valid value
    allowedDestinations,
    timelockDuration: BigInt(options.timelockDuration),
    sessionExpirySeconds: 0n,
    observeOnly,
    hasPostAssertions: 0,
    // PEN-CROSS-2: defends against close+reinit replay.
    createdAtSlot,
    // TA-05 (Phase 3): default to all-24h enabled when caller doesn't
    // narrow. Owner-facing config surface for narrowing lives at the
    // dashboard-side mutation (not exposed via createVault yet).
    operatingHours: options.operatingHours ?? 0x00ffffff,
    // TA-07 (Phase 3): default to enforce 24h friction (auto_promote off).
    autoPromoteGrays: options.autoPromoteGrays ?? false,
    // TA-17 (Phase 3): default auto-revoke threshold of 5 — matches the
    // on-chain default constant. Range 3..=20 enforced by the handler.
    autoRevokeThreshold: options.autoRevokeThreshold ?? 5,
    // TA-12 (Phase 5): stable balance floor — hard reserve under which spending
    // is rejected at finalize. Default 0 = no floor enforcement. Bound by digest.
    stableBalanceFloor: options.stableBalanceFloor ?? 0n,
    // TA-14 (Phase 5): per-recipient daily cap. Default 0 = unlimited per recipient
    // (still bounded by the global daily cap). Bound by digest.
    perRecipientDailyCapUsd: options.perRecipientDailyCapUsd ?? 0n,
    // G6 (audit 2026-05-18 cosign opt-in): default false (low-friction).
    // Owners explicitly opt in by passing true. Bound by TA-19 at position 20.
    cosignRequired: options.cosignRequired ?? false,
    // M-1 (audit 2026-06-11): bind per-protocol caps (positions 23-24). The
    // `protocolCaps` value below is exactly what goes on the wire to
    // `initialize_vault`, which derives `has_protocol_caps = !is_empty()` and
    // stores the slice verbatim (initialize_vault.rs:256-257). Mirror that
    // derivation here so the owner-signed digest matches the on-chain
    // recompute. NOTE: the default path fills `protocolCaps` with all-zeros of
    // length === protocols.length (non-empty), so `has_protocol_caps` is TRUE
    // for any vault with ≥1 protocol — the length test below mirrors that.
    hasProtocolCaps: protocolCaps.length > 0,
    protocolCaps,
  });

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
    allowedDestinations,
    protocolCaps,
    observeOnly,
    operatingHours: options.operatingHours ?? 0x00ffffff,
    autoPromoteGrays: options.autoPromoteGrays ?? false,
    autoRevokeThreshold: options.autoRevokeThreshold ?? 5,
    stableBalanceFloor: options.stableBalanceFloor ?? 0n,
    perRecipientDailyCapUsd: options.perRecipientDailyCapUsd ?? 0n,
    // G6 (audit 2026-05-18 cosign opt-in): default false at construction.
    // The arg + the digest above are computed against the same value so
    // the on-chain `initialize_vault` digest assertion passes.
    cosignRequired: options.cosignRequired ?? false,
    previewDigest,
  });

  // Step 5: Seat the first agent (F-Q6). The seating instruction depends on the
  // requested capability and, for OPERATOR, the seating mode.
  //
  // A freshly-created vault is ALWAYS single-key: initialize_vault forces cosign
  // off and sets owner_type = EOA. The program therefore FORBIDS seating an
  // OPERATOR instantly via register_agent (reverts 6107
  // ErrOperatorGrantRequiresTimelock) — the mandatory time-delay is the missing
  // 2nd authorization factor. So the default OPERATOR path composes
  // [initialize_vault, queue_agent_grant]; the owner applies the grant after the
  // 600s floor. OBSERVER/DISABLED agents seat immediately via register_agent.
  const capabilityNum = Number(options.permissions ?? FULL_PERMISSIONS);
  const seating = options.firstOperatorSeating ?? "queued-grant";
  const wantsOperator = capabilityNum >= CAPABILITY_OPERATOR;
  const initInstruction = toInstruction(initializeVaultIx);

  if (wantsOperator && seating === "immediate") {
    // Fail-fast (mirrors the F-11 guard above): instant OPERATOR seating is
    // impossible on the single-key vault createVault produces — it would revert
    // 6107 on-chain. Turn the one-RTT-late devnet rejection into an immediate,
    // descriptive client error.
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      "createVault: firstOperatorSeating='immediate' cannot seat an OPERATOR " +
        "agent on a freshly-created vault. A new vault is always single-key " +
        "(cosign cannot be enabled at initialize_vault and owner_type starts as " +
        "EOA), and the program rejects an instant OPERATOR grant on a single-key " +
        "vault (ErrOperatorGrantRequiresTimelock, 6107). Use the default " +
        "firstOperatorSeating='queued-grant' — it composes [initialize_vault, " +
        "queue_agent_grant] and the owner applies the grant after ~10 min — or " +
        "seat an OBSERVER first and elevate later.",
      {
        context: {
          field: "firstOperatorSeating",
          received: {
            firstOperatorSeating: seating,
            capability: capabilityNum,
          },
        },
      },
    );
  }

  if (wantsOperator) {
    // "queued-grant" (default): [initialize_vault, queue_agent_grant(OPERATOR)].
    // The async builder derives policy / pending / audit_log_success from vault.
    const queueAgentGrantIx = await getQueueAgentGrantInstructionAsync({
      owner: options.owner,
      vault: vaultAddress,
      agent: options.agent.address,
      capability: CAPABILITY_OPERATOR,
      spendingLimitUsd: options.spendingLimitUsd,
    });
    const queueIx = toInstruction(queueAgentGrantIx);
    return {
      vaultAddress,
      vaultId,
      policyAddress,
      agentOverlayAddress,
      initializeVaultIx: initInstruction,
      queueAgentGrantIx: queueIx,
      instructions: [initInstruction, queueIx],
      operatorGrant: {
        queued: true,
        agent: options.agent.address,
        capability: CAPABILITY_OPERATOR,
        // A fresh vault is single-key at operator_grant_delay_seconds == 0, so
        // the effective delay is exactly the single-key floor (600 s).
        delaySeconds: SINGLE_KEY_OPERATOR_DELAY_FLOOR,
      },
    };
  }

  // OBSERVER / DISABLED first agent: seat immediately via register_agent (no
  // timelock). PEN-CROSS-5 (Phase 4 absorption): policy required for the
  // policy_version bump.
  const registerAgentIx = await getRegisterAgentInstructionAsync({
    owner: options.owner,
    vault: vaultAddress,
    policy: policyAddress,
    agentSpendOverlay: agentOverlayAddress,
    agent: options.agent.address,
    capability: capabilityNum,
    spendingLimitUsd: options.spendingLimitUsd,
  });
  const registerIx = toInstruction(registerAgentIx);
  return {
    vaultAddress,
    vaultId,
    policyAddress,
    agentOverlayAddress,
    initializeVaultIx: initInstruction,
    registerAgentIx: registerIx,
    instructions: [initInstruction, registerIx],
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
    instructions: result.instructions,
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

  // F-Q6: on the queued-grant path, read the confirmed PendingAgentGrant to
  // surface the EXACT activation time (`queued_at` is captured on-chain and is
  // unknowable at build time). Best-effort — the grant is queued regardless of
  // this read; the dashboard can also poll getPendingAgentGrant(rpc, vault).
  let operatorGrant = result.operatorGrant;
  if (operatorGrant) {
    try {
      const [pendingPda] = await getPendingAgentGrantPDA(result.vaultAddress);
      const maybe = await fetchMaybePendingAgentGrant(options.rpc, pendingPda);
      if (maybe.exists) {
        operatorGrant = {
          ...operatorGrant,
          appliesAfterUnix: Number(
            maybe.data.queuedAt + maybe.data.minDelaySeconds,
          ),
        };
      }
    } catch {
      // Non-fatal — keep the delaySeconds-only countdown from createVault.
    }
  }

  return { ...result, operatorGrant, signature };
}
