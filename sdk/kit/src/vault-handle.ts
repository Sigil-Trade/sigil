/**
 * SigilVault — handle over an on-chain Sigil vault.
 *
 * Represents a single vault + agent pair. Consumers get one via
 * `Sigil.quickstart()` (new vault) or `Sigil.fromVault()` (existing
 * vault). The constructor is private — construction tokens prevent
 * external call sites from synthesizing the symbol and bypassing the
 * factory validation path.
 *
 * Internally composes two Sprint 1 primitives:
 *   - `createSigilClient` / `SigilClient.create` for agent-side
 *     operations (`execute`, `budget`).
 *   - `createOwnerClient` for owner-only operations (`overview`,
 *     `freeze`, `fund`). Agent-only handles don't get an ownerClient;
 *     owner-gated methods throw `SIGIL_ERROR__SDK__OWNER_REQUIRED`.
 *
 * Per-call hooks passed to `execute({ hooks })` compose with the
 * client-level hooks registered at handle construction — client hooks
 * run first, then per-call hooks. Both go through `invokeHook` which
 * swallows throws.
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "./kit-adapter.js";
import type { SigilClientApi, ClientSealOpts, ExecuteResult } from "./seal.js";
import type { OwnerClient } from "./dashboard/index.js";
import type { OverviewData, GetOverviewOptions } from "./dashboard/types.js";
import type { ResolvedBudget } from "./state-resolver.js";
import type { SigilLogger } from "./logger.js";
import type { SealHooks } from "./hooks.js";
import type { SigilPolicyPlugin } from "./plugin.js";
import type { UsdBaseUnits } from "./types.js";

import { resolveVaultBudget } from "./state-resolver.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__OWNER_REQUIRED } from "./errors/codes.js";
import { composeHooks } from "./hooks.js";

// ─── Internal construction token ────────────────────────────────────────────

/**
 * Module-private symbol that enforces "no direct `new SigilVault()`" at
 * runtime. Factory methods in `sigil.ts` hold the only reference.
 * Class constructor rejects anything that isn't this exact symbol.
 */
const CONSTRUCT_TOKEN: unique symbol = Symbol("SigilVault.construct");
export type _ConstructToken = typeof CONSTRUCT_TOKEN;

// ─── Internal state shape ───────────────────────────────────────────────────

export interface SigilVaultInternalState {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly vault: Address;
  readonly agent: TransactionSigner;
  readonly owner?: TransactionSigner;
  readonly network: "devnet" | "mainnet";
  readonly client: SigilClientApi;
  readonly ownerClient?: OwnerClient;
  readonly logger: SigilLogger;
  readonly hooks?: SealHooks;
  readonly plugins?: readonly SigilPolicyPlugin[];
}

// ─── Public options ─────────────────────────────────────────────────────────

/**
 * Per-call options for `SigilVault.execute()`. Extends the standalone
 * `ClientSealOpts` shape with a `hooks` override that composes with
 * client-level hooks.
 */
export interface SigilVaultExecuteOptions extends ClientSealOpts {
  /** Per-call hooks. Compose with client-level hooks (client runs first). */
  hooks?: SealHooks;
}

/** Standard transaction option shape for owner-only methods. */
export interface TxOpts {
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
}

/** Minimal result shape for owner-only mutations. */
export interface TxResult {
  signature: string;
}

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Handle over a Sigil vault. Constructor is private — use
 * `Sigil.quickstart()` or `Sigil.fromVault()` to obtain one.
 */
export class SigilVault {
  readonly address: Address;
  readonly network: "devnet" | "mainnet";
  readonly agent: TransactionSigner;
  readonly owner?: TransactionSigner;

  readonly #state: SigilVaultInternalState;

