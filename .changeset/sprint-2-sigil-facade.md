---
"@usesigil/kit": minor
---

**v0.11.0 — Sprint 2: Sigil facade + SigilVault + hooks + plugins + `/react`.** Additive convenience layer on top of Sprint 1 primitives, plus the long-planned removal of the deprecated sync `SigilClient` constructor.

**New public surface:**

- **`Sigil` facade (`import { Sigil } from "@usesigil/kit"`)** — frozen namespace with four entry points:
  - `Sigil.quickstart(opts)` — provision a new vault + optional initial funding + returns a `SigilVault` handle in one call
  - `Sigil.fromVault({ rpc, address, agent, owner?, network })` — bind a handle to an existing vault
  - `Sigil.discoverVaults(rpc, owner, network)` — enumerate an owner's vaults
  - `Sigil.presets` — groups `SAFETY_PRESETS` + `VAULT_PRESETS` + helpers under one namespace

- **`SigilVault` handle** — private-constructor class obtained via the facade factories. Methods: `execute()`, `overview()`, `budget()`, `freeze()`, `fund()`. Owner-only methods throw `SIGIL_ERROR__SDK__OWNER_REQUIRED` when called on an agent-only handle with the method name in context.

- **`SealHooks` lifecycle observability** — five observe-only hooks (`onBeforeBuild`, `onBeforeSign`, `onAfterSend`, `onError`, `onFinalize`) fire at documented stages of `seal()` + `executeAndConfirm()`. Throws are swallowed + logged via the injected logger — they never corrupt `seal()`'s atomic-transaction guarantee. `onBeforeBuild` uniquely may return `{ skipSeal: true, reason }` to abort cleanly via `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)` before any RPC round-trip. Client-level hooks compose with per-call hooks via `composeHooks()`.

- **`SigilPolicyPlugin` rejection surface** — async `check()` returns `{ allow: true }` or `{ allow: false, reason, code? }`. First rejection short-circuits `seal()` with `SigilSdkDomainError(SIGIL_ERROR__SDK__PLUGIN_REJECTED)`. Plugins that take >1s log a latency warning. Plugin names must be unique; `validatePluginList()` catches malformed lists at client construction.

- **`/react` subpath** — four TanStack Query hooks (`useVaultBudget`, `useVaultState`, `useOverview`, `useExecute`) + `sigilQueryKey` helper. React + `@tanstack/react-query` declared as **optional** peer dependencies — consumers who don't use React see no warnings. Query keys namespaced under `"sigil"` to prevent app-level TanStack cache collisions.

**Breaking changes:**

1. **Sync `new SigilClient(config)` constructor is now `private`.** TypeScript callers get a compile error; JS callers who cast through `any` trigger a runtime `SigilSdkDomainError(INVALID_CONFIG)` with a clear migration message.

   **Migration:**
   ```diff
   - const client = new SigilClient({ rpc, vault, agent, network });
   + const client = await SigilClient.create({ rpc, vault, agent, network });
   // or for test / mock harnesses:
   + const client = createSigilClient({ rpc, vault, agent, network });
   ```

   `SigilClient.create()` is the recommended path — it runs the genesis-hash assertion from Sprint 1. `createSigilClient()` is the lightweight factory that skips the assertion (suitable for test stubs that don't honor `getGenesisHash()`).

2. **Three new `SIGIL_ERROR__SDK__*` codes** in `/errors` subpath (total: 49 → 52):
   - `SIGIL_ERROR__SDK__HOOK_ABORTED` — `onBeforeBuild` returned `{ skipSeal: true }`
   - `SIGIL_ERROR__SDK__PLUGIN_REJECTED` — a plugin returned `{ allow: false }`
   - `SIGIL_ERROR__SDK__OWNER_REQUIRED` — owner-only `SigilVault` method called agent-only

**Non-breaking additions** to existing types:
- `SealParams`: `hooks?`, `correlationId?`
- `SigilClientConfig`: `hooks?`, `plugins?`
- `ClientSealOpts`: `hooks?`, `correlationId?`

Passing `undefined` or omitting these fields preserves pre-v0.11 behavior exactly. No consumer code needs to change unless they want to opt in to the new surface.

**Test delta:** 1,401 → 1,487 kit SDK (+86 new tests). Grand total 2,253 → 2,299.

**README:** new sections for Sigil Facade, Lifecycle Hooks, Policy Plugins, React Hooks. Migration guide for v0.10 → v0.11 and repeated grep table for the removed sync ctor.
