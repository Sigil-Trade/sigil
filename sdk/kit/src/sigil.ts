/**
 * Sigil — top-level facade namespace for `@usesigil/kit`.
 *
 * A pure namespace object (frozen, zero instance state) that wraps the
 * Sprint 1 primitives (`createAndSendVault`, `SigilClient.create`,
 * `createOwnerClient`, `discoverVaults`, `SAFETY_PRESETS`,
 * `VAULT_PRESETS`) into a single import surface so a first-time
 * consumer doesn't need to know which of ~42 root exports are the
 * "real" entry points.
 *
 * Three entry paths:
 *   - `Sigil.quickstart(opts)` — create a new vault on-chain + return
 *     a `SigilVault` handle bound to it, with optional initial funding.
 *   - `Sigil.fromVault({ rpc, address, agent, owner?, network })` —
 *     bind a handle to an existing vault. Runs genesis-hash assertion
 *     via `SigilClient.create()` unless `skipGenesisAssertion: true`.
 *   - `Sigil.discoverVaults(rpc, owner, network)` — enumerate vaults
 *     owned by an address via `dashboard/discover.ts`.
 *
 * `Sigil.presets` re-exports the preset data + composition helpers
 * from Sprint 1's `presets.ts` so `Sigil.presets.safety.development`
 * works without a second import.
 *
 * Not a class, not stateful — tree-shakeable and ordering-safe.
 */

import type { Address, Rpc, SolanaRpcApi } from "./kit-adapter.js";
import type { SigilLogger } from "./logger.js";
import type { SealHooks } from "./hooks.js";
import type { SigilPolicyPlugin } from "./plugin.js";
import type { CreateVaultOptions } from "./create-vault.js";
import type { UsdBaseUnits } from "./types.js";
import type { DiscoveredVault } from "./dashboard/types.js";

import { SigilVault } from "./vault-handle.js";
import type { SigilVaultInternalState } from "./vault-handle.js";
import { createAndSendVault } from "./create-vault.js";
import { createSigilClientAsync, type SigilClientApi } from "./seal.js";
import { createOwnerClient } from "./dashboard/index.js";
import { discoverVaults } from "./dashboard/discover.js";
import { validatePluginList } from "./plugin.js";
import { resolveLogger, NOOP_LOGGER } from "./logger.js";
import {
  SAFETY_PRESETS,
  VAULT_PRESETS,
  applySafetyPreset,
  requireResolvedSafetyPreset,
  presetToCreateVaultFields,
} from "./presets.js";
import { USDC_MINT_DEVNET, USDC_MINT_MAINNET } from "./types.js";

// ─── Options + result types ─────────────────────────────────────────────────

/**
 * Options for `Sigil.quickstart()`. Extends `CreateVaultOptions` with
 * optional funding parameters and facade-level client config (logger,
 * hooks, plugins, skipGenesisAssertion).
 */
export interface SigilQuickstartOptions extends CreateVaultOptions {
  /**
   * Optional — deposit this much `fundingMint` into the new vault
   * immediately after creation. Default: `0n` (no funding; returned
   * `funded: { funded: false, reason: "skipped" }`).
   */
  initialFundingUsd?: UsdBaseUnits;
  /**
   * Mint to deposit if `initialFundingUsd > 0n`. Defaults to USDC on
   * the target network.
   */
  fundingMint?: Address;
  /** Consumer-supplied logger (forwarded to underlying SigilClient). */
  logger?: SigilLogger;
  /** Client-level seal hooks — fire on every `vault.execute()`. */
  hooks?: SealHooks;
  /** Policy plugins — run inside `seal()` pre-flight. */
  plugins?: readonly SigilPolicyPlugin[];
  /** Skip the genesis-hash assertion. Only for Surfpool/LiteSVM harnesses. */
  skipGenesisAssertion?: boolean;
}

/**
 * Discriminated-union outcome for the optional initial funding step
 * in `Sigil.quickstart()`.
 */
