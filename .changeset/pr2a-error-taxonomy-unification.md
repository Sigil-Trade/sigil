---
"@usesigil/kit": minor
---

Error taxonomy unification — single `SigilError` (publicly `SigilKitError`) base class for the entire SDK.

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
new ShieldDeniedError(violations, 7021)
err.code === 7021                              // numeric on the legacy shield.ts version

// After:
new ShieldDeniedError(violations)              // 1-arg only
err.code === SIGIL_ERROR__SHIELD__POLICY_DENIED  // canonical SigilErrorCode
```

`PolicyViolation.suggestion` is now **required** (was optional in `shield.ts`). All existing throw sites in `shield.ts` author meaningful `.suggestion` text. Test fixtures must include it.

The canonical `PolicyViolation.rule` type is widened from a closed enum to `PolicyRule` — an open string-literal union with a `(string & {})` escape hatch. Existing rule values are listed; new values are permitted but should follow the snake_case convention.

### BREAKING — X402 numeric `.code` migration

Per UD1 (single canonical `.code`), the historical numeric `.code` fields on the X402 family (7024–7028) are replaced by the canonical `SigilErrorCode` string. The numeric values are preserved as `.legacyNumericCode` getters for one-minor migration ramp; deletion targeted at v1.0.

```ts
// Before:
new X402ParseError("...").code === 7024        // numeric

// After (preferred):
new X402ParseError("...").code === SIGIL_ERROR__X402__HEADER_MALFORMED

// After (transitional, deprecated, removed at v1.0):
new X402ParseError("...").legacyNumericCode === 7024
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
