---
"@usesigil/kit": patch
---

Kit adapter barrel — centralize @solana/kit imports (PR 2.C).

Internal refactor: all 52 source files now import from `src/kit-adapter.ts` instead of directly from `@solana/kit`. No public API changes. Future Kit v7/v8 migration is now a 1-file diff.
