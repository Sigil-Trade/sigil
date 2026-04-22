# Sigil Deployment Guide

End-to-end deployment, release, and promotion model for the Sigil program + SDK packages. This is the single source of truth for "how does code get from a PR to a deployed Solana program and a published npm package?"

> **Upgrade Authority & Governance:** See [SECURITY.md](SECURITY.md) for the program upgrade authority + Squads V4 multisig migration plan.

---

## 0. Branching Model — Single-Trunk

Sigil follows the **trunk-based development** pattern used by every mature Solana protocol I surveyed (Squads, Drift, MarginFi, Kamino, Jupiter):

```
                            ┌───────── PR ─────────┐
                            │                       │
  feature/xyz ─────────────►│ CI runs full suite    │─────► main (trunk)
                            │ 1+ approving review   │       (only branch)
                            │ Manual merge click    │
                            └──────────────────────┘
                                                    │
                                                    ├──► Auto-deploys STAGING
                                                    │    program (STAGSigi…)
                                                    │    on devnet
                                                    │
                                                    ├──► Publishes
                                                    │    @usesigil/kit@canary
                                                    │
                                                    └──► If SDK changeset present:
                                                         opens "Version Packages" PR
                                                         (you click merge to release
                                                         @latest stable)

                              (when mainnet ships, separately:)

                  main HEAD ──► Manual workflow_dispatch
                                 │
                                 ├──► CI builds + verifies bytecode
                                 ├──► CI uploads buffer to mainnet
                                 └──► CI files Squads V4 multisig proposal
                                       │
                                       ├──► ≥24h timelock window
                                       └──► Humans sign in Squads UI
                                             │
                                             └──► Production program
                                                  (4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL)
                                                  upgraded
```

**Key invariants:**

| Invariant                                                                         | Why                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| There is no `staging` git branch. "Staging" is a separate Solana program account. | Eliminates deploy-race + branch-divergence failure modes. Pattern from Squads + Kamino. |
| `main` is the only long-lived branch. All work merges via PR.                     | Single source of truth. No reconciliation work between branches.                        |
| Auto-merge is **disabled** on `main`. Every merge requires a human click.         | Drift hack lesson — even one bypass class can cost $285M.                               |
| CI never holds mainnet upgrade authority.                                         | Universal Solana pattern. CI compromise must not = program drain.                       |
| Mainnet upgrades require Squads V4 multisig with **non-zero timelock** (≥24h).    | Drift removed timelock March 26, 2026 → drained $285M six days later.                   |

### Approving-review threshold — solo-dev mode today

The `main-protection` ruleset currently sets `required_approving_review_count: 0` with `require_code_owner_review: false`. GitHub does not allow PR authors to approve their own PRs, so a 1-reviewer requirement on a solo-dev repo = permanent merge block.

**Every other protection stays active:** PR required, CI must pass (Security Gate), linear history enforced, conversation threads must resolve, no auto-merge anywhere, squash/rebase only.

Review still happens — the PR flow forces you to look at the diff in the web UI before clicking merge. GitHub just doesn't gate the click on an approval event that's impossible to produce.

**When a 2nd permanent maintainer joins:** update the ruleset via `gh api -X PUT repos/Sigil-Trade/sigil/rulesets/13087437 …` to set `required_approving_review_count: 1` and `require_code_owner_review: true`. `.github/CODEOWNERS` auto-requests the right reviewer for each path.

---

## 1. PR Flow (Day-to-Day)

### 1.1 Create your branch

```bash
git checkout main
git pull --ff-only
git checkout -b feat/my-thing  # or fix/, chore/, docs/, refactor/
```

### 1.2 Make your changes + add a changeset (if SDK changes)

```bash
# ... edits ...

# If you changed any @usesigil/* package's behavior:
pnpm changeset
# Walk through the prompt. Commit the .changeset/*.md file.
```

### 1.3 Open the PR against `main`

```bash
gh pr create --base main
# Fill out the PR template.
```

### 1.4 CI runs the full Security Gate suite

| Job                                | What it checks                                   |
| ---------------------------------- | ------------------------------------------------ |
| Build, Lint & TS Tests             | sdk/kit + packages tsc + 1,500+ tests            |
| On-Chain Tests (LiteSVM)           | 286+ Anchor tests, no validator                  |
| Surfpool Integration Tests         | Realistic devnet-fork tests                      |
| Build Verification (Feature Flags) | All Cargo feature combinations build             |
| Rust Format & Clippy               | `cargo fmt --check` + `cargo clippy -D warnings` |
| Formal Verification (Certora)      | Sigil-specific safety properties                 |
| Fuzz Test (Trident, 1000 iter)     | Property-based fuzz                              |
| Security Scan (Sec3 X-Ray)         | Solana-specific static analysis                  |
| CodeQL + Analyze                   | GitHub native security scanning                  |
| Security Gate                      | Aggregator — gates merge                         |