export type FundedOutcome =
  | {
      readonly funded: true;
      readonly signature: string;
      readonly amountDepositedUsd: UsdBaseUnits;
    }
  | {
      readonly funded: false;
      readonly reason:
        | "skipped"
        | "insufficient-balance"
        | "rpc-failure"
        | "policy-reject";
      readonly error?: Error;
    };

export interface SigilQuickstartResult {
  readonly vault: SigilVault;
  readonly funded: FundedOutcome;
  /** Signatures from the two on-chain operations that may run. */
  readonly signatures: {
    readonly createVault: string;
    readonly fund?: string;
  };
}

export interface FromVaultOptions {
  rpc: Rpc<SolanaRpcApi>;
  /** On-chain vault PDA address. */
  address: Address;
  agent: import("./kit-adapter.js").TransactionSigner;
  /** Optional — required by lifecycle + fund methods. */
  owner?: import("./kit-adapter.js").TransactionSigner;
  network: "devnet" | "mainnet";
  logger?: SigilLogger;
  hooks?: SealHooks;
  plugins?: readonly SigilPolicyPlugin[];
  skipGenesisAssertion?: boolean;
}

// ─── Presets namespace ──────────────────────────────────────────────────────

/**
 * Preset data + helpers. Points at the same objects as the standalone
 * `presets.ts` exports — the facade simply groups them under
 * `Sigil.presets.*` for discoverability.
 */
const presets = Object.freeze({
  /** Safety presets — timelock + cap defaults. */
  safety: SAFETY_PRESETS,
  /** Use-case presets — policy + capability templates. */
  vault: VAULT_PRESETS,
  applySafetyPreset,
  requireResolvedSafetyPreset,
  presetToCreateVaultFields,
} as const);

// ─── Facade implementation ──────────────────────────────────────────────────

/**
 * Build a `SigilVault` internal state bundle from raw inputs. Shared
 * between `quickstart()` and `fromVault()` so both paths go through
 * the same validation + client construction.
 */
async function buildInternalState(args: {
  rpc: Rpc<SolanaRpcApi>;
  vault: Address;
  agent: import("./kit-adapter.js").TransactionSigner;
  owner?: import("./kit-adapter.js").TransactionSigner;
  network: "devnet" | "mainnet";
  logger?: SigilLogger;
  hooks?: SealHooks;
  plugins?: readonly SigilPolicyPlugin[];
  skipGenesisAssertion?: boolean;
}): Promise<SigilVaultInternalState> {
  if (args.plugins) validatePluginList(args.plugins);
  const logger = resolveLogger(args.logger) ?? NOOP_LOGGER;

  // createSigilClientAsync runs the genesis-hash assertion + delegates
  // to `createSigilClient` (the factory). The factory is the ONLY code
  // path that wires `plugins` + `hooks` through `clientSeal` into bare
  // `seal()`. If we used `SigilClient.create()` (the deprecated class
  // static) both fields would be silently dropped because:
  //   - The class constructor reads neither `config.plugins` nor
  //     `config.hooks` — they have no class fields at all.
  //   - The class's own `executeAndConfirm()` has no `composeHooks`,
  //     no `invokeHook`, no `runPlugins`. It's a legacy path kept alive
  //     only for backward-compatibility with pre-Sprint-2 consumers
  //     (none of which exist in practice — @usesigil/kit is pre-1.0
  //     with no external consumers per docs/SDK-REDESIGN-PLAN.md V1).
  // Flagged CRITICAL by two independent review agents; this fix is the
  // Sprint 2 finish actually closing.
  const client: SigilClientApi = await createSigilClientAsync({
    rpc: args.rpc,
    vault: args.vault,
    agent: args.agent,
    network: args.network,
    logger: args.logger,
    hooks: args.hooks,
    plugins: args.plugins,
    skipGenesisAssertion: args.skipGenesisAssertion,
  });

  // OwnerClient only exists on handles that have an owner signer.
  // Agent-only handles get `undefined` and owner-gated methods
  // throw SIGIL_ERROR__SDK__OWNER_REQUIRED.
  // OwnerClientConfig does NOT accept a `logger` field today
  // (deferred to a follow-up PR that threads logger through the dashboard
  // package symmetrically with SigilClient). The logger installed above
  // via SigilClient.create already routes every leaf utility's warning
  // through the consumer's logger via the module-level logger cache.
  const ownerClient = args.owner
    ? createOwnerClient({
        rpc: args.rpc,
        vault: args.vault,
        owner: args.owner,
        network: args.network,
      })
    : undefined;

  return {
    rpc: args.rpc,
    vault: args.vault,
    agent: args.agent,
    owner: args.owner,
    network: args.network,
    client,
    ownerClient,
    logger,
    hooks: args.hooks,
    plugins: args.plugins,
  };
}

