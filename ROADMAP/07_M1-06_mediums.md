# M1-06 — MEDIUM Fixes

**Milestone:** M1 · **Depends on:** M1-01 · **Status:** PLAN

Two MEDIUMs from this session's core+CPI audit. Both bounded today by the global cap; fixing closes the residual.

## MED-1 — Non-stablecoin INPUT drain not magnitude-bounded
**Finding** (`validate_and_authorize.rs:386-411` + `finalize_session.rs:408-413`): for a non-stablecoin input, validate approves a delegation of the full `amount` over the input (e.g. SOL) ATA and never cap-checks it; finalize's non-stablecoin branch only asserts the OUTPUT stablecoin balance increased (delta ≥ 1), never re-reads the input ATA or bounds how much was drained. The stable-balance floor (TA-12) sums only USDC/USDT, blind to a SOL drain. Bounded because acquiring the non-stablecoin was itself a capped stablecoin spend, so it's MEDIUM.

**Fix:** in finalize's non-stablecoin branch, re-read the input ATA and assert `input_decrease <= authorized_amount` (symmetric with the stablecoin-input check at `:304-310`). This is the observe-the-delta pattern applied to the input leg.

**Tests:** NEW — non-stablecoin input swap that drains more input than authorized → reject; happy-path non-stablecoin swap still succeeds.

## MED-2 — Per-protocol cap resets at the 24h boundary (not rolling)
**Finding** (`state/tracker.rs:308-391`): `get_protocol_spend`/`record_protocol_spend` use a single `window_start` that snaps the accumulator to 0 at the 24h boundary (self-documented "KNOWN LIMITATION"), unlike the global cap's true 144-bucket rolling window with proportional boundary scaling. Allows up to ~2× protocol_cap across the reset instant. Bounded by the global rolling cap (always enforced alongside), so MEDIUM.

**Fix options (design-review):** (A) switch `ProtocolSpendCounter` to the same 144-bucket boundary-corrected scheme the global tracker uses; (B) document as accepted (global cap is the backstop). Recommendation: **A** — consistency + closes the 2× burst; reuse the existing rolling-window code from the global tracker, so low-novelty.

**Tests:** NEW — straddle the per-protocol window boundary attempting >cap across the reset → reject (after fix A); rolling behavior matches global tracker.

## DoD
Both MEDs fixed (or MED-2 explicitly accepted with rationale if B chosen); new tests prove the bounds; full suite green; adversarial review; pipeline complete.

## Risks
- MED-2 fix A touches the spend tracker (zero-copy, size-pinned) → re-derive SIZE if layout changes; verify `const_assert!`.

## Anti-criteria
- No oracle introduced (input bound is a raw token delta, agnostic).
- No new SIZE drift left unverified.
