/**
 * SigilPolicyPlugin — consumer-supplied policy checks that run inside
 * the `seal()` pre-flight.
 *
 * Plugins are the **rejection surface** of the SDK — distinct from
 * `SealHooks`, which are observe-only. A plugin's `check()` returns
 * either `{ allow: true }` or `{ allow: false, reason, code? }`; the
 * first rejection short-circuits and `seal()` throws
 * `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`.
 *
 * Run order inside `seal()`:
 *   1. Parameter validation (basic shape checks)
 *   2. `hooks.onBeforeBuild` — may abort cleanly via `{ skipSeal: true }`
 *   3. `resolveVaultState` — fetches AgentVault + PolicyConfig + SpendTracker + Overlay
 *   4. Vault-active + agent-registered + agent-not-paused gates
 *   5. **Plugin checks** — first `{ allow: false }` throws. Plugins see
 *      the resolved on-chain state via `PluginContext.state`. NOTE: the
 *      zero-capability check runs AFTER plugins (step 7), so a plugin
 *      MAY observe `state.capabilityTier === 0`; plugins relying on a
 *      non-zero capability must assert it themselves before allowing.
 *   6. Amount/protocol/constraint checks (spending gates, allowlist, max)
 *   7. Agent-capability zero-check + transaction assembly
 *   8. `hooks.onBeforeSign` — final observe-only point before return
 *
 * Plugins run AFTER state resolution by design — 2 of 3 real plugin
 * categories (rate limiting, compliance) need state input. Consumers who
 * want stateless early-exit use `onBeforeBuild` with
 * `{ skipSeal: true, reason }` — that path runs before any RPC.
 *
 * Plugins MUST NOT perform their own RPC calls — they receive the
 * pre-resolved state as context. Async plugin `check()` is supported
 * for cases where the plugin delegates to an external service
 * (feature-flag servers, compliance APIs) but the plugin runner will
 * log a warning if any plugin takes >1s.
 *
 * Consumer-supplied logger + hooks still fire around plugin execution
 * (a rejecting plugin triggers `onError` before the throw propagates).
 */

import type { Address, Instruction } from "./kit-adapter.js";
import type { SigilSdkErrorCode } from "./errors/codes.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import {
  SIGIL_ERROR__SDK__PLUGIN_REJECTED,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
} from "./errors/codes.js";
import { getSigilModuleLogger } from "./logger.js";

// ─── Plugin context ─────────────────────────────────────────────────────────

/**
 * Read-only data surface passed to every plugin `check()` call. The
 * plugin runner populates this once per `seal()` invocation and shares
 * it across all plugins; plugins must treat everything as immutable.
 */
export interface PluginContext {
  readonly vault: Address;
  readonly agent: Address;
  readonly tokenMint: Address;
  readonly amount: bigint;
  readonly network: "devnet" | "mainnet";
  readonly instructions: readonly Instruction[];
  /** Stable ID for this `seal()` invocation — matches `SealHookContext.correlationId`. */
  readonly correlationId: string;
  /**
   * Sanitized vault state snapshot, populated by `seal()` after
   * `resolveVaultState()` completes and prerequisite checks pass
   * (vault active + agent registered + agent not paused). Frozen —
   * mutation attempts throw in strict mode.
   *
   * **Security contract (intentional redactions):**
   *   - `owner` pubkey is NOT exposed — plugins must not make policy
   *     decisions based on ownership identity.
   *   - Full `agents[]` roster is NOT exposed — plugins see their
   *     invocation agent's capability/paused state only, preventing
   *     inter-agent side channels.
   *   - `vault_id` is NOT exposed — internal identifier, no policy use.
   *   - Raw `SpendTracker` epoch array is NOT exposed — denormalized
   *     into `globalBudget.spent24h` instead.
   *
   * The exposed surface is sufficient for the three real use cases:
   * rate limiting (budget remaining), compliance (vault status + agent
   * paused), and circuit breakers (budget spent24h).
   */
  readonly state: {
    /** Rolling 24h global budget: cap, spent, remaining (6-decimal USD). */
    readonly globalBudget: import("./state-resolver.js").EffectiveBudget;
    /** Rolling 24h per-agent budget. Null if the agent has no sub-cap. */
    readonly agentBudget: import("./state-resolver.js").EffectiveBudget | null;
    /** On-chain vault lifecycle status. */
    readonly vaultStatus: import("./generated/types/vaultStatus.js").VaultStatus;
    /** Agent capability tier (0=Disabled, 1=Observer, 2=Operator). */
    readonly capabilityTier: number;
    /** Policy max-transaction-size cap (6-decimal USD). 0n means uncapped. */
    readonly maxTransactionUsd: bigint;
    /** Unix timestamp (seconds) when state was resolved. */
    readonly resolvedAtTimestamp: bigint;
  };
}

// ─── Plugin result ──────────────────────────────────────────────────────────

/**
 * Successful plugin check. May carry advisory metadata that downstream
 * plugins or hooks can observe via `SealHooks.onBeforeSign`.
 */
