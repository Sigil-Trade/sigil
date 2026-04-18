# `@usesigil/kit` Barrel Audit

**Date:** 2026-04-18
**Scope:** Evaluate which symbols currently exported at the root of `@usesigil/kit`
(`sdk/kit/src/index.ts`) should be hidden per `SDK-REDESIGN-PLAN.md` Categories 1-7.
**Status:** Audit complete. **Report-only — no code changes in this PR.**

## TL;DR

**53 of 54 plan-flagged symbols are safe to hide immediately.** Only one
(`custodyAdapterToTransactionSigner`) has an external consumer, and that
consumer is an internal package. A single follow-up PR can hide all 53 safe
symbols plus migrate the one consumer — probably 1-2 hours of focused work.

## Method

For each symbol flagged in Categories 1-3, 5-7 of `SDK-REDESIGN-PLAN.md`, we
ran a repo-wide search for imports matching `from "@usesigil/kit"` (the root
path — not deeper paths like `/dashboard`, `/errors`, `/testing`, and not
relative imports inside `sdk/kit/` itself, which use relative paths).

**Search scope:** `agent-middleware/`, `dashboard/`,
`protocol-scalability-tests/`. Excludes `node_modules/`, `dist/`, `target/`,
`.claude/worktrees/`.

**Risk legend:**

- 🟢 **SAFE** — zero root-path imports; hide now, zero consumer impact
- 🟡 **NEEDS MIGRATION** — one or more consumers exist; hide with coordinated update
- 🔴 **DEFER** — load-bearing on a production path; revisit after replacement API exists

