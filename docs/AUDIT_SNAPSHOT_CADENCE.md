# Audit Snapshot Cadence — Failure-Mode Pattern

**Status:** Authoritative guidance for security-audit agents working on this codebase.

**Created:** 2026-05-21 after the Bucket-2 reaudit reported HARD NO-GO with 19 false-positive compile errors against a working tree that actually built green.

---

## TL;DR

When a security-audit agent reads files from the working tree mid-flight, it captures a **partial snapshot** of in-progress concurrent work. The snapshot regularly reports "broken" findings that are already fixed in committed state OR will be fixed by an unfinished parallel subagent within minutes.

**Rule:** Before reporting any CRITICAL finding, **rerun the gate command yourself against the live working tree** in a single dedicated tool call. Don't infer "broken" from grepping for symbols that may exist transiently.

---

## Concrete failure-mode signatures

### Signature 1 — "build is broken with N errors"

If you grep `programs/sigil/src/` mid-edit and see `cosign_session_pubkey` declared in `policy.rs` but missing from `set_observe_only.rs` initializer, you might conclude "16 missing-field errors blocking the build."

**Don't.** Run:
```bash
anchor build --no-idl 2>&1 | tail -5
```

If you see `Finished release profile`, the build is GREEN regardless of what your earlier grep saw. The parallel subagent that added the field probably also updated the call sites — your grep just caught it half done.

**Documented occurrence:** Bucket-2 reaudit 2026-05-21 reported "NC-1: 19 compilation errors" against a working tree that produced a clean .so in 0.41s when the audit author finally ran `anchor build`.

### Signature 2 — "dead-code declaration; function never invoked"

If you declare a new error variant in `errors.rs` (`ErrFoo`) and write a helper in `utils/foo.rs`, but the conversation says "Sub-A is wiring it now," a grep snapshot may show:
- ✅ `ErrFoo` in errors.rs
- ✅ `foo()` helper in utils/foo.rs
- ❌ Zero invocations under `instructions/`

Conclusion: "ErrFoo is dead code." But Sub-A's wiring lands 90 seconds after your grep.

**Don't.** Re-grep right before publishing the finding. If the wiring isn't there at publish time, that's a real finding — but check twice, 60 seconds apart, before calling it dead.

**Documented occurrence:** Bucket-2 reaudit "NC-2: D-1 verifier is DEAD CODE" — at publish time the verifier WAS wired at `validate_and_authorize.rs:183-189` per `grep ErrIntentDigestMismatch`. The audit snapshot caught the in-flight state.

### Signature 3 — "semantic flip on cosign gate"

A subagent applies a partial implementation of D-5 (cosign_session_pubkey opt-in) before the parent applies NH-1 (default-on safety). A snapshot between those two moments shows the opt-in shape and reads as "default-vault foot-gun."

**Don't.** Read the full code block including comments — a follow-up fix often has a marker comment (`// NH-1 close`) that explains the intentional design. If the comment names the audit finding by ID, the fix is already there.

**Documented occurrence:** Bucket-2 reaudit "NH-1: D-5 reactivate semantic wrong" — the file at audit time had a `NH-1 close (Bucket 2 re-audit 2026-05-21)` marker comment in `reactivate_vault.rs` that the audit didn't read past.

### Signature 4 — "TS error map drift"

The Rust `errors.rs` adds error codes 6111-6114. The TS `agent-errors.ts` ON_CHAIN_ERROR_MAP is missing entries for those codes. This one is REAL — `agent-errors.ts` is a manually-curated map, not auto-generated.

**Don't dismiss this one.** This is the canonical legitimate finding the audit will catch. Always check:
```bash
diff <(jq -r '.errors[].code' target/idl/sigil.json | sort -n) \
     <(grep -E "^  6[0-9]{3}:" sdk/kit/src/agent-errors.ts | awk -F: '{print $1}' | tr -d ' ' | sort -n)
```

Any line in the IDL output not in the SDK map IS a real gap.

