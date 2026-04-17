---
"@usesigil/kit": minor
---

**v0.9.0 — Sprint 1 SDK surface fix.** Breaking but pre-1.0: closes Pentester findings F1, F3, F5, F7, F8, F10.

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