Category 4 (Codama generated pollution) was already resolved in the A12 barrel
surgery (PR #238) — `export * from "./generated/*"` was replaced with explicit
re-exports. Not re-audited here.

Category 8 (legacy bitmasks + deprecated `SigilClient`) was resolved in the
A11 cleanup (PR #242) for the bitmask helpers. The `SigilClient` class is
still exported at root with `@deprecated` JSDoc — tracked separately below in
[Addendum: Sprint 2 private ctor notes](#addendum-sprint-2-private-ctor-notes).

## Category 1 — Internal RPC Plumbing

**Plan rationale:** "Consumers building custom clients would re-derive PDAs
themselves anyway. Exposing the internal cache classes (which are module-level
singletons) is also a security risk per Pentester F9 — a malicious package
could poison the cache for the whole process."

| Symbol                      | Root imports | Files  | Risk    |
| --------------------------- | ------------ | ------ | ------- |
| `BlockhashCache`            | 0            | (none) | 🟢 SAFE |
| `getBlockhashCache`         | 0            | (none) | 🟢 SAFE |
| `AltCache`                  | 0            | (none) | 🟢 SAFE |
| `mergeAltAddresses`         | 0            | (none) | 🟢 SAFE |
| `SIGIL_ALT_DEVNET`          | 0            | (none) | 🟢 SAFE |
| `SIGIL_ALT_MAINNET`         | 0            | (none) | 🟢 SAFE |
| `getSigilAltAddress`        | 0            | (none) | 🟢 SAFE |
| `signAndEncode`             | 0            | (none) | 🟢 SAFE |
| `sendAndConfirmTransaction` | 0            | (none) | 🟢 SAFE |
| `composeSigilTransaction`   | 0            | (none) | 🟢 SAFE |
| `validateTransactionSize`   | 0            | (none) | 🟢 SAFE |
| `measureTransactionSize`    | 0            | (none) | 🟢 SAFE |
| `toInstruction`             | 0            | (none) | 🟢 SAFE |
| `bytesToAddress`            | 0            | (none) | 🟢 SAFE |
| `resolveAccounts`           | 0            | (none) | 🟢 SAFE |

**Subtotal:** 15 / 15 safe.

## Category 2 — Policy Engine Internals

**Plan rationale:** "`shield()` uses these internally. Consumers should call
`shield()` directly, not orchestrate the policy engine themselves.
`VelocityTracker` is a client-side TypeScript mirror of the on-chain
`SpendTracker` — useful for the SDK's internal pre-flight, useless to a
consumer who can just call `vault.budget()`."

| Symbol              | Root imports | Files  | Risk    |
| ------------------- | ------------ | ------ | ------- |
| `evaluatePolicy`    | 0            | (none) | 🟢 SAFE |
| `enforcePolicy`     | 0            | (none) | 🟢 SAFE |
| `recordTransaction` | 0            | (none) | 🟢 SAFE |
| `toCoreAnalysis`    | 0            | (none) | 🟢 SAFE |
| `ShieldStorage`     | 0            | (none) | 🟢 SAFE |
| `SpendEntry`        | 0            | (none) | 🟢 SAFE |
| `TxEntry`           | 0            | (none) | 🟢 SAFE |
| `VelocityTracker`   | 0            | (none) | 🟢 SAFE |
| `VelocityConfig`    | 0            | (none) | 🟢 SAFE |
| `SpendStatus`       | 0            | (none) | 🟢 SAFE |

**Subtotal:** 10 / 10 safe.

## Category 3 — TEE Internal Plumbing

**Plan rationale:** "Per D7 (Turnkey only), 99% of consumers will use
`verifyTurnkey()` directly. The cache management, PCR types, and adapter
conversion are internal to the verification flow."

| Symbol                              | Root imports | Files                               | Risk               |
| ----------------------------------- | ------------ | ----------------------------------- | ------------------ |
| `AttestationCache`                  | 0            | (none)                              | 🟢 SAFE            |
| `DEFAULT_CACHE_TTL_MS`              | 0            | (none)                              | 🟢 SAFE            |
| `clearAttestationCache`             | 0            | (none)                              | 🟢 SAFE            |
| `deleteFromAttestationCache`        | 0            | (none)                              | 🟢 SAFE            |
| `NitroPcrValues`                    | 0            | (none)                              | 🟢 SAFE            |
| `TurnkeyAttestationBundle`          | 0            | (none)                              | 🟢 SAFE            |
| `WalletLike`                        | 0            | (none)                              | 🟢 SAFE            |
| `AttestationConfig`                 | 0            | (none)                              | 🟢 SAFE            |
| `AttestationLevel`                  | 0            | (none)                              | 🟢 SAFE            |
| `AttestationMetadata`               | 0            | (none)                              | 🟢 SAFE            |
| `custodyAdapterToTransactionSigner` | 1            | `packages/plugins/src/sak/index.ts` | 🟡 NEEDS MIGRATION |

**Subtotal:** 10 / 11 safe, 1 needs migration.

**On the SAK plugin dep:** The plugin uses `custodyAdapterToTransactionSigner`
to bridge the `CustodyAdapter` shape a caller might pass as `agent` into the
`TransactionSigner` that `createSigilClient` needs. Two migration options:

1. **Move the bridge helper into the plugin** — plugin owns its own adapter
   glue, `custodyAdapterToTransactionSigner` moves to
   `packages/plugins/src/sak/signer.ts`. Clean separation; no cross-package
   dependency on an SDK internal.
2. **Export at a `/custody` subpath** — if other plugin authors might want
   the same bridge, expose it under `@usesigil/kit/custody` (or
   `@usesigil/custody` — the package already exists). Root barrel stays clean.

Recommend option 1 for the follow-up PR — the bridge is plugin-specific glue,
not a general SDK primitive.

## Category 5 — Redundant Vault Creation Paths

**Plan rationale:** "`inscribe()` and `withVault()` are alternative APIs that
the README doesn't even mention. They overlap with `createAndSendVault`. Pick
one path."

| Symbol                     | Root imports | Files  | Risk    |
| -------------------------- | ------------ | ------ | ------- |
| `inscribe`                 | 0            | (none) | 🟢 SAFE |
| `withVault`                | 0            | (none) | 🟢 SAFE |
| `mapPoliciesToVaultParams` | 0            | (none) | 🟢 SAFE |
| `findNextVaultId`          | 0            | (none) | 🟢 SAFE |

**Subtotal:** 4 / 4 safe.

**Stronger recommendation:** V1 of the plan verification confirmed there are
no existing consumers of `inscribe()` / `withVault()` — the dashboard isn't
integrated yet and these functions were never documented. Safe to **delete
outright** rather than merely hide, in a follow-up PR. That removes ~200 LOC
of parallel-API maintenance surface.

## Category 6 — Internal Constants

**Plan rationale:** "These are all things the SDK uses internally. A consumer
who needs `PROTOCOL_FEE_RATE` is doing something they probably shouldn't
(recomputing fees that the on-chain program already calculates)."

| Symbol                   | Root imports | Files  | Risk    |
| ------------------------ | ------------ | ------ | ------- |
| `EPOCH_DURATION`         | 0            | (none) | 🟢 SAFE |
| `NUM_EPOCHS`             | 0            | (none) | 🟢 SAFE |
| `OVERLAY_EPOCH_DURATION` | 0            | (none) | 🟢 SAFE |
| `OVERLAY_NUM_EPOCHS`     | 0            | (none) | 🟢 SAFE |
| `ROLLING_WINDOW_SECONDS` | 0            | (none) | 🟢 SAFE |
| `PROTOCOL_TREASURY`      | 0            | (none) | 🟢 SAFE |
| `PROTOCOL_FEE_RATE`      | 0            | (none) | 🟢 SAFE |
| `MAX_DEVELOPER_FEE_RATE` | 0            | (none) | 🟢 SAFE |
| `FEE_RATE_DENOMINATOR`   | 0            | (none) | 🟢 SAFE |
| `ON_CHAIN_ERROR_MAP`     | 0            | (none) | 🟢 SAFE |

**Subtotal:** 10 / 10 safe.

**Note on `ON_CHAIN_ERROR_MAP`:** consumers who want Anchor error-code-to-name
mapping should use `toAgentError()` (already public) instead. The raw map is
an implementation detail.

## Category 7 — Duplicate `TransactionExecutor`

**Plan rationale:** "`TransactionExecutor` class overlaps with
`createSigilClient`. Both: build → sign → send → confirm with retry. Pick one.
Recommend: `createSigilClient` (factory pattern, viem-aligned)."

| Symbol                       | Root imports | Files  | Risk    |
| ---------------------------- | ------------ | ------ | ------- |
| `TransactionExecutor`        | 0            | (none) | 🟢 SAFE |
| `ExecuteTransactionParams`   | 0            | (none) | 🟢 SAFE |
| `ExecuteTransactionResult`   | 0            | (none) | 🟢 SAFE |
| `TransactionExecutorOptions` | 0            | (none) | 🟢 SAFE |

**Subtotal:** 4 / 4 safe.

**Stronger recommendation:** Same as Category 5 — no external consumers, no
README mention. Delete outright in a follow-up PR. Removes another duplicate
build-sign-send implementation that would otherwise drift from the canonical
`createSigilClient` path over time.

## Summary

| Category                     | Total  | 🟢 Safe | 🟡 Needs Migration | 🔴 Defer |
| ---------------------------- | ------ | ------- | ------------------ | -------- |
| 1 — Internal RPC Plumbing    | 15     | 15      | 0                  | 0        |
| 2 — Policy Engine Internals  | 10     | 10      | 0                  | 0        |
| 3 — TEE Internal Plumbing    | 11     | 10      | 1                  | 0        |
| 5 — Redundant Vault Creation | 4      | 4       | 0                  | 0        |
| 6 — Internal Constants       | 10     | 10      | 0                  | 0        |
| 7 — Duplicate Executor       | 4      | 4       | 0                  | 0        |
| **Total**                    | **54** | **53**  | **1**              | **0**    |

## Recommendations

### Follow-up PR 1 — "barrel prune" (estimated 1-2 hours)

Hide the 53 🟢 SAFE symbols. Single surgical PR:

- Remove the 53 symbols from `sdk/kit/src/index.ts` exports
- For Categories 5 + 7 (`inscribe`/`withVault`/`mapPoliciesToVaultParams`/`findNextVaultId`/`TransactionExecutor` + 3 types): **delete the source files entirely** — they're parallel-API surface with zero consumers. Removes maintenance burden.
- For the rest: just remove from the barrel; source files stay (used internally via relative imports)
- Verify with `pnpm -r run build` + `pnpm test` + dashboard's typecheck
- Changeset: **minor bump** (removes public exports from root barrel — pre-1.0, no real consumers, but changeset should still document the surface change)

### Follow-up PR 2 — "SAK plugin owns its custody bridge" (estimated 30 min)

Move `custodyAdapterToTransactionSigner` from `sdk/kit/src/custody-adapter.ts`
into `packages/plugins/src/sak/signer.ts` (or wherever the plugin wants).
Then hide it from the kit barrel.

- Can be bundled into PR 1 above if done in sequence
- Changeset: **minor bump** on `@usesigil/kit` (removes public export) + **patch bump** on `@usesigil/plugins` (internal restructure, no API change)

### No PR needed

Categories 1-2, 3 (minus 1 symbol), 5-7 are all zero-consumer. No deferrals,
no red flags, no "revisit later."

## Addendum: Sprint 2 private ctor notes

The `SigilClient` class is still exported from the root barrel with an
`@deprecated` JSDoc tag, even though its sync constructor is now `private`
(Sprint 2 D-SYNC-CTOR). Two reasons it stays exported:

1. **Type position** — consumers write `SigilClient` in type positions
   (`function foo(client: SigilClient)`). Removing the export would force
   them to switch to `SigilClientApi` (the interface). Since we already
   migrated the SAK plugin to use `SigilClientApi` during the PR #244
   carryover, we could reasonably remove the class export now.
2. **`SigilClient.create()` static** — the async factory is the recommended
   entry point. Removing the class export means consumers have to import
   `createSigilClient` (the function factory) instead. Both work; the static
   is just a slightly nicer surface for TypeScript consumers who want
   `SigilClient.create(...)` to autocomplete.

**Recommendation:** Include the class-export removal in the same Follow-up
PR 1. Update the migration guide at that point to explicitly tell consumers
to import `SigilClientApi` for type positions and `createSigilClient` /
`SigilClient.create` for construction. (This is the natural time to do it
since we're already touching the barrel.)

---

**This audit does not modify any source code.** It inventories the current
barrel surface against the plan's recommendations and classifies each symbol
by breakage risk. The actual hiding happens in follow-up PRs, scoped by
recommendation group.
