---
"@usesigil/kit": minor
---

**S14 — `OwnerClient.getOverview()` single-call convenience + shared-context refactor**

Adds `OwnerClient.getOverview(options?)` that returns all five existing dashboard view types (`vault`, `agents`, `spending`, `health`, `policy`) plus an unfiltered `activity: ActivityRow[]` list in one call. Resolves vault state exactly once — calling the five individual reads separately duplicates the resolution up to five times.

**New public API:**

- `OwnerClient.getOverview(options?)` — method on the class.
- `getOverview(rpc, vault, network, options?)` — free-function variant.
- Types: `OverviewData`, `OverviewContext`, `GetOverviewOptions`, `SerializedOverviewData`.
- `GetOverviewOptions` fields: `includeActivity?: boolean` (default `true`), `activityLimit?: number` (default `DEFAULT_OVERVIEW_ACTIVITY_LIMIT` = 100).
- Constant: `DEFAULT_OVERVIEW_ACTIVITY_LIMIT`.
- Pure helper: `getVaultPnLFromState(state)` — computes `VaultPnL` from an already-resolved state without issuing an RPC. `getVaultPnL()` (the RPC variant) now delegates to it.
- **`@experimental`** composition helpers exposed from `@usesigil/kit/dashboard`: `buildVaultState`, `buildAgents`, `buildSpending`, `buildHealth`, `buildPolicy`, `buildActivityRows`. These are for advanced consumers (custom dashboards, MCP servers, test harnesses) that want to share one pre-fetched context across multiple views. The `OverviewContext` field shape — particularly the three memoized derivations (`posture`, `breakdown`, `alerts`) — may change without a major bump while the composition surface is iterated on.

**Refactor (behavior-preserving):**

- All five existing reads (`getVaultState`, `getAgents`, `getSpending`, `getHealth`, `getPolicy`) now delegate to the new `build*` helpers. Signatures unchanged. Output byte-identical. Existing tests pass unchanged.
- `getActivity` extracted the raw → `ActivityRow[]` mapping into `buildActivityRows`, then filters as before.
- Shared `isAccountNotFoundError` helper replaces two near-duplicate substring-matching catches in `getPolicy` and `getOverview`.

**RPC-cost honesty:**

`getOverview` resolves state once and derives PnL from that state synchronously — net-1 state resolution vs. the original PR implementation (which re-resolved via `getVaultPnL`). `resolveVaultStateForOwner`, `getVaultActivity`, and `getPendingPolicyForVault` are fanned out in a single `Promise.all`. The activity fetch (`getSignaturesForAddress` + up to `activityLimit` sequential `getTransaction` calls) dominates wall time when `includeActivity: true`; tune with `activityLimit` or skip entirely with `includeActivity: false`.

**Known degradation paths:**

- `includeActivity: false` → `activity: []` AND `agents[*].lastAction*` fields empty (JSDoc now warns).
- Activity fetch failure → logs via `console.warn`, returns `activity: []` (matches `getAgents` pattern, references `docs/SECURITY-FINDINGS-2026-04-07.md` Finding 5).
- Pending-policy account-not-found → `policy.pendingUpdate: undefined`. Any other `getPendingPolicyForVault` error propagates; the same asymmetry exists in `getPolicy`.

**Guards added:**

- `buildVaultState` / `buildAgents` / `buildPolicy` now fail fast with labeled errors when `state.vault` or `state.policy` are null/undefined, instead of the cryptic "cannot read properties of null" TypeError.

**Tests added:** fixture-based unit tests for `buildActivityRows`, `buildVaultState` (with posture/pnl memoization), `buildAgents` (activity honored + includeActivity:false path), `buildSpending` (breakdown memoization), `buildHealth` (alerts + posture memoization), `buildPolicy` (pendingPolicy null vs undefined), state-missing guards on three helpers, and `OverviewData.toJSON()` delegation. `OwnerClient` method-count test updated from 6 → 7 reads.
