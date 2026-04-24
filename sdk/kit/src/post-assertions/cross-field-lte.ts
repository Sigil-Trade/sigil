/**
 * @usesigil/kit/post-assertions — CrossFieldLte builder.
 *
 * Constructs a PostAssertionEntry that performs a ratio check on two byte
 * offsets inside the same target account AFTER the DeFi call completes.
 *
 * The on-chain check: `field_A × 10000 ≤ multiplier_bps × field_B`
 * (u128 safe math, cross-multiplication to avoid division).
 *
 * Typical use: leverage caps. field_A = sizeUsd, field_B = collateralUsd,
 * multiplier_bps = maxLeverage × 10000. If the cap is violated, the program
 * raises `PostAssertionFailed` (6068) and the entire transaction reverts.
 *
 * ## Jupiter Perpetuals UX rail — NOT a security boundary
 *
 * `leverageCapLteBps()` throws `JupiterPerpsPostAssertionUnsupportedError`
 * when the caller supplies a target account owned by the Jupiter Perpetuals
 * program. This is a **UX-level misuse-prevention guardrail**, NOT a
 * security guarantee — the on-chain program does **not** reject Jupiter
 * Perps target accounts. A caller who constructs a plain `PostAssertionEntry`
 * object literal (skipping this builder) and passes it to
 * `createPostAssertions(...)` WILL land an entry that targets a Jupiter
 * Perps Position account. That entry will always pass trivially, because:
 *
 * Jupiter Perps uses a 2-transaction keeper-fulfillment model — the user's
 * tx writes a PositionRequest, and a Jupiter-hosted keeper executes the
 * actual position change up to 45 seconds later. Sigil's
 * `finalize_session` reads account state in the USER's tx, not the keeper's,
 * so the Jupiter Position account still reflects pre-trade state at check
 * time. CrossFieldLte post-execution over that account therefore is a
 * **silent constraint bypass** — the user thinks their leverage cap is
 * active when it isn't.
 *
 * For REAL security on Jupiter Perps, combine with pre-execution
 * `InstructionConstraints` (the `@sigil-trade/constraints` package compiles
 * byte-level checks on Jupiter instruction args that the on-chain program
 * enforces BEFORE the request hits the keeper — covers the same attack
 * surface from the opposite direction).
 *
 * Follow-up work (tracked in the Phase 2 PRD as deferred): add an on-chain
 * `target_account.owner` deny-list check in `finalize_session.rs` that
 * rejects CrossFieldLte entries whose target account is owned by Jupiter
 * Perpetuals. Until that lands, this builder's rail is defense-against-
 * typos, nothing more.
 *
 * @see programs/sigil/src/state/post_assertions.rs — on-chain source of truth
 * @see docs/LEVERAGE-ENFORCEMENT.md — full Jupiter Perps gap writeup
 */
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import type { PostAssertionEntry } from "../generated/types/postAssertionEntry.js";

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Jupiter Perpetuals program. Owner of Position + PositionRequest accounts.
 *
 * This is the ONLY Jupiter program the `leverageCapLteBps` builder refuses
 * at authoring time (see the docblock above for why — UX rail, not on-chain
 * security). Other Jupiter programs (V6 Aggregator, Lend, Earn, Borrow)
 * execute synchronously in the user's transaction and work fine with
 * post-execution assertions.
 */
export const JUPITER_PERPS_PROGRAM_ADDRESS =
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu" as Address;

/**
 * CrossFieldLte enable bit — bit 0 of `cross_field_flags`.
 * Every other bit is reserved; the on-chain validator rejects unknown flags.
 */
const CROSS_FIELD_LTE_FLAG = 0x01;

/**
 * Both field_A and field_B are parsed as `u64::from_le_bytes(bytes[0..8])`
 * on-chain when CrossFieldLte is enabled. Entry's `value_len` MUST be 8.
 */
const CROSS_FIELD_VALUE_LEN = 8;

