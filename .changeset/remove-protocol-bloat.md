---
"@usesigil/kit": patch
---

Remove external protocol bindings (Flash Trade, Kamino) from SDK source and npm package

Moved 108,700 lines of Codama-generated external protocol code out of `src/generated/protocols/` into a gitignored `generated-protocols/` directory. These files were never imported at runtime and were inflating the published package. The SDK's public API is unchanged — `seal()`, `createVault()`, instruction builders, and all exports remain identical. Protocol bindings can be regenerated locally via `pnpm codama:all`.
