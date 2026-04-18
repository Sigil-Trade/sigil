/**
 * @usesigil/kit/react — React hooks for Sigil vault state.
 *
 * Four TanStack Query wrappers around `SigilVault` methods:
 *   - `useVaultBudget(vault)` — useQuery wrapping vault.budget()
 *   - `useVaultState(vault)` — useQuery wrapping the agent-side
 *     state-resolver primitive
 *   - `useOverview(vault, opts?)` — useQuery wrapping vault.overview()
 *     (owner-only; throws if called on an agent-only handle)
 *   - `useExecute(vault)` — useMutation wrapping vault.execute()
 *
 * Peer dependencies are **optional**: React and `@tanstack/react-query`
 * are declared as peer deps in `package.json` under `peerDependenciesMeta`
 * with `optional: true`. Consumers who don't use React never install them
 * and never see a warning. Consumers who do import this subpath must
 * install both.
 *
 * Query keys: every query key is namespaced under `"sigil"` so a
 * consumer's existing TanStack cache never collides with SDK keys.
 * Keys are derived from `vault.address` so multi-vault apps share keys
 * per-vault without manual namespacing.
 *
 * Cache invalidation: the SDK does NOT call `queryClient.invalidateQueries`
 * on its own. After an `execute()` mutation, the consumer decides which
 * queries to refetch — typically `useExecute` is wrapped with a custom
 * `onSuccess` that invalidates the specific vault keys.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReactQueryModule = any;

// ─── Peer-dep shim ──────────────────────────────────────────────────────────
//
// We can't `import { useQuery }` statically because doing so would make
// `@tanstack/react-query` a hard dependency at module-load time — a
// consumer who uses `@usesigil/kit` without touching `/react` would
// see a resolution error on every kit import. Instead, this subpath
// imports TanStack lazily via `require()` at the use site, inside the
// hook body. Each hook calls a one-time dynamic import that throws a
// clear error if the peer dep isn't installed.

function requireTanstack(): ReactQueryModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@tanstack/react-query");
  } catch (err) {
    throw new Error(
      "@usesigil/kit/react requires `@tanstack/react-query` as a peer dependency. " +
        "Install it via `npm install @tanstack/react-query react` and retry.",
    );
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

import type { SigilVault, SigilVaultExecuteOptions } from "../vault-handle.js";
import type { Instruction } from "../kit-adapter.js";
import type { ExecuteResult } from "../seal.js";
import type { ResolvedBudget } from "../state-resolver.js";
import type { OverviewData, GetOverviewOptions } from "../dashboard/types.js";

// ─── Query-key helpers ──────────────────────────────────────────────────────

/**
 * Build a stable query key for a vault-bound query. Namespaced under
 * `"sigil"` so the keys never collide with consumer app keys.
 */
export function sigilQueryKey(
  vault: SigilVault,
  sub: "state" | "budget" | "overview",
): readonly unknown[] {
  return ["sigil", vault.address, sub] as const;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * `useVaultBudget(vault)` — read the vault's current rolling-24h
 * budget via TanStack Query. Cheap call — re-runs as often as the
 * query's `staleTime` allows (TQ default: 0ms).
 *
 * Returns the raw TQ `UseQueryResult<ResolvedBudget>` so consumers
 * can read `.data`, `.isLoading`, `.error`, etc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useVaultBudget(vault: SigilVault): any {
  const { useQuery } = requireTanstack();
  return useQuery({
    queryKey: sigilQueryKey(vault, "budget"),
    queryFn: (): Promise<ResolvedBudget> => vault.budget(),
  });
}

/**
 * `useVaultState(vault)` — alias for `useVaultBudget` today; kept as
 * a separate hook so Sprint 3 can swap in a richer state resolver
 * without changing the consumer call shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useVaultState(vault: SigilVault): any {
  const { useQuery } = requireTanstack();
  return useQuery({
    queryKey: sigilQueryKey(vault, "state"),
    queryFn: (): Promise<ResolvedBudget> => vault.budget(),
  });
}

/**
 * `useOverview(vault, opts?)` — read the full `OverviewData` via
 * `OwnerClient.getOverview()`. Requires an owner signer on the
 * handle — the query throws `SIGIL_ERROR__SDK__OWNER_REQUIRED` when
 * called on an agent-only handle. TanStack surfaces the throw via
 * `result.error`.
 */
export function useOverview(
  vault: SigilVault,
  opts?: GetOverviewOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { useQuery } = requireTanstack();
  return useQuery({
    queryKey: [...sigilQueryKey(vault, "overview"), opts ?? null] as const,
    queryFn: (): Promise<OverviewData> => vault.overview(opts),
  });
}

/**
 * `useExecute(vault)` — TanStack mutation wrapping `vault.execute`.
 * Usage:
 *   const { mutate, mutateAsync, isPending } = useExecute(vault);
 *   mutate({ instructions: [...], opts: { tokenMint, amount, ... } });
 *
 * Consumer is responsible for `queryClient.invalidateQueries` on
 * success — the SDK does not force a refetch of any specific keys,
 * so the consumer's cache hygiene stays under their control.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useExecute(vault: SigilVault): any {
  const { useMutation } = requireTanstack();
  return useMutation({
    mutationFn: async (args: {
      instructions: Instruction[];
      opts: SigilVaultExecuteOptions;
    }): Promise<ExecuteResult> => {
      return vault.execute(args.instructions, args.opts);
    },
  });
}