/**
 * CrossFieldLte only composes with Absolute assertion_mode. Delta modes
 * (1/2/3) would re-interpret the snapshot bytes as field_A, which is
 * semantically nonsensical — on-chain hard-rejects.
 */
const ABSOLUTE_ASSERTION_MODE = 0;

/**
 * Lte operator (3). Not actually consulted at runtime when the CrossField
 * flag is set — the on-chain code branches to the ratio check and ignores
 * operator/expected_value. Set to 3 here as a semantic hint for anyone
 * inspecting the raw entry: "this is a less-than-or-equal check."
 */
const LTE_OPERATOR = 3;

/**
 * u16 range guard for byte offsets. Account data is at most ~10MB but
 * PostAssertionEntry.offset is a u16 on-chain, capping at 65535.
 */
const MAX_U16 = 0xffff;

/**
 * u32 range guard for `cross_field_multiplier_bps`. The on-chain type is
 * u32. Values above this would overflow deserialization.
 */
const MAX_U32 = 0xffffffff;

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown by {@link leverageCapLteBps} when the target account is owned by
 * the Jupiter Perpetuals program. Carries a long, copy-paste-friendly
 * explanation so the error bubbling to the dashboard is actionable.
 */
export class JupiterPerpsPostAssertionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterPerpsPostAssertionUnsupportedError";
    Object.setPrototypeOf(
      this,
      JupiterPerpsPostAssertionUnsupportedError.prototype,
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Options for `leverageCapLteBps`.
 *
 * `targetAccountOwnerProgram` is REQUIRED (not optional) so that callers
 * cannot accidentally bypass the Jupiter Perpetuals safety check by
 * omitting the ownership hint. If the caller doesn't know the owner
 * program, they shouldn't be building a post-execution leverage cap.
 */
export interface LeverageCapLteOpts {
  /**
   * Address of the account whose bytes will be inspected post-execution.
   * Typically the Position PDA for the protocol being constrained
   * (e.g. Flash Trade Position account).
   */
  targetAccount: Address;
  /**
   * Address of the program that OWNS `targetAccount`. Required for the
   * Jupiter Perpetuals safety rail. When this matches
   * {@link JUPITER_PERPS_PROGRAM_ADDRESS}, the helper throws
   * {@link JupiterPerpsPostAssertionUnsupportedError} — see file header.
   */
  targetAccountOwnerProgram: Address;
  /**
   * Byte offset of field_A (the "numerator" field) inside `targetAccount`.
   * Read as `u64` LE (8 bytes from this offset). Must be in `0..=65535`.
   * Typical: `sizeUsd` offset = 140 on Flash Trade Position.
   */
  fieldAOffset: number;
  /**
   * Byte offset of field_B (the "denominator" field). Read as `u64` LE.
   * Must be in `0..=65535` and MUST differ from `fieldAOffset` — comparing
   * a field against itself is either a no-op or a trap.
   * Typical: `collateralUsd` offset = 172 on Flash Trade Position.
   */
  fieldBOffset: number;
  /**
   * Leverage cap expressed in basis points: `maxBps = leverage × 10_000`.
   *
   * The on-chain check is `field_A × 10_000 ≤ maxBps × field_B`.
   * Examples:
   *   - 10×     → `maxBps = 100_000`
   *   - 50×     → `maxBps = 500_000`
   *   - 100×    → `maxBps = 1_000_000`
   *
   * Must be a positive integer in `1..=u32::MAX`. Prefer conservative caps;
   * never set to the protocol's maximum.
   */
  maxBps: number;
}

/**
 * Build a PostAssertionEntry that enforces a leverage cap via the
 * CrossFieldLte ratio check.
 *
 * Validates inputs, rejects Jupiter Perpetuals Position accounts at the
 * call site, and returns an entry ready to pass to
 * `createPostAssertions(rpc, vault, owner, network, [entry])`.
 *
 * @throws {JupiterPerpsPostAssertionUnsupportedError}
 *   When `targetAccountOwnerProgram` matches
 *   {@link JUPITER_PERPS_PROGRAM_ADDRESS}. See file header for why.
 * @throws {RangeError}
 *   When offsets are not integers in `0..=65535`, are equal to each other,
 *   or when `maxBps` is not a positive integer in `1..=u32::MAX`.
 */
export function leverageCapLteBps(
  opts: LeverageCapLteOpts,
): PostAssertionEntry {
  // Runtime Jupiter Perps reject (Phase 2 ISC-37, anti-criterion ISC-A1).
  // Fails before any further validation so the error surface points at
  // the real problem rather than incidental validation failures.
  if (opts.targetAccountOwnerProgram === JUPITER_PERPS_PROGRAM_ADDRESS) {
    throw new JupiterPerpsPostAssertionUnsupportedError(
      `Post-execution CrossFieldLte is NOT viable on Jupiter Perpetuals Position accounts.\n\n` +
        `Reason: Jupiter Perps uses a 2-transaction keeper-fulfillment model. The user's tx writes ` +
        `to a PositionRequest account; a Jupiter-hosted keeper executes the actual position change ` +
        `up to 45 seconds later in a separate tx. Sigil's finalize_session reads account state in ` +
        `the user's tx — at that point the Jupiter Position account still reflects pre-trade state. ` +
        `The leverage check would always pass trivially, creating a silent constraint bypass.\n\n` +
        `Jupiter Perps remains a fully supported protocol for agent use. Configure constraints ` +
        `via pre-execution InstructionConstraints instead — @sigil-trade/constraints compiles ` +
        `byte-level checks on Jupiter instruction args (sizeUsd, collateralUsd in the request) ` +
        `that are enforced BEFORE the request hits the keeper.\n\n` +
        `See docs/LEVERAGE-ENFORCEMENT.md — "Jupiter Perps — use pre-execution constraints".`,
    );
  }

  // Offset range / integrality checks (u16 on-chain).
  requireIntegerInRange(opts.fieldAOffset, "fieldAOffset", 0, MAX_U16);
  requireIntegerInRange(opts.fieldBOffset, "fieldBOffset", 0, MAX_U16);
  if (opts.fieldAOffset === opts.fieldBOffset) {
    throw new RangeError(
      `leverageCapLteBps: fieldAOffset and fieldBOffset must differ — ratio of a field against itself is nonsensical (got ${opts.fieldAOffset})`,
    );
  }

  // Multiplier range / integrality check (u32 on-chain, must be > 0).
  requireIntegerInRange(opts.maxBps, "maxBps", 1, MAX_U32);

  // All-zero expected_value — the on-chain CrossField path ignores this
  // field, but validate_entries still requires `expected_value.len() >=
  // value_len`. We ship exactly `CROSS_FIELD_VALUE_LEN` (8) bytes to
  // satisfy the size invariant without wasting space.
  const expectedValue = new Uint8Array(
    CROSS_FIELD_VALUE_LEN,
  ) as unknown as ReadonlyUint8Array;

  return {
    targetAccount: opts.targetAccount,
    offset: opts.fieldAOffset,
    valueLen: CROSS_FIELD_VALUE_LEN,
    operator: LTE_OPERATOR,
    expectedValue,
    assertionMode: ABSOLUTE_ASSERTION_MODE,
    crossFieldOffsetB: opts.fieldBOffset,
    crossFieldMultiplierBps: opts.maxBps,
    crossFieldFlags: CROSS_FIELD_LTE_FLAG,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

/**
 * Guard that rejects non-integer, out-of-range, or non-finite values.
 * Matches JS's pre-coercion discipline: a string `"8"` should NOT silently
 * pass an integer check, and `NaN` / `Infinity` must not sneak through.
 */
function requireIntegerInRange(
  value: number,
  field: string,
  min: number,
  max: number,
): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError(
      `leverageCapLteBps: ${field} must be an integer, got ${JSON.stringify(value)} (${typeof value})`,
    );
  }
  if (value < min || value > max) {
    throw new RangeError(
      `leverageCapLteBps: ${field} must be in ${min}..=${max}, got ${value}`,
    );
  }
}