  /**
   * Private constructor — enforced via `CONSTRUCT_TOKEN`. External
   * callers that synthesize a fake token via TypeScript casting will
   * still trigger the runtime check and throw.
   */
  private constructor(token: _ConstructToken, state: SigilVaultInternalState) {
    if (token !== CONSTRUCT_TOKEN) {
      throw new Error(
        "SigilVault: direct construction is not allowed. Use Sigil.quickstart() or Sigil.fromVault().",
      );
    }
    this.#state = state;
    this.address = state.vault;
    this.network = state.network;
    this.agent = state.agent;
    this.owner = state.owner;
  }

  /**
   * @internal — used by `Sigil.quickstart()` and `Sigil.fromVault()`.
   * Not part of the public API; the underscore prefix signals this.
   */
  static _fromResolved(state: SigilVaultInternalState): SigilVault {
    return new SigilVault(CONSTRUCT_TOKEN, state);
  }

  // ─── Execute ─────────────────────────────────────────────────────────────

  /**
   * Execute DeFi instructions under the vault's seal. Composes
   * client-level and per-call hooks, then delegates to the underlying
   * `SigilClientApi.executeAndConfirm`.
   *
   * The composed hooks are threaded through as an extension field on
   * `ClientSealOpts`; `seal.ts` picks them up in the hook-invocation
   * step (landed in a subsequent commit of this sprint).
   */
  async execute(
    instructions: Instruction[],
    opts: SigilVaultExecuteOptions,
  ): Promise<ExecuteResult> {
    const composedHooks = composeHooks(this.#state.hooks, opts.hooks);
    const { hooks: _ignored, ...rest } = opts;
    const sealOpts: ClientSealOpts & { hooks?: SealHooks } = {
      ...rest,
      ...(composedHooks ? { hooks: composedHooks } : {}),
    };
    return this.#state.client.executeAndConfirm(instructions, sealOpts);
  }

  // ─── Overview ────────────────────────────────────────────────────────────

  /**
   * Full vault overview — delegates to `OwnerClient.getOverview()`.
   * Requires an `owner` signer on the handle; throws
   * `SIGIL_ERROR__SDK__OWNER_REQUIRED` when called agent-only.
   */
  async overview(options?: GetOverviewOptions): Promise<OverviewData> {
    const ownerClient = this.#requireOwnerClient("overview");
    return ownerClient.getOverview(options);
  }

  // ─── Budget ──────────────────────────────────────────────────────────────

  /**
   * Cheapest read — just the current rolling-24h budget. Uses agent
   * identity regardless of whether owner is present; either works.
   */
  async budget(): Promise<ResolvedBudget> {
    return resolveVaultBudget(
      this.#state.rpc,
      this.address,
      this.agent.address,
    );
  }

  // ─── Lifecycle: freeze ───────────────────────────────────────────────────

  /**
   * Freeze the vault — owner-only. Agents + pending operations are
   * rejected on-chain until `resume()` is called. Delegates to
   * `OwnerClient.freezeVault()`.
   */
  async freeze(opts?: TxOpts): Promise<TxResult> {
    const ownerClient = this.#requireOwnerClient("freeze");
    return ownerClient.freezeVault(opts);
  }

  // ─── Funds: fund ─────────────────────────────────────────────────────────

  /**
   * Deposit `amount` of `mint` from the owner's wallet into the vault.
   * Owner-only. Delegates to `OwnerClient.deposit()`.
   */
  async fund(
    mint: Address,
    amount: UsdBaseUnits,
    opts?: TxOpts,
  ): Promise<TxResult> {
    const ownerClient = this.#requireOwnerClient("fund");
    return ownerClient.deposit(mint, amount, opts);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Assert that this handle has an owner-capable `ownerClient` before
   * invoking an owner-only method. Throws a structured error with the
   * method name so consumers can pinpoint which call needs the owner.
   */
  #requireOwnerClient(method: string): OwnerClient {
    const oc = this.#state.ownerClient;
    if (!oc) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__OWNER_REQUIRED,
        `SigilVault.${method}() requires an owner signer. Reconstruct the handle via Sigil.fromVault({ ..., owner }) to enable this method.`,
        { context: { method, vault: this.address } },
      );
    }
    return oc;
  }
}
