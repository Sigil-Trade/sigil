---
"@usesigil/kit": minor
---

Silent-failure hardening + TEE fail-closed (PR 1.B safety lockdown).

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
