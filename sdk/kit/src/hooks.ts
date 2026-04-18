/**
 * SealHooks — pluggable lifecycle observability for `seal()` and
 * `SigilClient.executeAndConfirm()`.
 *
 * Rationale: Sprint 1's `SigilClientConfig.onError` was a single post-
 * send telemetry callback — useful but narrow. Consumers building agent
 * frameworks need correlation IDs, pre-build rewrites, and per-stage
 * spans for distributed tracing. `SealHooks` is the observe-only
 * superset that handles those cases without compromising `seal()`'s
 * atomicity guarantee.
 *
 * Semantics:
 *   - All hooks are **observe-only** by default. A hook that throws is
 *     caught, logged via `getSigilModuleLogger().warn`, and swallowed;
 *     `seal()` continues.
 *   - `onBeforeBuild` is the only hook that may abort. Returning
 *     `{ skipSeal: true, reason }` throws
 *     `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)` before any
 *     RPC round-trip. Use for consent flows, feature flags, dry-run
 *     mode.
 *   - `onFinalize` fires **only** on success (from
 *     `executeAndConfirm`). Standalone `seal()` callers don't see it —
 *     they have the result in hand.
 */

import type { Address } from "./kit-adapter.js";
import { getSigilModuleLogger } from "./logger.js";

// ─── Context ────────────────────────────────────────────────────────────────

/**
 * Per-seal-invocation context passed to every hook. Populated once at
 * the top of `seal()` so every stage sees the same `correlationId`.
 */
export interface SealHookContext {
  readonly vault: Address;
  readonly agent: Address;
  readonly tokenMint: Address;
  readonly amount: bigint;
  readonly network: "devnet" | "mainnet";
  /** Stable per-seal-invocation ID (UUIDv4-like) for trace correlation. */
  readonly correlationId: string;
}

// ─── SealHooks interface ────────────────────────────────────────────────────

/**
 * The `skipSeal` signal from `onBeforeBuild`. Returning this causes
 * `seal()` to throw `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)`
 * before any RPC round-trip. Use for consent flows or dry-run mode.
 */
export type SealHookAbort = {
  readonly skipSeal: true;
  readonly reason: string;
};

/**
 * Result type for `onBeforeBuild` — either `void`/`undefined` (continue)
 * or `SealHookAbort` (stop).
 */
export type OnBeforeBuildResult = void | SealHookAbort;

export interface SealHooks {
  /**
   * Fires before any RPC call, after parameter validation but before
   * `resolveVaultState`. The hook may return `{ skipSeal: true, reason }`
   * to cleanly abort. The `params` argument is shallow-readonly — do
   * NOT mutate, use return value for abort.
   */
  onBeforeBuild?(
    ctx: SealHookContext,
    params: Readonly<unknown>,
  ): OnBeforeBuildResult | Promise<OnBeforeBuildResult>;

  /**
   * Fires after the composed transaction is built and size-checked,
   * before any signing. Observe-only — the `tx` argument is the
   * compiled transaction; mutations have no effect on the signed
   * transaction seal() ultimately submits.
   */
  onBeforeSign?(
    ctx: SealHookContext,
    tx: Readonly<unknown>,
  ): void | Promise<void>;

  /**
   * Fires after `sendTransaction` resolves with a signature but
   * potentially before confirmation. Use for starting distributed
   * traces that the `onFinalize` hook closes.
   */
  onAfterSend?(ctx: SealHookContext, signature: string): void | Promise<void>;

  /**
   * Fires in every error path inside `seal()` and
   * `executeAndConfirm()`. Observe-only — the error is always rethrown
   * after the hook runs.
   */
  onError?(ctx: SealHookContext, err: Error): void | Promise<void>;

  /**
   * Fires on the success path of `executeAndConfirm()` only, after
   * confirmation. Standalone `seal()` callers do not see this hook
   * (the result is returned synchronously from `seal()` itself).
   */
  onFinalize?(
    ctx: SealHookContext,
    result: Readonly<{ signature: string }>,
  ): void | Promise<void>;
}

// ─── Compose ────────────────────────────────────────────────────────────────

/**
 * Compose two `SealHooks` objects — each stage runs `outer[stage]`
 * first, then `inner[stage]`. Throws from either hook are caught by
 * `invokeHook` and do NOT propagate. Used to merge client-level hooks
 * (from `SigilClientConfig.hooks`) with per-call hooks
 * (from `ClientSealOpts.hooks` / `SealParams.hooks`).
 */
export function composeHooks(
  outer?: SealHooks,
  inner?: SealHooks,
): SealHooks | undefined {
  if (!outer && !inner) return undefined;
  if (!outer) return inner;
  if (!inner) return outer;
  return {
    async onBeforeBuild(ctx, params) {
      const outerResult = await outer.onBeforeBuild?.(ctx, params);
      if (outerResult && outerResult.skipSeal) return outerResult;
      const innerResult = await inner.onBeforeBuild?.(ctx, params);
      if (innerResult && innerResult.skipSeal) return innerResult;
    },
    async onBeforeSign(ctx, tx) {
      await outer.onBeforeSign?.(ctx, tx);
      await inner.onBeforeSign?.(ctx, tx);
    },
    async onAfterSend(ctx, sig) {
      await outer.onAfterSend?.(ctx, sig);
      await inner.onAfterSend?.(ctx, sig);
    },
    async onError(ctx, err) {
      await outer.onError?.(ctx, err);
      await inner.onError?.(ctx, err);
    },
    async onFinalize(ctx, result) {
      await outer.onFinalize?.(ctx, result);
      await inner.onFinalize?.(ctx, result);
    },
  };
}

// ─── invokeHook — safe-call with error swallow + logger route ──────────────

/**
 * Safely invoke a hook by name with arbitrary args. Swallows throws
 * and logs them via `getSigilModuleLogger().warn` so consumer hooks
 * can't corrupt `seal()`'s atomic-transaction guarantee. Returns
 * whatever the hook returned (for `onBeforeBuild`'s `skipSeal` path);
 * returns `undefined` if the hook threw.
 *
 * @internal — used by `seal.ts` and `SigilVault.execute`.
 */
export async function invokeHook<K extends keyof SealHooks>(
  hooks: SealHooks | undefined,
  key: K,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...args: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!hooks) return undefined;
  const fn = hooks[key];
  if (!fn) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (fn as any).apply(hooks, args);
  } catch (err) {
    getSigilModuleLogger().warn(
      `[SealHooks] ${String(key)} threw — swallowed to preserve seal() atomicity`,
      {
        hook: String(key),
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

// ─── correlationId helper ───────────────────────────────────────────────────

/**
 * Generate a short correlation ID for a single `seal()` invocation.
 * Not cryptographically strong — just unique enough for log grepping.
 * Prefers `crypto.randomUUID()` when available; falls back to a
 * timestamp + random counter in older Node versions.
 */
export function newCorrelationId(): string {
  // crypto is available in Node 14.17+ and all modern browsers.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback: timestamp + 8 hex chars of random.
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `seal-${Date.now().toString(16)}-${rand}`;
}