export interface PluginAllow {
  readonly allow: true;
  /** Optional metadata (flag names, rule IDs, etc.) for downstream visibility. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Rejection result. `reason` must be a human-readable string; `code`
 * is optional but recommended for machine-readable catch blocks.
 */
export interface PluginReject {
  readonly allow: false;
  readonly reason: string;
  readonly code?: SigilSdkErrorCode;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type PluginResult = PluginAllow | PluginReject;

// ─── SigilPolicyPlugin interface ────────────────────────────────────────────

export interface SigilPolicyPlugin {
  /**
   * Display name used in logs + the rejection error's context. Must be
   * unique per plugin instance — the runner enforces this via config
   * validation.
   */
  readonly name: string;

  /**
   * Observe-only lifecycle: called once when the plugin is registered
   * on a `SigilClient` / `Sigil` facade. Use for opening connections,
   * prewarming caches, etc. Throws during init fail the client
   * construction with `SIGIL_ERROR__SDK__INVALID_CONFIG`.
   */
  readonly init?: () => void | Promise<void>;

  /**
   * Policy check. Returns `{ allow: true }` to continue or
   * `{ allow: false, reason, code? }` to reject. Must not throw under
   * normal operation — the plugin runner treats a throw as a hard
   * rejection with the error message as the reason.
   */
  check(ctx: PluginContext): PluginResult | Promise<PluginResult>;
}

// ─── Plugin runner ──────────────────────────────────────────────────────────

/**
 * Run every plugin's `check()` in registration order. Returns on the
 * first rejection with a `SigilSdkDomainError`; otherwise returns
 * successfully. Plugins that take >1 second log a warning via the
 * module logger.
 *
 * Throws:
 *   - `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)` on first
 *     plugin that returns `{ allow: false }` OR throws.
 *
 * @internal — consumers invoke this via `seal()` / `SigilClient`.
 */
export async function runPlugins(
  plugins: readonly SigilPolicyPlugin[] | undefined,
  ctx: PluginContext,
): Promise<void> {
  if (!plugins || plugins.length === 0) return;

  for (const plugin of plugins) {
    const start = Date.now();
    let result: PluginResult;
    try {
      result = await plugin.check(ctx);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown");
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__PLUGIN_REJECTED,
        `Plugin "${plugin.name}" threw during check(): ${message}`,
        {
          cause: err,
          context: {
            plugin: plugin.name,
            reason: message,
            correlationId: ctx.correlationId,
          },
        },
      );
    }

    const elapsedMs = Date.now() - start;
    if (elapsedMs > 1000) {
      getSigilModuleLogger().warn(
        `[SigilPolicyPlugin] "${plugin.name}" took ${elapsedMs}ms — plugin checks should be fast`,
        { plugin: plugin.name, elapsedMs },
      );
    }

    if (!result.allow) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__PLUGIN_REJECTED,
        `Plugin "${plugin.name}" rejected the operation: ${result.reason}`,
        {
          context: {
            plugin: plugin.name,
            reason: result.reason,
            code: result.code,
            metadata: result.metadata,
            correlationId: ctx.correlationId,
          },
        },
      );
    }
  }
}

// ─── Plugin list validation ─────────────────────────────────────────────────

/**
 * Validate a plugin list at client-construction time. Rejects:
 *   - Non-array input
 *   - Duplicate plugin names
 *   - Plugins without `name` or `check`
 *
 * Called by `createSigilClient` / `Sigil.quickstart` / `Sigil.fromVault`
 * when `config.plugins` is present.
 */
export function validatePluginList(
  plugins: unknown,
): asserts plugins is readonly SigilPolicyPlugin[] {
  if (!Array.isArray(plugins)) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_CONFIG,
      `SigilClientConfig.plugins must be an array of SigilPolicyPlugin (received ${typeof plugins})`,
      { context: { field: "plugins", expected: "SigilPolicyPlugin[]" } },
    );
  }
  const names = new Set<string>();
  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    if (!p || typeof p !== "object") {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        `Plugin at index ${i} is not an object (received ${typeof p})`,
        { context: { field: `plugins[${i}]`, expected: "object" } },
      );
    }
    const pluginObj = p as Partial<SigilPolicyPlugin>;
    if (typeof pluginObj.name !== "string" || pluginObj.name.length === 0) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        `Plugin at index ${i} is missing a non-empty string "name"`,
        { context: { field: `plugins[${i}].name`, expected: "string" } },
      );
    }
    if (typeof pluginObj.check !== "function") {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        `Plugin "${pluginObj.name}" is missing a check() function`,
        {
          context: {
            field: `plugins[${pluginObj.name}].check`,
            expected: "function",
          },
        },
      );
    }
    if (names.has(pluginObj.name)) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
        `Duplicate plugin name "${pluginObj.name}" — plugin names must be unique per client`,
        { context: { field: "plugins[].name", expected: "unique" } },
      );
    }
    names.add(pluginObj.name);
  }
}
