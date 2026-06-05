# docs/revamp/ — HISTORICAL V2 DESIGN ARCHIVE (SUPERSEDED)

> ⚠️ **This directory is a historical archive, not current spec.**

These documents are the Sigil **V2 design + audit corpus** produced May 2026 on
branch `revamp/v2-2026-05` (audits, phase reviews, prompt maps, interface/threat
specs). They are preserved for provenance only.

**Current sources of truth:**
- **`ROADMAP/`** — live milestone status (`STATUS.md`, `ENFORCEMENT_MODEL.md`, …)
- **`programs/sigil/src/`** — the shipped on-chain program (authoritative behavior)
- **`docs/`** (top level) — current architecture / error-code / spec docs

Do **not** treat anything here as the current design. Known divergence: these
docs list the Token-2022 extension allowlist as 3 items including
`NonTransferable`; **F-Q4 (`b710f6a9`) removed `NonTransferable`** — the live
accept-set is `MemoTransfer` + `MetadataPointer` only
(`programs/sigil/src/utils/token2022_extension.rs`). Other docs here likewise
predate later F-Q* / M1 / M3 work.