**Documented occurrence:** Bucket-2 reaudit "NH-2: TS map missing 6111-6114" — confirmed real; my earlier edits to add these entries got lost (likely during a parallel subagent's pretest run that regenerated `errors/agent-errors.generated.ts` and overwrote the manual map). Re-added at the post-reaudit cleanup pass.

---

## Why audit agents keep finding "new" things

Three independent reasons stack up:

1. **Working-tree drift.** Each audit reads the WT state at its own moment. If concurrent work is in flight, the snapshots disagree.

2. **Auto-regen overwrites manual edits.** Several pretest hooks (`pnpm codegen:errors`, `pnpm codama`, `anchor idl build`) regenerate files. If a manual edit to a regenerated-adjacent file (e.g. the manual `agent-errors.ts` MAP next to the auto-gen `agent-errors.generated.ts`) happens RIGHT before a regen, the regen may stomp the edit. This isn't theoretical — it bit the Bucket-2 6111-6114 entries.

3. **Audit doesn't read marker comments.** The comment `// NH-1 close (Bucket 2 re-audit 2026-05-21): ...` IS the documentation that the audit's finding has already been addressed. An audit that greps for `if policy.cosign_required` and reports "gate only fires when cosign_required" is missing the marker context immediately above.

---

## Required audit protocol

For any audit agent doing a Phase reaudit or pre-redeploy verification:

1. **Step 1 — Snapshot the commit.** `git rev-parse HEAD` and pin every claim to that SHA. Don't audit working-tree files (`programs/sigil/src/...`); audit `git show HEAD:programs/sigil/src/...` content. This makes the audit reproducible.

2. **Step 2 — Run the gate commands once, capture output, cite it.** Run, in order:
   ```
   anchor build --no-idl
   cargo clippy -p sigil
   pnpm -C sdk/kit run pretest
   pnpm -C sdk/kit test
   npx ts-mocha tests/sigil.ts tests/security-exploits.ts tests/sandwich-integration.ts ...
   ```
   Cite the exact `Finished` / `passing` / `failing` lines. NO INFERENCE from grep.

3. **Step 3 — For any "broken" claim, run the inverse command.** If you claim "X is dead code," grep for X across `instructions/`. If you claim "compile error," run `anchor build`. The audit's own output is the authority.

4. **Step 4 — Read marker comments.** Before reporting `<seed> AUDIT-ID close` or `<seed> NH-<n> close` or `<seed> close (Bucket N)` mean the fix is already in. Read the next 30 lines of comment context before publishing the finding.

5. **Step 5 — Confidence labels.** Use CONFIRMED (gate command output cited) / LIKELY (code-read evidence) / UNCERTAIN (snapshot suspicion). The Bucket-2 reaudit's CONFIRMED on NC-1/NC-2/NH-1 was wrong because the audit didn't run gates; it inferred from greps.

---

## Living examples — known false positives by audit pass

| Audit ID | Date | Reality | Why audit saw it as broken |
|---|---|---|---|
| NC-1 (19 compile errors) | 2026-05-21 reaudit | `anchor build --no-idl` finished green at HEAD 41b4350a | Snapshot was mid-Sub-2 flight before all 16 PolicyPreviewFields call sites were updated |
| NC-2 (D-1 dead code) | 2026-05-21 reaudit | Verifier wired at validate_and_authorize.rs:183-189 + raises 6111 | Snapshot caught a 90-second window between intent_digest.rs landing and validate_and_authorize.rs wiring being applied |
| NH-1 (D-5 wrong semantic) | 2026-05-21 reaudit | Fix landed with `// NH-1 close (Bucket 2 re-audit 2026-05-21):` marker | Audit didn't read past the `if capability == FULL_CAPABILITY {` line into the comment matrix below |

| Audit ID | Date | Reality | Why this WAS legitimate |
|---|---|---|---|
| NH-2 (TS map missing 6111-6114) | 2026-05-21 reaudit | LEGITIMATE — entries lost via codegen race, re-added in cleanup pass | Manual edits to agent-errors.ts ON_CHAIN_ERROR_MAP got stomped by a parallel `pnpm codegen:errors` invocation |
| NH-4 (silent breaking change) | 2026-05-21 reaudit | LEGITIMATE — `getVaultPDA` param renamed without `@deprecated` | Now closed with @deprecated marker pointing at `getVaultPdaFromState` |

---

## What committers should do

Two practices that compress the audit-flake surface to near zero:

1. **Run the gate before publishing a finding.** Always.
2. **Commit incrementally — even if "WIP".** Audits against the working tree see whatever's there. Audits against `git show <SHA>` see exactly what was committed. The latter is reproducible; the former is a coin flip during heavy concurrent work.

For long-running parallel-agent sessions: stop and `git commit -m "[WIP step N/M] ..."` every time you reach a green gate state. The committed sequence becomes the audit timeline.
