<!--
Sigil PR template — single-trunk model.

All PRs target `main`. Auto-merge is DISABLED on `main` per ruleset.
You will need to click "Merge" manually after CI is green and review is approved.

If your PR touches `programs/sigil/src/**` or `Anchor.toml`, the devnet program
(7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK) is redeployed to devnet
automatically after merge to main (`deploy-devnet.yml`). This is a devnet
development deployment — mainnet is not in scope yet.
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

<!-- After merge, the devnet program auto-deploys (if you touched `programs/sigil/src/**`).
     Verify your changes there before opening any follow-up PRs that depend on the new behavior. -->

- [ ] Will verify on devnet within 24h of merge
- [ ] N/A — change does not require devnet verification

## Linked issues / context

<!-- e.g. Closes #123, refs Drift hack postmortem, references the root SECURITY.md disclosure policy -->

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
