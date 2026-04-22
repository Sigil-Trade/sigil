<!--
Sigil PR template — single-trunk model.

All PRs target `main`. Auto-merge is DISABLED on `main` per ruleset.
You will need to click "Merge" manually after CI is green and review is approved.

If your PR touches `programs/sigil/`, expect the staging program (STAGSigi...)
to be redeployed to devnet automatically after merge. The production program
(4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL) is NEVER deployed by CI —
mainnet upgrades go through the Squads V4 multisig flow (see docs/DEPLOYMENT.md).
-->

## Summary

<!-- 1-3 bullets on what changed and why -->

## Risk surface

<!-- Tick the highest-risk box that applies. -->

- [ ] **On-chain program** (`programs/sigil/`) — bytecode change, IDL change, or account-layout change
- [ ] **Public SDK surface** (`sdk/kit/src/` exports, `@usesigil/*` packages) — breaking change requires changeset
- [ ] **CI/CD or workflow config** (`.github/workflows/`, `.github/CODEOWNERS`, ruleset)
- [ ] **Test infrastructure only** (no shipped behavior change)
- [ ] **Documentation only**

## Changeset

<!-- For SDK changes only. Run `pnpm changeset` and commit the generated file. -->

- [ ] I added a changeset (`.changeset/*.md`) — required for any SDK behavior change
- [ ] N/A — no SDK consumer-visible change

## Verification

<!-- What did you actually run locally? Be specific. -->

- [ ] `anchor build --no-idl` passes
- [ ] `pnpm test` passes (LiteSVM, ~45s)
- [ ] `pnpm run verify:error-drift` passes (if `errors.rs` or generated TS changed)
- [ ] `cd sdk/kit && pnpm build` passes (if SDK source changed)
- [ ] Surfpool integration ran (if program behavior changed)

## Devnet rehearsal

<!-- After merge, the staging program (STAGSigi...) auto-deploys to devnet.
     Verify your changes there before opening any follow-up PRs that depend on the new behavior. -->

- [ ] Will verify on devnet (staging program) within 24h of merge
- [ ] N/A — change does not require devnet verification

## Mainnet impact (if applicable)

<!-- Skip if pre-mainnet or doc-only. -->

- [ ] This change requires a mainnet program upgrade (Squads V4 multisig proposal — see `docs/DEPLOYMENT.md`)
- [ ] This change requires a mainnet timelock window (≥24h) before activation
- [ ] N/A

## Linked issues / context

<!-- e.g. Closes #123, refs Drift hack postmortem, references docs/SECURITY.md §X -->

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