### 1.5 Review

- **Today (solo dev):** review your own PR in the GitHub web UI before merging. `required_approving_review_count: 0` in the ruleset because GitHub blocks self-approval. Discipline is: read the diff, verify the CI artifacts, then click merge.
- **When 2nd dev joins:** bump `required_approving_review_count` to 1, flip `require_code_owner_review: true`. `.github/CODEOWNERS` paths auto-request the right reviewer for changed files.
- Force-push allowed on the PR branch (not on `main`).

### 1.6 Merge (manual click)

Once green and approved, **YOU click "Merge"** in the GitHub UI. Auto-merge is disabled on `main` per ruleset. There is no `gh pr merge --auto` shortcut. This is the human-gate that prevents supply-chain incidents.

---

## 2. What Happens After Merge

Within ~5 minutes of merging to `main`:

### 2.1 Staging program redeployed (if `programs/sigil/src/**` or `Anchor.toml` changed)

`deploy-devnet.yml` builds the program with **staging program ID** (`STAGSigi…`), deploys it to devnet, refreshes the IDL, runs verification.

The staging program is a separate on-chain account from production. Wipe-and-redeploy is safe — no real funds depend on its state.

```
Production program: 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL  ← never touched by CI today
Staging program:    STAGSigi…  ← redeployed every main merge after program changes
```

When mainnet ships, the production program ID flips meaning: it lives on mainnet (not devnet), and only the Squads V4 multisig flow can upgrade it (Section 5).

### 2.2 Snapshot npm publish (every main merge that touches `sdk/**` or `packages/**`)

`release-canary.yml` runs `pnpm changeset version --snapshot canary` to produce SHA-suffixed pre-release versions like `0.16.0-canary-abc1234`, then publishes to npm with the `@canary` dist-tag. This lets integrators pin against the latest devnet-tested SDK without affecting `@latest` consumers.

```bash
# Consumer pulling staging:
npm install @usesigil/kit@canary

# Consumer pulling stable:
npm install @usesigil/kit@latest  # or just: @usesigil/kit
```

Snapshot versions are SHA-suffixed and **never** shadow stable releases.

### 2.3 Stable npm release (when changeset is present)

If your PR included a `.changeset/*.md` file, the Changesets bot opens a "**Version Packages**" PR after merge. This PR bumps versions, generates changelogs, and deletes the consumed changesets. **You manually merge that PR** (no auto-merge) to publish stable to `@latest`.

---

## 3. CODEOWNERS Activation Path

Today `.github/CODEOWNERS` lists `@Kaleb-Rupe` as sole owner everywhere. The `main-protection` ruleset's `require_code_owner_review: true` rule is in place. When the team grows:

| Event                          | Action                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2nd permanent maintainer joins | Replace `@Kaleb-Rupe` on `programs/sigil/`, `sdk/kit/src/`, `.github/workflows/` paths with `@Sigil-Trade/maintainers` team (≥2 members). Branch protection auto-enforces 2-reviewer rule for those paths. |
| Mainnet ships                  | Also activate path-filtered "Required reviewers: 2" rule on the same paths via ruleset update. Add `actions/attest-build-provenance` to release.yml.                                                       |
| Squads multisig active         | CI deploy job for production program is removed entirely; mainnet upgrades go through `mrgnlabs/squads-program-upgrade@v0.3.1` (or fork) which creates a multisig proposal — not a deploy.                 |

---

## 4. NPM Release Mechanics

### Stable releases (`@usesigil/kit@latest`)

1. Make changes on a feature branch.
2. Run `pnpm changeset` → creates a `.changeset/abc.md` file describing the change + bump type.
3. Open PR. CI runs.
4. Merge PR (manual click).
5. **Changesets bot opens a "Version Packages" PR** that bumps versions and generates `CHANGELOG.md` entries.
6. Review the Version Packages PR. Verify the version bump is correct.
7. Merge the Version Packages PR (manual click).
8. CI publishes to npm with **OIDC Trusted Publishing + provenance attestation**. No npm tokens stored.

### Snapshot releases (`@usesigil/kit@canary`)

Automatic on every merge to `main` that touches `sdk/**` or `packages/**`. Version format: `<currentVersion>-canary-<sha>`. Consumers opt in via `@canary` dist-tag.

### Release verification

