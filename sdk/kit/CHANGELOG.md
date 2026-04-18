# @usesigil/kit

## 0.11.0

### Minor Changes

- [#244](https://github.com/Sigil-Trade/sigil/pull/244) [`5faa5a9`](https://github.com/Sigil-Trade/sigil/commit/5faa5a959d79d88648f5bcb10e18b16b064dadb0) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.11.0 — Sprint 2: Sigil facade + SigilVault + hooks + plugins + `/react`.** Additive convenience layer on top of Sprint 1 primitives, plus the long-planned removal of the deprecated sync `SigilClient` constructor.

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

## 0.10.0

### Minor Changes

- [#238](https://github.com/Sigil-Trade/sigil/pull/238) [`85c64c6`](https://github.com/Sigil-Trade/sigil/commit/85c64c66db7afda16a98c11b885ba7d4d6bb2021) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **v0.9.0 — Sprint 1 SDK surface fix.** Breaking but pre-1.0: closes Pentester findings F1, F3, F5, F7, F8, F10.

  **New entry points (recommended):**
  - `SigilClient.create(config)` async factory — asserts the RPC's genesis hash matches the configured network before returning. 3-retry 200 ms exponential backoff; cached per-RPC-instance.
  - `SigilLogger` pluggable logger interface + `NOOP_LOGGER` default + `createConsoleLogger()` + module-level install via `SigilClient`/`OwnerClient` constructors.
  - `SAFETY_PRESETS` (development, production) orthogonal to the existing `VAULT_PRESETS`; compose via `applySafetyPreset`.
  - `parseUsd("$100")` strict BigInt USD parser — no `parseFloat`, no leading-zero input, throws `SIGIL_ERROR__SDK__INVALID_AMOUNT` on malformed input.
  - `initializeVaultAtas({ vault, payer, mints, allowedMints })` — manual ATA-program `CreateIdempotent` instruction builder with caller-asserted allowlist check.
  - `validateAgentCapAggregate({ vaultDailyCap, existingAgentCaps, newAgentCap })` — rejects when sum of per-agent caps exceeds vault cap.
  - `/errors` subpath — all 49 `SIGIL_ERROR__*` discriminants now live at `@usesigil/kit/errors`.
  - `SOLANA_DEVNET_GENESIS_HASH` and `SOLANA_MAINNET_GENESIS_HASH` constants for caller-side cluster assertions.

  **Breaking changes:**
  1. `createVault` now requires three fields that previously had silent defaults:
     - `spendingLimitUsd` (was default `0n`)
     - `dailySpendingCapUsd` (was default `500_000_000n`)
     - `timelockDuration` (was default `0`)
       Explicit `0n` is still accepted for the Observer-agent case; set all three or spread `SAFETY_PRESETS.development` / `applySafetyPreset("production", {...})`.
  2. Sync `new SigilClient(config)` constructor is `@deprecated`. It still works for back-compat and for tests using stubbed RPCs, but emits a warning through the injected logger on every call. Migrate to `await SigilClient.create(config)`. Removal scheduled for Sprint 2.
  3. The 49 `SIGIL_ERROR__*` code constants moved from the root barrel to the `./errors` subpath:
     ```diff
     - import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit";
     + import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "@usesigil/kit/errors";
     ```
  4. Root barrel dropped ~325 exports. Removed: 37 Codama instruction builders (consumers use `seal()` / `createVault()` / `OwnerClient`), 82 hex error constants (internal-only), 60+ generated event and struct types (internal-only), the on-chain Anchor `SigilError` enum (internal-only). Kept: 12 account decoders (the supported RPC-read path), `SIGIL_PROGRAM_ADDRESS`, all public APIs.
  5. Every internal `console.warn`/`console.error`/`console.debug` in the SDK now routes through the injected logger. Production consumers who want stderr output must pass `logger: createConsoleLogger()` to `SigilClient.create()` / `createSigilClient()` / `OwnerClient`. `NOOP_LOGGER` is the silent default.

  **Security fixes:**
  - F10 (cluster mismatch): `SigilClient.create()` asserts `rpc.getGenesisHash()` matches the canonical devnet / mainnet hash before returning. Bypass via `skipGenesisAssertion: true` is supported only for local test harnesses and logs a warning.
  - F3 (aggregate cap): SDK now rejects `sum(per-agent caps) > vault daily cap` at `createVault` time.
  - F5 (silent daily cap default): the $500/day default is gone. Callers must supply `dailySpendingCapUsd` explicitly or use a `SAFETY_PRESETS` entry.
  - F7 (silent timelock default): the 0-second default is gone. `timelockDuration` is required.
  - F1 (USD parse rounding): `parseUsd()` uses BigInt arithmetic only; no `parseFloat` path exists.

  **Migration guide:** see `sdk/kit/README.md` "v0.8 → v0.9 migration" section and the grep table for every symbol removed.

  **Test delta:** +135 new tests (1,314 → 1,449 kit SDK) across `parse-usd.test.ts`, `ata.test.ts`, `logger.test.ts`, `validate-cap-aggregate.test.ts`, `seal-genesis.test.ts`, `public-surface.test.ts`, `create-vault.test.ts` additions, and `presets.test.ts` SAFETY_PRESETS suite.

## 0.8.1

### Patch Changes

- [#232](https://github.com/Sigil-Trade/sigil/pull/232) [`29a1385`](https://github.com/Sigil-Trade/sigil/commit/29a1385ebc7d72b74d698d2e4e3704d09da2bf20) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Complete audit follow-up: shield.ts import ordering, createOwnerClient + SUPPORTED_PROTOCOLS root barrel exports, priority-fees.ts registry-driven CU estimation, branded-types tests, README sections for Branded Types and MCP Round-Trip.

## 0.8.0

### Minor Changes

- [#224](https://github.com/Sigil-Trade/sigil/pull/224) [`2c73c71`](https://github.com/Sigil-Trade/sigil/commit/2c73c710236d248ef51bc875e9bb1ff5dd5e0e92) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Factory migration + fromJSON MCP round-trip + x402 documentation (PR 3.A).

  **BREAKING:** `SigilClient` and `OwnerClient` classes are **deprecated**. Use the new factory functions:

  ```ts
  // Before:
  const client = new SigilClient({ rpc, vault, agent, network });
  const owner = new OwnerClient({ rpc, vault, owner: signer, network });

  // After:
  const client = createSigilClient({ rpc, vault, agent, network });
  const owner = createOwnerClient({ rpc, vault, owner: signer, network });
  ```

  Both factory functions return the same API surface — same method names, same signatures. The factories carry context in closures (no `this` binding). Classes remain available for one minor as a migration ramp; removed at v1.0.

  **Why factory over class:** Tree-shakeable, no `this` footguns, composable, testable, aligned with @solana/kit v2 and viem patterns. The /fns subpath compromise was rejected in favor of the principled architecture.

  ### New: fromJSON MCP round-trip

  10 `fromJSON` functions for dashboard type deserialization:

  ```ts
  import { overviewDataFromJSON } from "@usesigil/kit/dashboard";

  // AI agent receives JSON from MCP tool → rehydrates typed object
  const overview = overviewDataFromJSON(jsonFromMcpTool);
  overview.spending.global.cap; // bigint (was string in JSON)
  ```

  Essential for MCP-based AI agent workflows where data round-trips through JSON tool responses.

  ### New: x402 documentation

  `@usesigil/kit/x402` subpath now documented in README with usage example. `shieldedFetch()` handles HTTP 402 payment negotiation with vault policy enforcement.

  ### Migration
  1. Replace `new SigilClient(...)` → `createSigilClient(...)`
  2. Replace `new OwnerClient(...)` → `createOwnerClient(...)`
  3. All method calls remain identical — no other changes needed

## 0.7.1

### Patch Changes

- [#223](https://github.com/Sigil-Trade/sigil/pull/223) [`84163f8`](https://github.com/Sigil-Trade/sigil/commit/84163f83c07b1454afc0f7dd0a9bef27cae3ae97) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Kit adapter barrel — centralize @solana/kit imports (PR 2.C).

  Internal refactor: all 52 source files now import from `src/kit-adapter.ts` instead of directly from `@solana/kit`. No public API changes. Future Kit v7/v8 migration is now a 1-file diff.

## 0.7.0

### Minor Changes

- [#222](https://github.com/Sigil-Trade/sigil/pull/222) [`bab2ea0`](https://github.com/Sigil-Trade/sigil/commit/bab2ea0583135c147a3c3af10bb15be714814fec) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Branded types + type consolidation (PR 2.B).

  **BREAKING:**
  - `addAgent()`, `queueAgentPermissions()`, `CreateVaultOptions` — `permissions` parameter is now `CapabilityTier` (was `bigint`). Use `capability(2n)` instead of `2n`.
  - `CreateVaultOptions` USD fields (`dailySpendingCapUsd`, `maxTransactionSizeUsd`, `spendingLimitUsd`) are now `UsdBaseUnits` (was `bigint`). Use `usd(500_000_000n)` instead of `500_000_000n`.
  - `DiscoveredVault` renamed to `VaultLocator`. Deprecated alias preserved for one minor.
  - New peer dependency: `@solana/errors@^6.2.0`.

  **New exports:**
  - `UsdBaseUnits`, `CapabilityTier`, `Slot` — branded bigint types (zero runtime cost)
  - `usd()`, `capability()`, `slot()` — constructor helpers
  - `VaultLocator` — renamed from `DiscoveredVault`

  **Migration:**

  ```ts
  import { usd, capability } from "@usesigil/kit";

  // Before: addAgent(vault, owner, "devnet", agent, 2n, 500_000_000n)
  // After:
  addAgent(vault, owner, "devnet", agent, capability(2n), usd(500_000_000n));
  ```

## 0.6.0

### Minor Changes

- [#220](https://github.com/Sigil-Trade/sigil/pull/220) [`06eb0d8`](https://github.com/Sigil-Trade/sigil/commit/06eb0d890aef7e91efa8555909cb1f186e381ccb) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Error taxonomy unification — single `SigilError` (publicly `SigilKitError`) base class for the entire SDK.

  **BREAKING:** Several focused breaks documented per category below. Pre-1.0 minor bump per project convention; review the migration notes before upgrading.

  ### What's new
  - **`SigilError` base class** (exported publicly as `SigilKitError`) with viem-style fields: `shortMessage`, `details`, `version`, `code`, `context`, `docsPath`, `metaMessages`, `cause`, `walk()`. The `.message` field is formatted with the short message plus a Version footer; `.shortMessage` carries the original verbatim.
  - **Six domain subclasses** under `SigilError`: `SigilShieldError`, `SigilTeeError`, `SigilX402Error`, `SigilComposeError`, `SigilSdkDomainError`, `SigilRpcError`.
  - **47 canonical `SIGIL_ERROR__<DOMAIN>__<DESCRIPTOR>` string-literal codes** + per-domain code unions (`SigilShieldErrorCode`, `SigilTeeErrorCode`, etc.).
  - **Type-safe `SigilErrorContext` map**: each code is bound at compile time to its required context shape (kit-style discriminated map).
  - **Per-module discriminated-union ErrorType exports** (viem pattern): `ShieldErrorType`, `TeeErrorType`, `X402ErrorType`, `ComposeErrorType`.
  - **`walkSigilCause(err, predicate?)` helper** for traversing `cause` chains with cycle protection (max-depth 10).

  All twelve existing error classes (`ShieldDeniedError`, `ShieldConfigError`, `ComposeError`, `X402ParseError`, `X402PaymentError`, `X402UnsupportedError`, `X402DestinationBlockedError`, `X402ReplayError`, `TeeAttestationError`, `AttestationCertChainError`, `AttestationPcrMismatchError`, `SigilSdkError`) are preserved as subclasses of their domain class. Existing `instanceof OldName` checks continue to work.

  ### BREAKING — `ShieldDeniedError`

  The duplicate definition in `src/shield.ts` was collapsed into the canonical version in `src/core/errors.ts`. The `code?: number` second constructor argument is **removed**. Replace:

  ```ts
  // Before:
  new ShieldDeniedError(violations, 7021);
  err.code === 7021; // numeric on the legacy shield.ts version

  // After:
  new ShieldDeniedError(violations); // 1-arg only
  err.code === SIGIL_ERROR__SHIELD__POLICY_DENIED; // canonical SigilErrorCode
  ```

  `PolicyViolation.suggestion` is now **required** (was optional in `shield.ts`). All existing throw sites in `shield.ts` author meaningful `.suggestion` text. Test fixtures must include it.

  The canonical `PolicyViolation.rule` type is widened from a closed enum to `PolicyRule` — an open string-literal union with a `(string & {})` escape hatch. Existing rule values are listed; new values are permitted but should follow the snake_case convention.

  ### BREAKING — X402 numeric `.code` migration

  Per UD1 (single canonical `.code`), the historical numeric `.code` fields on the X402 family (7024–7028) are replaced by the canonical `SigilErrorCode` string. The numeric values are preserved as `.legacyNumericCode` getters for one-minor migration ramp; deletion targeted at v1.0.

  ```ts
  // Before:
  new X402ParseError("...").code === 7024; // numeric

  // After (preferred):
  new X402ParseError("...").code === SIGIL_ERROR__X402__HEADER_MALFORMED;

  // After (transitional, deprecated, removed at v1.0):
  new X402ParseError("...").legacyNumericCode === 7024;
  ```

  All five X402 leaf classes follow the same pattern.

  ### BREAKING — `ComposeError.code` migration

  Same pattern as X402. The historical `ComposeErrorCode` string union (`"missing_param"`, `"invalid_bigint"`, `"unsupported_action"`) on `.code` is replaced by the canonical `SigilErrorCode` string. The original is preserved as `.legacyComposeCode`. The internal translation map is `COMPOSE_LEGACY_TO_SIGIL`.

  ### BREAKING — `.message` format

  The `SigilError` base appends a Version footer (`"\n\nVersion: @usesigil/kit@<version>"`) to `.message` per the viem pattern. Tests asserting `.message === "..."` exactly must switch to `.message.includes("...")` or read `.shortMessage` for the verbatim message.

  ### Limitation — `SigilSdkError` not (yet) under `SigilError`

  The existing `SigilSdkError` (in `src/agent-errors.ts`) implements the `AgentError` interface, whose `.code: string` is wider than `SigilErrorCode`. TypeScript property variance blocks shadowing the base `.code` with a wider type. Per UD3 (defer AgentError class promotion):
  - `instanceof SigilSdkError` still works.
  - `instanceof Error` still works.
  - `instanceof SigilError` (or `SigilKitError`) returns **`false`** for `SigilSdkError` instances.

  For new SDK-domain throws where AgentError conformance is not required, use the new `SigilSdkDomainError` class (also exported). A follow-up PR will promote `AgentError` to `SigilAgentError` class and unify the two SDK error classes under one hierarchy.

  ### Migration cheat sheet

  ```ts
  // Old: per-class catch
  catch (e) {
    if (e instanceof ShieldDeniedError) { ... }
    if (e instanceof X402ParseError) { ... }
  }

  // New: domain-level catch + code discrimination
  catch (e) {
    if (e instanceof SigilShieldError) {
      if (e.code === SIGIL_ERROR__SHIELD__POLICY_DENIED) { ... }
    }
    if (e instanceof SigilX402Error) {
      if (e.code === SIGIL_ERROR__X402__HEADER_MALFORMED) { ... }
    }
  }

  // Or use the per-module discriminated union (viem pattern)
  catch (e) {
    const err = e as ShieldErrorType;
    if (err instanceof ShieldDeniedError) console.error(err.violations);
  }
  ```

  ### Naming note — `SigilKitError`

  The base class is named `SigilError` internally but exposed publicly as `SigilKitError` to avoid a name collision with the on-chain Anchor error enum (`SigilError` from `generated/errors/sigil.ts`). Internal SDK code uses `SigilError`; consumers see `SigilKitError`. A future cleanup PR can rename the internal class and remove the alias.

  ### Inspired by
  - viem's `BaseError` ([source](https://github.com/wevm/viem/blob/main/src/errors/base.ts))
  - `@solana/kit`'s `SolanaError` + numeric code map ([source](https://github.com/anza-xyz/kit/tree/main/packages/errors/src))

  Triage research and council pressure-test in `~/.claude/MEMORY/WORK/20260414-071941_sdk-full-spectrum-audit/` and `Plans/patient-coiling-ledger.md`.

## 0.5.0

### Minor Changes

- [#218](https://github.com/Sigil-Trade/sigil/pull/218) [`06e2e3b`](https://github.com/Sigil-Trade/sigil/commit/06e2e3b62ba7a13ee6a11eb9f175311ad114291d) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Silent-failure hardening + TEE fail-closed (PR 1.B safety lockdown).

  ### Behavior change (read this before upgrading)

  **`verifyTeeAttestation(wallet)` now defaults to `requireAttestation: true`.** A call with no config throws `TeeAttestationError` on any non-verified status (including `Failed` from a custody-API error, `Unavailable` from a non-TEE wallet, and unmet minimum levels). Previously the function returned silently with a degraded status, which allowed default-path callers to treat the wallet as fine without inspecting `.status` — the silent-degradation vector this release closes.

  `TeeAttestationError` now carries the full `AttestationResult` as a `.result` property. `Sentry.captureException(err)` auto-serializes `err.result.status`, `.provider`, `.publicKey`, and `.metadata.verifiedAt` with zero callsite instrumentation.

  #### Migration

  Callers who genuinely want the forgiving behavior must opt in explicitly AND supply `onDegraded` — omitting the callback is treated as the silent-degradation vector this default prevents and throws:

  ```ts
  await verifyTeeAttestation(wallet, {
    requireAttestation: false,
    onDegraded: (r) => Sentry.captureMessage("tee-degraded", { extra: r }),
  });
  ```

  ### TEE provider-trusted tightening

  When `verifyProviderCustody()` throws in the Crossmint and Privy providers, the SDK now returns `AttestationStatus.Failed` with a structural transport classification (`rawAttestation.transport: boolean`) and a redacted cause (`rawAttestation.cause`). Previously this path silently downgraded to `ProviderTrusted`, allowing any consumer with `minAttestationLevel: "provider_trusted"` to pass attestation during a transport failure, DNS outage, or MitM intercept.

  The dispatcher's former `isCustodyFallback` cache-skip branch (`verify.ts:137–150` pre-release) is removed — `Failed` is already excluded from the cache-eligible status set, so the branch became unreachable.

  ### Typed `isAccountNotFoundError`

  `getPolicy`, `getOverview`, and `getVaultSummary` now classify account-not-found errors via `isSolanaError(err, CODE)` across four `@solana/errors` codes:
  - `SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND` (3)
  - `SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND` (3230000)
  - `SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND` (7050003)
  - `SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND` (7050004)

  The predicate is a true type guard (`err is SolanaError<Code>`), so matched branches retain Kit's typed context without casts. Legacy web3.js 1.x substring matching (`"could not find"` / `"Account does not exist"`) is preserved as a fallback and can be dropped in a follow-up once transitive web3.js 1.x usage is confirmed gone.

  ### Additional silent-failure sites hardened

  Six additional bare-catch sites now emit redacted diagnostics instead of swallowing errors silently:
  - `dashboard/mutations.ts` — `close_vault` existence check logs RPC failure instead of silently omitting a PDA from `remaining_accounts` (which surfaced downstream as an opaque `AccountMissing`).
  - `dashboard/discover.ts` — vault decode failures log instead of silently dropping the vault from discovery results (previously hid data corruption from the owner).
  - `priority-fees.ts` — Helius and RPC fee-estimation failures log so API-shape drift is detectable instead of silently falling through to the default fee.
  - `x402/facilitator-verify.ts` — settlement-verification warnings now include the redacted cause.
  - `seal.ts` — output-stablecoin ATA existence RPC failure pushes a diagnostic warning; ALT cache-verify retries log the eviction reason.
  - `vault-analytics.ts` — `getVaultSummary`'s `getPendingPolicyForVault(rpc, vault).catch(() => null)` now re-throws non-account-not-found errors rather than collapsing every failure to "no pending update."

  ### New exported helpers

  ```ts
  import {
    isAccountNotFoundError,
    isTransportError,
    redactCause,
  } from "@usesigil/kit";
  ```

  `isTransportError` is a structural classifier (no message regex) covering POSIX codes, undici's `UND_ERR_*` set, TLS errors, HTTP/2 stream/session resets, DOMException `AbortError`/`TimeoutError`, `AggregateError` recursion, and `statusCode`-tagged HTTP 5xx responses. The provider-denial denylist (`ProviderDeniedError`, `CustodyDeniedError`, etc.) short-circuits to `false` so business denials aren't retry-classified.

  `redactCause` returns a safe `{ name?, message?, code? }` projection. Every property access is try-guarded, `.stack` is never read (may embed URLs/tokens), Proxy/null-prototype/throwing-getter inputs yield `{}` rather than throwing through, and cyclic cause chains are broken via `WeakSet`.

  ### Peer dep added

  `@solana/errors` is now a peer dependency, tracking `@solana/kit`'s declared range:

  ```bash
  pnpm add @usesigil/kit @solana/kit @solana/errors
  ```

  Inside a pnpm workspace, the transitive copy of `@solana/errors` installed by `@solana/kit` will satisfy the new peer automatically. External consumers must add the package explicitly. The peer declaration expresses a **contract** — "this package expects `@solana/errors` to resolve alongside `@solana/kit`" — it does NOT guarantee deduplication. A consumer whose transitive graph pins `@solana/errors` to a different version than `@solana/kit`'s exact pin can still end up with duplicate `SolanaError` classes across the install tree, breaking `instanceof` narrowing.

  To preserve the narrowing guarantee, install `@solana/errors` at the same version `@solana/kit` pins (inspect `pnpm view @solana/kit@<version> dependencies`), or use a package-manager resolution override if you have conflicting transitive constraints. `isAccountNotFoundError`'s substring fallback keeps the function working when class identity is lost, but the typed narrowing branch relies on a single `SolanaError` copy.

  ### Additional notes for migrators
  - `SealResult.warnings` gained a new warning class for the output-stablecoin ATA RPC-failure path (distinct from the pre-existing "ATA does not exist" warning, which meant "create the ATA"). The two warnings carry **inverted remediations** — if you pattern-match on warning text, treat the new "existence check failed due to RPC error" warning as "retry later," not as "create the ATA." Text-matching is advisory; a future release may introduce a structured `warning.kind` discriminator.
  - `getVaultSummary` now re-throws non-account-not-found errors from `getPendingPolicyForVault` instead of collapsing every failure to `pendingPolicy: null`. Callers that weren't catching from `getVaultSummary` will now see RPC transport errors surface — wrap in try/catch if you were previously relying on the silent-null behavior.

## 0.4.0

### Minor Changes

- [#212](https://github.com/Sigil-Trade/sigil/pull/212) [`1ed3499`](https://github.com/Sigil-Trade/sigil/commit/1ed3499f04e55d97e4906bac9c7dbd8a452e7737) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 1 safety lockdown (PR 1.A — quick wins) — 6 targeted fixes addressing the full-spectrum SDK audit:
  - **Fix broken `VAULT_PRESETS` capability values.** All four presets (`jupiter-swap-bot`, `perps-trader`, `lending-optimizer`, `full-access`) now use `FULL_CAPABILITY` (= `2n`, Operator) for both `capability` and `permissions`. Previous values used the legacy 21-bit permission bitmasks (`SWAP_ONLY`, `PERPS_FULL | SWAP_ONLY`, `LENDING_PERMISSIONS`) which either registered agents as Observer (cannot execute anything — silently wrong) or exceeded the on-chain `capability <= 2n` invariant and were rejected with `InvalidArgument`.
  - **Remove the pre-v6 permission API from the public root export.** `SWAP_ONLY`, `PERPS_ONLY`, `TRANSFER_ONLY`, `ESCROW_ONLY`, `PERPS_FULL`, `ACTION_PERMISSION_MAP`, `hasPermission`, `permissionsToStrings`, `stringsToPermissions`, and `PermissionBuilder` are no longer re-exported from `@usesigil/kit`. They encoded a pre-v6 permission model the on-chain program replaced with a 2-bit capability enum. `FULL_CAPABILITY` / `FULL_PERMISSIONS` (both `2n`) remain the canonical spending-agent capability. The identifiers still exist inside `src/types.ts` for internal use but are no longer part of the public surface.
  - **Stop silencing stablecoin-ATA decode errors.** `resolveVaultState` used a bare `try/catch` around USDC and USDT balance parsing that swallowed both legitimate "account missing" and actual decode failures. Downstream, `seal.ts` uses `stablecoinBalances` as the drain-detection baseline — a spurious zero silently disabled the `LARGE_OUTFLOW` / `FULL_DRAIN` gates. Missing-ATA still returns `0n` (the `.exists` guard handles it); genuine parse errors now propagate so callers refuse to transact on unknown state instead of transacting on zero.
  - **Per-RPC blockhash cache (SDK-wide).** Three module-level `BlockhashCache` singletons (`dashboard/mutations.ts`, `seal.ts`, `owner-transaction.ts`) all shared state across every consumer — a dashboard that switches `devnet ↔ mainnet`, a CLI `--network` flag, or an MCP server multiplexing tenants would pull a blockhash fetched against one RPC and send it against another, producing intermittent `BlockhashNotFound` that the 30s TTL then hid. A new `getBlockhashCache(rpc)` helper in `rpc-helpers.ts` hands out caches keyed by RPC-client identity via `WeakMap<Rpc, BlockhashCache>`: consumers who reuse an RPC client keep the perf win; distinct RPCs stay isolated; short-lived RPC handles can be garbage-collected. The per-instance cache inside `SigilClient` is unaffected (already correctly scoped). Exported from `@usesigil/kit` so consumers can call `.invalidate()` explicitly when needed.
  - **Guard `buildHealth` against partial `OverviewContext`.** Matches the three peer `build*` helpers — emits a labeled `[dashboard/reads] OverviewContext.state.vault is required but missing` error instead of a cryptic NPE when a test fixture or custom composition passes a context without `state.vault`. The guard only fires when the helper actually needs to touch `state.vault` (non-memoized path); consumers that pre-populate `ctx.posture` and `ctx.alerts` — the whole reason for `OverviewContext` — still work.
  - **Mark S14 composition primitives `@experimental`.** The six `build*` helpers (`buildVaultState`, `buildAgents`, `buildSpending`, `buildHealth`, `buildPolicy`, `buildActivityRows`), plus `OverviewData` and `GetOverviewOptions`, now carry `@experimental` JSDoc. Their field shapes and memoization pipeline may shift before v1.0; pin your SDK version if you depend on this surface.
  - **Fix misleading SPL-Token-Transfer error message in `seal.ts`.** The top-level Transfer block no longer advises consumers to "Use the Transfer ActionType instead" (`ActionType` was removed in v6). The message now reflects the current API: transfers must route through an approved DeFi program's CPI; for owner-initiated withdrawals, use `OwnerClient.withdraw()`.

  **Breaking:** removal of the legacy permission re-exports from the package root. Third-party consumers of `OwnerClient` / `SigilClient` / presets / vault-creation are unaffected — the only outward change is that agents registered via presets now actually execute.

  **Migration guidance — do NOT treat `FULL_CAPABILITY` as a drop-in for `SWAP_ONLY`.** The v6 on-chain model replaced the 21-bit permission bitmask with a 2-bit capability enum:
  - `0` = Disabled (no execution)
  - `1` = Observer (read-only, cannot sign anything)
  - `2` = Operator (full spending authority) — exported as `FULL_CAPABILITY`

  There is **no middle ground**. Granular per-action restriction ("can swap but cannot transfer", "can open positions but cannot add collateral") no longer lives on the capability field — it moved to on-chain `InstructionConstraints`. If your previous code imported `SWAP_ONLY` (= `1n`) intending "agent can swap," the faithful replacement is `FULL_CAPABILITY` (= `2n`) _combined with_ a constraints policy that only allows your chosen DeFi programs. Using `FULL_CAPABILITY` alone gives the agent full spending authority bounded only by the vault's spending caps and protocol allowlist.

  `createVault()` now validates this client-side: passing any `permissions` value outside `[0n, 2n]` throws a descriptive error before any RPC roundtrip, catching the common "I imported `PERPS_FULL | SWAP_ONLY` and things look fine" mistake immediately.

## 0.3.0

### Minor Changes

- [#205](https://github.com/Sigil-Trade/sigil/pull/205) [`d11d0e3`](https://github.com/Sigil-Trade/sigil/commit/d11d0e34cca1c83d17f6fb144470a5dde332e4e5) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - **S14 — `OwnerClient.getOverview()` single-call convenience + shared-context refactor**

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

## 0.2.3

### Patch Changes

- [#203](https://github.com/Sigil-Trade/sigil/pull/203) [`4209b98`](https://github.com/Sigil-Trade/sigil/commit/4209b98de517acd95fee08be366b8d1b2e03a4b4) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Phase 1 SDK convenience layer (trivial items):
  - **S19** — Export `toUsdNumber` (renamed from private `usdToNumber`) and add inverse `fromUsdNumber` with NaN/Infinity `TypeError` guard plus magnitude `RangeError` guard at the documented precision ceiling. Also export `FROM_USD_NUMBER_MAX` so consumers can pre-validate without redefining the constant. `toUsdNumber` now throws `RangeError` on negative input to make its "non-negative" precondition a runtime contract instead of a docstring-only hint.
  - **S5** — Replace 5 `:any` callback params in `dashboard/reads.ts` with concrete types (`SecurityCheck`, `Alert`, `SpendingBreakdown["byProtocol"][number]`, `unknown`).
  - **S7** — Add optional `type?: ActivityType` filter to `ActivityFilters`; applied in `getActivity`. Also fixes the post-ActionType-elimination silent-failure where `mapCategory` could not produce `open_position`/`close_position` for v6 events: `positionEffect` is now plumbed through and used as the primary discriminator.
  - **S8** — Add client-side bounds validation to `queuePolicyUpdate`: `approvedApps.length ≤ MAX_ALLOWED_PROTOCOLS` and `maxConcurrentPositions` via existing `requireU8` (0-255, on-chain u8 type). New `MAX_ALLOWED_PROTOCOLS` constant exported from the SDK's main entry.

  **S8 scope note:** Pre-validation intentionally covers only these 2 fields plus existing `timelock`/`dailyCap`/`maxPerTrade`/`developerFeeRate` checks. Other bounded `queuePolicyUpdate` fields (`allowedDestinations` length, `protocolCaps` length-match with protocols, `maxSlippageBps`, `sessionExpirySlots` range) remain on-chain-only — the SDK JSDoc now enumerates which fields are pre-validated vs on-chain-only.

  **Tests added:** 7 queuePolicyUpdate validation tests (approvedApps length boundary both sides, maxConcurrentPositions u8 overflow / negative / non-integer / boundary), 1 toUsdNumber negative-guard test, 1 fromUsdNumber exact-boundary RangeError test.

## 0.2.2

### Patch Changes

- [#174](https://github.com/Kaleb-Rupe/sigil/pull/174) [`f9f874c`](https://github.com/Kaleb-Rupe/sigil/commit/f9f874c877979219dc7d5d7d3cd6ef27d0c443c1) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Remove external protocol bindings (Flash Trade, Kamino) from SDK source and npm package

  Moved 108,700 lines of Codama-generated external protocol code out of `src/generated/protocols/` into a gitignored `generated-protocols/` directory. These files were never imported at runtime and were inflating the published package. The SDK's public API is unchanged — `seal()`, `createVault()`, instruction builders, and all exports remain identical. Protocol bindings can be regenerated locally via `pnpm codama:all`.

## 0.2.1

### Patch Changes

- [#171](https://github.com/Kaleb-Rupe/sigil/pull/171) [`853f965`](https://github.com/Kaleb-Rupe/sigil/commit/853f965fbd682ff9539b98b87ed5064b49ded5be) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - fix: audit fixes — active session guard, agent_transfer TOCTOU, SDK error codes

  **On-chain program changes:**
  - H-1: Add `active_sessions: u8` counter to AgentVault (SIZE 634→635). Incremented in `validate_and_authorize`, decremented in `finalize_session`. `close_vault` now requires `active_sessions == 0` — prevents vault closure while SPL delegation is active. New error: `ActiveSessionsExist` (6075).
  - M-1: Add `expected_policy_version: u64` parameter to `agent_transfer` with on-chain TOCTOU check via `PolicyVersionMismatch` (6072). Matches existing pattern in `validate_and_authorize`.
  - M-3: Document per-protocol cap simple-window limitation on `get_protocol_spend` and `record_protocol_spend`.

  **SDK changes (@usesigil/kit):**
  - Fix pre-existing error code off-by-1: removed ghost `TimelockActive` entry at code 6027 (deleted from on-chain program but still in SDK), renumbered 44 entries to match IDL.
  - Add 5 missing error codes: `TimelockTooShort` (6071), `PolicyVersionMismatch` (6072), `PendingAgentPermsExists` (6073), `PendingCloseConstraintsExists` (6074), `ActiveSessionsExist` (6075).
  - Fix `extractErrorCode()` bounds: `<= 6069` → `<= 6075`.
  - Codama regeneration: `agentTransfer` instruction gains `expectedPolicyVersion`, `validateAndAuthorize` vault now writable, `AgentVault` gains `activeSessions`.

  **Plugins (@usesigil/plugins):**
  - Patch for compatibility with updated `@usesigil/kit` types.

## 0.2.0

### Minor Changes

- [#169](https://github.com/Kaleb-Rupe/sigil/pull/169) [`926bb76`](https://github.com/Kaleb-Rupe/sigil/commit/926bb7683df4533249dd5b61a0a8d048ba62cfd2) Thanks [@Kaleb-Rupe](https://github.com/Kaleb-Rupe)! - Add OwnerClient DX convenience layer at `@usesigil/kit/dashboard`. Provides stateless, JSON-serializable owner-side vault management with 6 read functions, 23 mutations, and vault discovery. All amounts are raw bigint with toJSON() for MCP/REST serialization.

## 0.1.0

### Minor Changes

- Initial public release of the Sigil SDK — on-chain guardrails for AI agents on Solana.