async function quickstart(
  opts: SigilQuickstartOptions,
): Promise<SigilQuickstartResult> {
  // Step 1: create + send the vault on-chain.
  const createResult = await createAndSendVault(opts);
  const vaultAddress = createResult.vaultAddress;

  // Step 2: build the SigilVault handle (runs genesis assertion).
  const state = await buildInternalState({
    rpc: opts.rpc,
    vault: vaultAddress,
    agent: opts.agent,
    owner: opts.owner,
    network: opts.network,
    logger: opts.logger,
    hooks: opts.hooks,
    plugins: opts.plugins,
    skipGenesisAssertion: opts.skipGenesisAssertion,
  });
  const vault = SigilVault._fromResolved(state);

  // Step 3: optional initial funding. If `initialFundingUsd` is absent
  // or zero, return `funded: false, reason: "skipped"`.
  const amount = opts.initialFundingUsd ?? (0n as UsdBaseUnits);
  if (amount === 0n) {
    return {
      vault,
      funded: { funded: false, reason: "skipped" },
      signatures: { createVault: createResult.signature },
    };
  }

  // Resolve funding mint: default to USDC on the target network.
  const fundingMint =
    opts.fundingMint ??
    (opts.network === "mainnet" ? USDC_MINT_MAINNET : USDC_MINT_DEVNET);

  try {
    const fundResult = await vault.fund(fundingMint, amount);
    return {
      vault,
      funded: {
        funded: true,
        signature: fundResult.signature,
        amountDepositedUsd: amount,
      },
      signatures: {
        createVault: createResult.signature,
        fund: fundResult.signature,
      },
    };
  } catch (err) {
    // Funding failed after vault creation. The vault is live on-chain
    // with no deposit; caller can retry fund() manually. We return a
    // handle + structured outcome rather than throwing so the vault
    // isn't orphaned.
    return {
      vault,
      funded: {
        funded: false,
        reason: "rpc-failure",
        error: err instanceof Error ? err : new Error(String(err)),
      },
      signatures: { createVault: createResult.signature },
    };
  }
}

async function fromVault(opts: FromVaultOptions): Promise<SigilVault> {
  const state = await buildInternalState({
    rpc: opts.rpc,
    vault: opts.address,
    agent: opts.agent,
    owner: opts.owner,
    network: opts.network,
    logger: opts.logger,
    hooks: opts.hooks,
    plugins: opts.plugins,
    skipGenesisAssertion: opts.skipGenesisAssertion,
  });
  return SigilVault._fromResolved(state);
}

/**
 * Discover all vaults owned by an address. Delegates to the
 * existing `dashboard/discover.ts` (enriched path — returns status +
 * agentCount).
 */
async function discoverVaultsByOwner(
  rpc: Rpc<SolanaRpcApi>,
  owner: Address,
  network: "devnet" | "mainnet",
): Promise<DiscoveredVault[]> {
  return discoverVaults(rpc, owner, network);
}

// ─── Frozen namespace export ────────────────────────────────────────────────

/**
 * `Sigil` — the top-level facade. Frozen at module-load; attempts to
 * mutate `Sigil.*` in strict mode throw, in loose mode silently fail.
 */
export const Sigil = Object.freeze({
  presets,
  quickstart,
  fromVault,
  discoverVaults: discoverVaultsByOwner,
} as const);
