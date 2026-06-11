# Phase 0.6 §RP — silent-failure-hunter transcript

**Date:** 2026-05-17
**Phase:** 0.6 — CI + skill lock hardening
**Dispatched from:** main orchestrator thread
**Tool:** `pr-review-toolkit:silent-failure-hunter`
**Phase commits at time of review:** `c2995f2` + `35f30cd` + `0929967` + `945de98` + `5a015fd`
**Verdict:** FIX-AND-RETEST → 2 HIGH + 1 MEDIUM, all fixed in `76b6424` + `244f465`

---

## Scope sent to the agent

10 attack vectors covering CI supply chain + skill lock + dependency audit hardening:

1. Mutable refs surviving the pin sweep
2. CI lint job covering all yml files + actually failing on mutable refs
3. Surfpool boot fix actually failing loudly
4. Certora not invoked anywhere (L-2 compliance)
5. `continue-on-error: true` documented per job
6. skills-lock.json hashes match disk
7. .gitignore side effects
8. Engineer's deviation soundness (cargo-audit `^0.22` vs spec `0.21.x`)
9. Real CVEs from cargo audit in Sigil critical path
10. YAML validity

---

## Findings

### HIGH-1 — CI lint regex is broken; rejects nothing

**File:** `.github/workflows/revamp-ci.yml:40`

**Defect:** `grep -HnE 'uses: [^@]+@[^0-9a-f]{40}'` required **40 consecutive non-hex characters** after `@`. Empirically tested: `echo 'uses: actions/checkout@v4' | grep -E '...'` returns ZERO matches. The regex was decorative — it would never catch `@v4`, `@master`, `@main`, `@v6.0.6`, or any real mutable ref.

**Impact:** A future PR adding `actions/checkout@v4` would slip past the lint and through the supply-chain gate.

**Disposition:** RESOLVED in commit `76b6424`. Replaced with PCRE negative-lookahead:
```bash
grep -HnP 'uses:\s+\S+@(?![0-9a-f]{40}\b)\S+'
```

Empirically verified after fix:
- `echo 'uses: actions/checkout@v4' | grep -P '...'` → match (caught)
- `echo 'uses: actions/checkout@<40-char-sha>' | grep -P '...'` → no match (pinned passes)

---

### HIGH-2 — skills-lock.json hash valid for only ONE marketplace

**File:** `skills-lock.json:18` (code-reviewer entry)

**Defect:** `code-reviewer.md` content differs across the two installed pr-review-toolkit marketplaces:
- `claude-code-plugins/` → SHA-256 `533b9967...` (matches lockfile)
- `claude-plugins-official/` → SHA-256 `019395c3...` (does NOT match)

`silent-failure-hunter.md` happens to be byte-identical between both, so it matches either. But the lockfile didn't record `marketplace` source, only the `agentFile` path, so the dispatcher couldn't disambiguate.

**Impact:** A future dispatcher comparing runtime hash to lockfile would get inconsistent results depending on installation order or marketplace precedence. Breaks the cross-environment reproducibility intent.

**Disposition:** RESOLVED in commit `244f465`. Added `marketplaceCommitSha: 8bdbb7296d3fa2217283d3ef94452dd64097393b` to both pr-review-toolkit entries, pinning the marketplace git revision so resolution is deterministic.

---

### MEDIUM-1 — Surfpool readiness timeout is silent

**File:** `.github/workflows/revamp-ci.yml:341-355`

**Defect:** The for-loop polled `/health` 30 times. On exhaustion (surfpool alive but `/health` never responds), the loop fell through to `kill -0 $SURFPOOL_PID` which passed (process IS alive) and proceeded to run tests against an unready RPC. Users would see "Method not found" or RPC timeouts masking the actual readiness failure.

**Disposition:** RESOLVED in commit `76b6424`. Added explicit `READY=0/1` tracking:
```bash
READY=0
for i in {1..30}; do
  if curl -sf http://127.0.0.1:8899/health > /dev/null 2>&1; then
    echo "surfpool ready after ${i}s"; READY=1; break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "::error::surfpool /health did not respond within 30s"
  exit 1
fi
```

Makes the readiness failure distinguishable from "surfpool died" (the existing `kill -0` branch).

---

## Attack vector scorecard

| # | Vector | Verdict |
|---|---|---|
| 1 | Mutable refs in revamp-ci.yml or other workflows | PASS — all 7 workflow files clean |
| 2 | CI lint job rejects mutable refs | **FAIL** (HIGH-1) → RESOLVED |
| 3 | Surfpool boot loud-failure | PARTIAL → RESOLVED (MEDIUM-1) |
| 4 | Certora not invoked in revamp work | PASS — only comments referencing `security:verify` |
| 5 | `continue-on-error: true` documented per-job | PASS — both jobs + summary job have explicit Phase-10 wiring comments |
| 6 | skills-lock.json hashes match disk | **FAIL** (HIGH-2) → RESOLVED |
| 7 | .gitignore diff scope | PASS — exactly one line removed (`-skills-lock.json`) |
| 8 | cargo-audit `^0.22` deviation soundness | PASS — Cargo semver `^0.22` resolves to `>=0.22.0,<0.23.0`; cannot include 0.23 |
| 9 | Unsound/unmaintained crates in Sigil critical path | PASS — `cargo tree` confirms all transitive via Solana SDK; zero direct uses |
| 10 | YAML validity | PASS — parses with `yaml.safe_load` |

---

## Verdict: FIX-AND-RETEST → RESOLVED

All findings closed by commits `76b6424` + `244f465`. Re-verify confirmed:
- New PCRE regex correctly catches mutable refs and passes pinned SHAs ✓
- marketplaceCommitSha pins to deterministic marketplace revision ✓
- Surfpool readiness failure now exits loudly with explicit `::error::` message ✓

**Cleared for Phase 1 dispatch.**

---

**END OF Phase 0.6 silent-failure-hunter transcript**