```bash
# Show what's published per dist-tag:
npm dist-tag ls @usesigil/kit

# Expected:
# canary: 0.16.0-canary-abc1234
# latest: 0.16.0
```

---

## 5. Pre-Mainnet Checklist

**Do not flip `main` to deploy mainnet until ALL of these are checked.**

### 5.1 Multisig migration (Squads V4)

- [ ] Squads V4 multisig created (recommend 2-of-3 or 3-of-5; more signers ≠ more security per Drift hack lessons)
- [ ] Multisig config has **non-zero timelock ≥ 24 hours** (Drift hack: zero timelock = $285M loss in 6 days)
- [ ] Test full upgrade flow on devnet with the multisig as upgrade authority
- [ ] Migrate program upgrade authority from current EOA to Squads multisig vault PDA via `solana program set-upgrade-authority`
- [ ] Migrate ALT authority to a separate Squads multisig (per [alt-authority-migration.md](../MEMORY/alt-authority-migration.md))
- [ ] Document signer rotation procedure
- [ ] Rehearse a deploy proposal in production multisig (signing without applying)

### 5.2 CI/CD hardening

- [ ] Remove `DEVNET_DEPLOY_KEYPAIR` from CI secrets (CI no longer deploys to mainnet — humans do via Squads UI)
- [ ] Add `mrgnlabs/squads-program-upgrade@v0.3.1` (or fork to Sigil-Trade org) to a new `release-mainnet.yml` workflow
- [ ] Workflow: build verifiable bytecode → upload buffer to mainnet → file Squads proposal → Slack/email notify signers
- [ ] Activate 2-reviewer CODEOWNERS rule on `programs/sigil/` and `.github/workflows/`
- [ ] Add `actions/attest-build-provenance` step to `release.yml` for stable npm publishes

### 5.3 Audit + verification

- [ ] External security audit completed + critical findings resolved
- [ ] `solana-verify` reproducible build passes against the deployed mainnet bytecode
- [ ] `docs/SECURITY.md` "Audit Scope" section updated with mainnet program ID

### 5.4 Operational

- [ ] On-call rotation defined for incident response
- [ ] Rollback procedure documented (Section 7)
- [ ] User-facing communication channel established (status page, Discord, etc.)

---

## 6. ALT Deployment (Existing Content)

> Address Lookup Table deployment for Sigil composed transactions. Required when the SDK transitions to ALT-compressed transactions.

### 6.1 Pre-Deployment Checklist

- [ ] All kit tests pass (`pnpm test`)
- [ ] Shield ALT resolution verified (V6, V6b, V10 tests)
- [ ] CU recompose preserves ALT compression (V3 test)
- [ ] Changeset committed for `@usesigil/kit`
- [ ] No open critical/high audit findings

### 6.2 Create the ALT

```bash
# Devnet
solana address-lookup-table create \
  --keypair <authority-keypair> \
  --url devnet \
  --output-format json

# Mainnet
solana address-lookup-table create \
  --keypair <authority-keypair> \
  --url mainnet-beta \
  --output-format json
```

Save the returned ALT address.

### 6.3 Extend with Sigil Shared Accounts

The Sigil ALT stores 7 non-program accounts shared across composed transactions:

| #   | Account             | Devnet                                         | Mainnet                                        |
| --- | ------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 0   | USDC Mint           | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| 1   | USDT Mint           | `EJwZgeZrdC8TXTQbQBoL6bfuAnFUQYtEnqbJgLeNP2io` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| 2   | Protocol Treasury   | `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT` | `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT` |
| 3   | Instructions Sysvar | `Sysvar1nstructions1111111111111111111111111`  | `Sysvar1nstructions1111111111111111111111111`  |
| 4   | Clock Sysvar        | `SysvarC1ock11111111111111111111111111111111`  | `SysvarC1ock11111111111111111111111111111111`  |
| 5   | Treasury USDC ATA   | `J2SCySRvXFFQc6DdbRqnnmEz7kmtEtpM2FP37fz9R4Vt` | _(pending mainnet deployment)_                 |
| 6   | Treasury USDT ATA   | `81RyRPBpxR5QK6ZBtjNDBSknid1qMHsrCcWF6w5NHKD6` | _(pending mainnet deployment)_                 |

Source of truth: `sdk/kit/src/alt-config.ts` — `EXPECTED_ALT_CONTENTS_DEVNET` / `EXPECTED_ALT_CONTENTS_MAINNET` arrays.

```bash
solana address-lookup-table extend <ALT_ADDRESS> \
  --keypair <authority-keypair> \
  --url <network> \
  --addresses \
    <USDC_MINT>,<USDT_MINT>,<TREASURY>,Sysvar1nstructions1111111111111111111111111,SysvarC1ock11111111111111111111111111111111,<TREASURY_USDC_ATA>,<TREASURY_USDT_ATA>
```

