# M1-01 — HIGH-1: Destination-Allowlist Swap Bypass

**Milestone:** M1 · **Depends on:** M1-00 · **Severity:** HIGH (agent-reachable) · **Status:** PLAN

## The finding (from this session's core+CPI audit, CONFIRMED)
`enforce_destination_allowlist` (`utils/destination_check.rs:143-151`) resolves each writable token-account meta of the DeFi instruction by looking it up in the **validate instruction's `remaining_accounts`**; if not found, it **`continue`s — skipping the allowlist check.** A compromised agent puts the attacker recipient in the DeFi ix (required for the transfer) but **omits it from validate's `remaining_accounts`** → check skipped → funds route to a non-allowlisted wallet. Finalize's TA-14 per-recipient logic (`finalize_session.rs:626-628, 657-662`) treats a non-allowlisted recipient as a NO-OP, not a rejection, so it doesn't re-close it. Bounded by caps (worst case ≈ daily cap/day), hence HIGH not CRITICAL. `agent_transfer` is NOT affected (named, deserialized destination).

> Product-intent note: severity is HIGH if destination-allowlisting on the swap path is an advertised V1 guarantee. Per the agnostic model (destination-assertion is a first-class closure for drain-then-refill), it IS load-bearing → treat as HIGH, fix now. Re-confirm file:line at build start.

## Goal
Make the destination allowlist unbypassable on the swap path: a writable token-account outflow to a non-allowlisted owner must REJECT, never silently skip.

## Approach (two candidate fixes — pick at design-review, default = B)
- **(A) Hard-reject unresolvable metas:** if a writable token-account meta of the DeFi ix cannot be resolved/validated, REJECT (mirror the existing `IxMetaCountExceeded` hard-reject philosophy at `destination_check.rs:126-129`). Closes the skip, but depends on resolution being complete.
- **(B, DEFAULT) Enforce destinations at finalize from realized state:** in `finalize_session`, identify actual outflow recipients from post-state and REJECT any outflow whose token-account owner is not allowlisted, instead of NO-OPing (`finalize_session.rs:657-662`). This is the agnostic, observe-the-outcome fix — aligns with the model's §6.1 "assert on the destination" closure and the production pattern (Kamino/Drift observe post-state). Preferred because it can't be evaded by remaining_accounts omission — it reads what actually happened.

Decision to lock at design-review: A, B, or A+B defense-in-depth. Recommendation: **B as primary + A as cheap defense-in-depth.**

## Files & changes (confidence: file:line re-verify at build start)
- `utils/destination_check.rs` — remove the silent `continue`; for the chosen approach, either hard-reject (A) or hand authoritative enforcement to finalize (B).
- `instructions/finalize_session.rs:~526-663` (TA-14 region) — convert non-allowlisted-recipient NO-OP into a rejection (B).
- `errors.rs` — reuse `DestinationNotAllowed` (6024) if present; no new code expected. Confirm at build.

## Tests (the gap the audit named: existing tests only cover the recipient-present path)
- NEW LiteSVM test: swap routing to a non-allowlisted recipient WITH the recipient omitted from validate `remaining_accounts` → MUST reject (this is the exploit path; currently passes).
- Regression: allowlisted recipient still succeeds.
- Regression: `agent_transfer` path unaffected.
- Multi-recipient + partial-allowlist edge.

## DoD
Exploit test reproduces the bypass on baseline, then fails-closed after the fix; full suite green; adversarial review confirms no residual skip path; mandatory pipeline complete.

## Risks
- Approach B requires reliably enumerating real outflow recipients from post-state — verify the finalize account set gives this. If not, fall back to A.
- Over-rejection breaking legitimate multi-hop swaps → cover with the multi-recipient test.

## Anti-criteria
- No instruction-data parsing introduced.
- `agent_transfer` behavior unchanged.