### 6.4 Verify Contents

```bash
solana address-lookup-table get <ALT_ADDRESS> --url <network> --output json
```

Confirm the output lists exactly 7 addresses in the order above.

### 6.5 Update SDK Config

Edit `sdk/kit/src/alt-config.ts`:

```typescript
export const SIGIL_ALT_DEVNET = "<new-devnet-alt-address>" as Address;
export const SIGIL_ALT_MAINNET = "<new-mainnet-alt-address>" as Address;
```

### 6.6 Make ALT Immutable (Production Only)

Transfer authority to the System Program after verifying ALT contents:

```bash
solana address-lookup-table set-authority <ALT_ADDRESS> \
  --keypair <authority-keypair> \
  --new-authority 11111111111111111111111111111111 \
  --url <network>
```

> **Warning:** This is irreversible. Only do this after verifying ALT contents are correct.

---

## 7. Rollback Procedures

### 7.1 SDK rollback

Snapshot releases (`@canary`) cannot be rolled back individually — `npm install @usesigil/kit@canary` always pulls the latest. To force consumers off a bad snapshot, immediately publish a new fixed snapshot.

Stable releases (`@latest`):

```bash
# Re-tag a previous good version as @latest:
npm dist-tag add @usesigil/kit@<good-version> latest
```

If the bad version was deprecated or unpublishable, also publish a patch fix.

### 7.2 Program rollback

**Pre-mainnet:** Deploy previous bytecode using the same `solana program deploy` flow against the current upgrade authority.

**Mainnet (post-Squads-migration):** File a Squads V4 multisig proposal to upgrade back to the previous bytecode. Subject to the same ≥24h timelock window as forward upgrades. There is no "fast rollback" path on mainnet by design — the timelock IS the safety mechanism.

### 7.3 ALT rollback

The SDK works without ALTs (S-4 graceful degradation). `AltCache.resolve()` returns empty on failure; the composer produces valid (larger) transactions without ALT compression.

To force fallback: set the ALT address back to system program placeholder (`11111111111111111111111111111111`) in `alt-config.ts` and release a patch.

If ALT authority is compromised but the ALT is already immutable (Section 6.6), no action needed. If not yet immutable, immediately transfer authority to System Program.

The key design principle: **ALTs are an optimization, not a requirement.** Every transaction path works without them.

---

## 8. Devnet Deployment Status (Today)

### 8.1 Production Program (today: devnet, future: mainnet)

Program deployed to devnet at `4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL`. Deployed manually via `workflow_dispatch` — never automatically by CI on push.

### 8.2 Staging Program (devnet only, ever)

Staging program ID: TBD (`STAGSigi…` placeholder until generated). Auto-deployed by `deploy-devnet.yml` on every `main` merge that touches `programs/sigil/src/**` or `Anchor.toml`. Wipe-and-redeploy is safe — no real funds depend on its state.

### 8.3 Devnet ALT

ALT deployed and populated with 7 shared accounts. Address stored in `sdk/kit/src/alt-config.ts` as `SIGIL_ALT_DEVNET`.

### 8.4 Treasury USDC ATA

Created at `ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT`. Hardcoded in `protocolTreasuryTokenAccount` references.

### 8.5 Turnkey Signing Policy

For production custody, configure Turnkey signing policies to:

1. Restrict signing to transactions containing `validate_and_authorize` as the first non-ComputeBudget instruction
2. Enforce allowlisted program IDs (Sigil program + configured DeFi protocols)
3. Set rate limits aligned with on-chain `PolicyConfig` caps

Example Turnkey policy JSON:

```json
{
  "policyName": "sigil-agent-signing-policy",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.id == '<AGENT_USER_ID>')",
  "condition": "solana.tx.instructions.any(ix, ix.program_id == '4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL')",
  "notes": "Allow signing only when the Sigil program is invoked. Max 100 TX/day, reject if total lamports exceed policy cap."
}
```

Key policy requirements:

- **Sigil program must be present**: Every agent TX must include `validate_and_authorize`
- **No raw token transfers**: Block standalone SPL Token transfer/approve instructions not wrapped by Sigil
- **Rate limiting**: Align Turnkey's per-wallet rate limit with the vault's `dailySpendingCapUsd`
- **Emergency**: Configure a separate "freeze" policy that the owner can invoke to block all signing immediately

See `sdk/custody/turnkey/` for the Turnkey adapter and `sdk/kit/src/tee/` for the TEE signing interface.
