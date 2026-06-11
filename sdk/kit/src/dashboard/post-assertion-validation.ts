/**
 * @usesigil/kit/dashboard — Client-side PostAssertionEntry validator.
 *
 * Mirrors the on-chain `PostExecutionAssertions::validate_entries()` check
 * in `programs/sigil/src/state/post_assertions.rs:118`. Fails fast in the
 * dashboard before the caller burns an RPC round-trip on an entry the
 * program will reject.
 *
 * Pure function: no RPC, no I/O, no side effects. Safe to call in a render
 * loop or form handler.
 *
 * Every rejection path carries a human-readable message that includes the
 * offending entry index so callers can pinpoint the bad entry in a multi-
 * entry batch (Phase 2 PRD ISC-19).
 *
 * ## DxError compatibility
 *
 * {@link PostAssertionValidationError} is structurally a `DxError` — it has
 * numeric `code`, string `message`, and `recovery: string[]`. This means
 * the mutation wrapper does NOT need to wrap it via `toDxError` before
 * re-throwing; FE always sees the typed fields (`validationCode`,
 * `entryIndex`) intact alongside the standard DxError surface.
 *
 * @see programs/sigil/src/state/post_assertions.rs — source of truth
 */
import type { PostAssertionEntry } from "../generated/types/postAssertionEntry.js";

// ─── Constants (pinned to Rust source) ────────────────────────────────────
// These MUST match the Rust constants. If they drift, the validator will
// pass inputs the program then rejects (or vice-versa), producing confusing
// round-trip failures. Keep in sync with `programs/sigil/src/state/*.rs`.

/**
 * `programs/sigil/src/state/post_assertions.rs:13` — Phase 6 (Maestro borrows
 * R-1/R-2/R-3/R-4) grew the per-vault assertion cap from 4 → 8 entries to make
 * room for the four new variants alongside the existing absolute/delta modes.
 */
const MAX_POST_ASSERTION_ENTRIES = 8;
/** `programs/sigil/src/state/constraints.rs:9` */
const MAX_CONSTRAINT_VALUE_LEN = 32;

/** Operator IDs (0..=6) — see `programs/sigil/src/state/constraints.rs ConstraintOperator`. */
const MAX_OPERATOR_VALUE = 6;
/**
 * `programs/sigil/src/state/post_assertions.rs:30-76` — AssertionMode IDs
 * (0..=7). Phase 6 added modes 4 (MintDeltaCap), 5 (AtaAuthorityPin),
 * 6 (OutputBalanceFloor), 7 (DeclarationConsistency).
 */
const MAX_ASSERTION_MODE_VALUE = 7;

/** Delta modes (MaxDecrease=1, MaxIncrease=2, NoChange=3) parse the snapshot as u64. */
const DELTA_MAX_VALUE_LEN = 8;

/**
 * Phase 6 R-4 DeclarationConsistency caps `aux_byte` (used as
 * `account_meta_index`) below 64 — Solana v0 transactions can address at
 * most ~64 instruction-account metas, so an index ≥ 64 is structurally
 * unreachable. Mirrors `state/post_assertions.rs:342-345`.
 */
const MAX_META_INDEX = 63;

/**
 * Phase 6 R-1 MintDeltaCap scope flag: 0 = vault-wide ATA enumeration,
 * 1 = single account in `target_account`. See `state/post_assertions.rs:261-265`.
 */
const MAX_MINTDELTACAP_SCOPE = 1;

/** Bytes 0..32 of `expected_value` carry a pubkey (mint OR declared mint) for modes 4/6/7. */
const PUBKEY_BYTES = 32;

/**
 * Default (zero) pubkey base58 string — rejected as `target_account` for
 * modes 5/6/7. The Solana System Program ID has the same encoding
 * (`11111111111111111111111111111111`) because both are 32 zero bytes; we
 * compare base58 strings here since the generated `PostAssertionEntry`
 * field type is `Address` (a branded base58 string).
 */
const ZERO_PUBKEY_BASE58 = "11111111111111111111111111111111";

function isZeroPubkeyAddress(addr: string | undefined | null): boolean {
  return addr === ZERO_PUBKEY_BASE58 || !addr;
}

/** Byte-slice zero check for `expected_value[0..32]` (declared mint). */
function isZeroPubkeyBytes(bytes: ArrayLike<number>): boolean {
  if (bytes.length < PUBKEY_BYTES) return true;
  for (let i = 0; i < PUBKEY_BYTES; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function isZeroAuxValue(aux: ArrayLike<number>): boolean {
  if (aux.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    if (aux[i] !== 0) return false;
  }
  return true;
}

function readAuxValueU64(aux: ArrayLike<number>): bigint {
  // Little-endian u64 read — mirrors Rust `u64::from_le_bytes(entry.aux_value)`.
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(aux[i] & 0xff);
  }
  return v;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Machine-readable validation failure codes.
 *
 * Callers can branch on these via `err.validationCode` to produce tier-
 * appropriate UI messaging without string-matching the human `message`
 * field. The enum ordering mirrors the on-chain check sequence so the
 * first failure a caller sees is also the first one `validate_entries`
 * would reject.
 */
export type PostAssertionValidationCode =
  | "entries_not_an_array"
  | "entries_contain_null"
  | "entry_count_out_of_range"
  | "value_len_out_of_range"
  | "expected_value_too_short"
  | "operator_out_of_range"
  | "assertion_mode_out_of_range"
  | "offset_out_of_range"
  | "cross_field_offset_b_out_of_range"
  | "cross_field_multiplier_bps_out_of_range"
  | "cross_field_flags_out_of_range"
  | "delta_mode_value_len_too_large"
  | "cross_field_value_len_too_large"
  | "cross_field_requires_absolute_mode"
  | "cross_field_multiplier_must_be_positive"
  | "cross_field_unknown_flags"
  | "cross_field_disabled_fields_must_be_zero"
  // Phase 6 mode-aware aux-field validation codes.
  | "legacy_mode_aux_value_must_be_zero"
  | "legacy_mode_aux_byte_must_be_zero"
  | "mintdeltacap_scope_out_of_range"
  | "mintdeltacap_zero_max_net_decrease"
  | "mintdeltacap_mint_too_short"
  | "ata_authority_pin_default_target"
  | "ata_authority_pin_aux_must_be_zero"
  | "output_balance_floor_default_target"
  | "output_balance_floor_mint_too_short"
  | "output_balance_floor_zero_min_increase"
  | "output_balance_floor_aux_byte_must_be_zero"
  | "declaration_default_recipient"
  | "declaration_mint_too_short"
  | "declaration_zero_mint"
  | "declaration_meta_index_too_large"
  | "declaration_aux_value_must_be_zero";

/**
 * Numeric `DxError.code` for every PostAssertion validation failure.
 *
 * All validation-class failures share this single numeric code — the more
 * specific `validationCode` string discriminates. 7008 is the existing SDK
 * "PRECHECK_FAILED" bucket (see `dashboard/errors.ts` SIGIL_ERROR_TO_NUMERIC),
 * which is semantically correct: the client-side validator IS a pre-check
 * for the on-chain validate_entries call.
 */
export const DX_CODE_POST_ASSERTION_VALIDATION = 7008 as const;

/**
 * Thrown by {@link validatePostAssertionEntries} when an entry fails any
 * check the on-chain program would enforce.
 *
 * Structurally compatible with `DxError` — exposes `code: number`,
 * `message: string`, and `recovery: string[]` so FE can render the error
 * without re-wrapping. Also carries the typed `validationCode` (the
 * specific failure reason) and `entryIndex` (the zero-based index of the
 * offending entry, or `null` for batch-level failures).
 *
 * Mutation wrappers re-throw this instance directly — they do NOT wrap
 * via `toDxError`. Wrapping would collapse the typed fields into
 * `DX_ERROR_CODE_UNMAPPED` (7999), breaking the file docblock's promise
 * that the FE can branch on `validationCode`.
 */
export class PostAssertionValidationError extends Error {
  public readonly code: number;
  public readonly validationCode: PostAssertionValidationCode;
  public readonly entryIndex: number | null;
  public readonly recovery: string[];
  /**
   * Always `false` — this error is thrown at CLIENT validation time,
   * BEFORE any RPC round-trip. Present to satisfy the DxError structural
   * contract (every DxError carries `onChainReverted`; see FE↔BE
   * contract v2.2 C2). Pre-existing callers need no migration.
   */
  public readonly onChainReverted: boolean = false;

  constructor(
    validationCode: PostAssertionValidationCode,
    entryIndex: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PostAssertionValidationError";
    this.code = DX_CODE_POST_ASSERTION_VALIDATION;
    this.validationCode = validationCode;
    this.entryIndex = entryIndex;
    this.recovery = [
      entryIndex !== null
        ? `Fix PostAssertion entry at index ${entryIndex} (${validationCode}) and retry.`
        : `Fix PostAssertion batch (${validationCode}) and retry.`,
    ];
    // Preserve prototype chain under ES5 target
    Object.setPrototypeOf(this, PostAssertionValidationError.prototype);
  }
}

/**
 * Validate a batch of PostAssertionEntry values against the exact rules
 * the on-chain program enforces.
 *
 * Throws on the FIRST failing check (same as the Rust `for entry in entries`
 * loop). Use a try/catch to recover; the error's `validationCode` +
 * `entryIndex` identify the offending entry.
 *
 * @param entries Batch to check. Must be 1..=4 entries.
 * @throws {PostAssertionValidationError} with the specific failure code.
 */
export function validatePostAssertionEntries(
  entries: readonly PostAssertionEntry[],
): void {
  // Input-shape guard: TS doesn't enforce runtime shape, so an `any` caller
  // can pass null/undefined/non-array without a compiler warning. Without
  // this, `entries.length` would throw a cryptic TypeError that `toDxError`
  // collapses to code 7999.
  if (!Array.isArray(entries)) {
    throw new PostAssertionValidationError(
      "entries_not_an_array",
      null,
      `PostAssertion entries must be an array, got ${entries === null ? "null" : typeof entries}`,
    );
  }

  // Batch-level: entry count must be 1..=MAX.
  if (entries.length === 0 || entries.length > MAX_POST_ASSERTION_ENTRIES) {
    throw new PostAssertionValidationError(
      "entry_count_out_of_range",
      null,
      `PostAssertion entry count must be 1..=${MAX_POST_ASSERTION_ENTRIES}, got ${entries.length}`,
    );
  }

  entries.forEach((entry, index) => {
    // Per-slot null guard — forEach skips truly empty slots but an array
    // literal `[null, validEntry]` yields `entry === null` at index 0.
    if (entry == null) {
      throw new PostAssertionValidationError(
        "entries_contain_null",
        index,
        `PostAssertion[${index}]: entry is ${entry === null ? "null" : "undefined"}`,
      );
    }
    validateSingleEntry(entry, index);
  });
}

// ─── Internal ─────────────────────────────────────────────────────────────

/**
 * Guard that rejects non-integer, out-of-range, non-finite, or negative
 * numeric field values at the validator layer — BEFORE Codama's u8/u16/u32
 * encoders would either silently truncate (`8.5` → `8`) or throw a
 * different error class (`-1` → SolanaError).
 *
 * Having a single typed rejection point means every invalid numeric input
 * surfaces as `PostAssertionValidationError` with the field's specific
 * `validationCode`, rather than a grab-bag of Codama runtime failures.
 */
function requireUintInRange(
  value: number,
  field: string,
  max: number,
  code: PostAssertionValidationCode,
  index: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new PostAssertionValidationError(
      code,
      index,
      `PostAssertion[${index}]: ${field} must be an integer 0..=${max}, got ${JSON.stringify(value)} (${typeof value})`,
    );
  }
}

function validateSingleEntry(entry: PostAssertionEntry, index: number): void {
  // Strict numeric shape checks — integer, non-negative, fits the on-chain
  // field width. Catch non-integer (e.g. 8.5) and negative (-1) inputs that
  // one-sided `> MAX` comparisons would miss.
  requireUintInRange(
    entry.offset,
    "offset",
    0xffff,
    "offset_out_of_range",
    index,
  );
  requireUintInRange(
    entry.operator,
    "operator",
    MAX_OPERATOR_VALUE,
    "operator_out_of_range",
    index,
  );
  requireUintInRange(
    entry.assertionMode,
    "assertion_mode",
    MAX_ASSERTION_MODE_VALUE,
    "assertion_mode_out_of_range",
    index,
  );

  // Phase 6 modes (4..7) ignore value_len/operator and use aux_value/aux_byte/
  // target_account/expected_value[0..32] instead. Dispatch on assertionMode
  // before applying the legacy (modes 0..3) value_len/expected_value checks.
  if (entry.assertionMode >= 4) {
    validatePhase6Entry(entry, index);
    return;
  }

  // ─── Legacy modes (0..3) ──────────────────────────────────────────────
  // value_len must be 1..=MAX (the shared range check allows 0; on-chain
  // requires > 0 because a zero-length value is a semantic no-op).
  requireUintInRange(
    entry.valueLen,
    "value_len",
    MAX_CONSTRAINT_VALUE_LEN,
    "value_len_out_of_range",
    index,
  );
  if (entry.valueLen === 0) {
    throw new PostAssertionValidationError(
      "value_len_out_of_range",
      index,
      `PostAssertion[${index}]: value_len must be 1..=${MAX_CONSTRAINT_VALUE_LEN}, got 0`,
    );
  }

  // expected_value must be at least `value_len` bytes. Callers that pass
  // a shorter buffer would have the on-chain program reject the entry —
  // catch here instead.
  if (entry.expectedValue.length < entry.valueLen) {
    throw new PostAssertionValidationError(
      "expected_value_too_short",
      index,
      `PostAssertion[${index}]: expected_value has ${entry.expectedValue.length} bytes but value_len=${entry.valueLen} (must be >= value_len)`,
    );
  }

  // Delta modes (1/2/3) compare the pre/post snapshot as u64 — so the
  // expected-value payload must fit in 8 bytes. The on-chain program
  // enforces this; we mirror the check here.
  if (entry.assertionMode >= 1 && entry.assertionMode <= 3) {
    if (entry.valueLen > DELTA_MAX_VALUE_LEN) {
      throw new PostAssertionValidationError(
        "delta_mode_value_len_too_large",
        index,
        `PostAssertion[${index}]: delta assertion_mode=${entry.assertionMode} requires value_len <= ${DELTA_MAX_VALUE_LEN}, got ${entry.valueLen}`,
      );
    }
  }

  // Modes 0..3 MUST NOT set aux fields — invariant for off-chain decoders
  // so a legacy mode-0 entry can never silently carry a Phase 6 payload.
  // Mirrors `state/post_assertions.rs:244-251`.
  if (!isZeroAuxValue(entry.auxValue)) {
    throw new PostAssertionValidationError(
      "legacy_mode_aux_value_must_be_zero",
      index,
      `PostAssertion[${index}]: legacy mode=${entry.assertionMode} requires aux_value=0, got non-zero bytes`,
    );
  }
  if (entry.auxByte !== 0) {
    throw new PostAssertionValidationError(
      "legacy_mode_aux_byte_must_be_zero",
      index,
      `PostAssertion[${index}]: legacy mode=${entry.assertionMode} requires aux_byte=0, got ${entry.auxByte}`,
    );
  }
}

/**
 * Per-mode validation for Phase 6 variants (modes 4..7). Mirrors the
 * `match mode { ... }` arm in `state/post_assertions.rs::validate_entries`
 * for modes 4-7.
 *
 * Phase 6 entries ignore the legacy `value_len`/`operator`/`offset` fields
 * and use:
 *   - mode 4 MintDeltaCap: expected_value[0..32]=mint, aux_value=max_net_decrease (u64 LE), aux_byte=scope (0|1)
 *   - mode 5 AtaAuthorityPin: target_account=ATA to pin, aux_value=0, aux_byte=0
 *   - mode 6 OutputBalanceFloor: target_account=token account, expected_value[0..32]=mint, aux_value=min_increase, aux_byte=0
 *   - mode 7 DeclarationConsistency: target_account=declared recipient, expected_value[0..32]=declared mint, aux_byte=account_meta_index (< 64), aux_value=0
 */
function validatePhase6Entry(entry: PostAssertionEntry, index: number): void {
  // aux_byte is structurally a u8 in the on-chain layout; mirror that here.
  requireUintInRange(
    entry.auxByte,
    "aux_byte",
    0xff,
    "assertion_mode_out_of_range",
    index,
  );

  switch (entry.assertionMode) {
    case 4: {
      // MintDeltaCap — expected_value[0..32] = mint (any value, including zero
      // pubkey, is allowed at the schema level; on-chain validate_entries
      // doesn't reject the zero mint here). aux_value > 0. aux_byte ∈ {0,1}.
      if (entry.expectedValue.length < PUBKEY_BYTES) {
        throw new PostAssertionValidationError(
          "mintdeltacap_mint_too_short",
          index,
          `PostAssertion[${index}]: MintDeltaCap requires expected_value >= ${PUBKEY_BYTES} bytes (mint), got ${entry.expectedValue.length}`,
        );
      }
      if (entry.auxByte > MAX_MINTDELTACAP_SCOPE) {
        throw new PostAssertionValidationError(
          "mintdeltacap_scope_out_of_range",
          index,
          `PostAssertion[${index}]: MintDeltaCap scope (aux_byte) must be 0 or 1, got ${entry.auxByte}`,
        );
      }
      if (readAuxValueU64(entry.auxValue) === 0n) {
        throw new PostAssertionValidationError(
          "mintdeltacap_zero_max_net_decrease",
          index,
          `PostAssertion[${index}]: MintDeltaCap max_net_decrease (aux_value u64 LE) must be > 0`,
        );
      }
      return;
    }
    case 5: {
      // AtaAuthorityPin — target_account != default. aux_value=0, aux_byte=0.
      if (isZeroPubkeyAddress(entry.targetAccount as unknown as string)) {
        throw new PostAssertionValidationError(
          "ata_authority_pin_default_target",
          index,
          `PostAssertion[${index}]: AtaAuthorityPin target_account must not be Pubkey::default()`,
        );
      }
      if (!isZeroAuxValue(entry.auxValue)) {
        throw new PostAssertionValidationError(
          "ata_authority_pin_aux_must_be_zero",
          index,
          `PostAssertion[${index}]: AtaAuthorityPin aux_value must be zero, got non-zero bytes`,
        );
      }
      if (entry.auxByte !== 0) {
        throw new PostAssertionValidationError(
          "ata_authority_pin_aux_must_be_zero",
          index,
          `PostAssertion[${index}]: AtaAuthorityPin aux_byte must be 0, got ${entry.auxByte}`,
        );
      }
      return;
    }
    case 6: {
      // OutputBalanceFloor — target_account != default, expected_value[0..32]
      // = mint (any non-checked value), aux_value > 0, aux_byte = 0.
      if (isZeroPubkeyAddress(entry.targetAccount as unknown as string)) {
        throw new PostAssertionValidationError(
          "output_balance_floor_default_target",
          index,
          `PostAssertion[${index}]: OutputBalanceFloor target_account must not be Pubkey::default()`,
        );
      }
      if (entry.expectedValue.length < PUBKEY_BYTES) {
        throw new PostAssertionValidationError(
          "output_balance_floor_mint_too_short",
          index,
          `PostAssertion[${index}]: OutputBalanceFloor requires expected_value >= ${PUBKEY_BYTES} bytes (mint), got ${entry.expectedValue.length}`,
        );
      }
      if (readAuxValueU64(entry.auxValue) === 0n) {
        throw new PostAssertionValidationError(
          "output_balance_floor_zero_min_increase",
          index,
          `PostAssertion[${index}]: OutputBalanceFloor min_increase (aux_value u64 LE) must be > 0`,
        );
      }
      if (entry.auxByte !== 0) {
        throw new PostAssertionValidationError(
          "output_balance_floor_aux_byte_must_be_zero",
          index,
          `PostAssertion[${index}]: OutputBalanceFloor aux_byte must be 0, got ${entry.auxByte}`,
        );
      }
      return;
    }
    case 7: {
      // DeclarationConsistency — target_account != default, declared mint
      // (expected_value[0..32]) != zero pubkey, aux_byte < 64, aux_value = 0.
      if (isZeroPubkeyAddress(entry.targetAccount as unknown as string)) {
        throw new PostAssertionValidationError(
          "declaration_default_recipient",
          index,
          `PostAssertion[${index}]: DeclarationConsistency target_account (declared recipient) must not be Pubkey::default()`,
        );
      }
      if (entry.expectedValue.length < PUBKEY_BYTES) {
        throw new PostAssertionValidationError(
          "declaration_mint_too_short",
          index,
          `PostAssertion[${index}]: DeclarationConsistency requires expected_value >= ${PUBKEY_BYTES} bytes (declared mint), got ${entry.expectedValue.length}`,
        );
      }
      if (isZeroPubkeyBytes(entry.expectedValue as ArrayLike<number>)) {
        throw new PostAssertionValidationError(
          "declaration_zero_mint",
          index,
          `PostAssertion[${index}]: DeclarationConsistency declared mint (expected_value[0..32]) must not be Pubkey::default()`,
        );
      }
      if (entry.auxByte > MAX_META_INDEX) {
        throw new PostAssertionValidationError(
          "declaration_meta_index_too_large",
          index,
          `PostAssertion[${index}]: DeclarationConsistency aux_byte (account_meta_index) must be < 64, got ${entry.auxByte}`,
        );
      }
      if (!isZeroAuxValue(entry.auxValue)) {
        throw new PostAssertionValidationError(
          "declaration_aux_value_must_be_zero",
          index,
          `PostAssertion[${index}]: DeclarationConsistency aux_value must be zero, got non-zero bytes`,
        );
      }
      return;
    }
    default:
      // Unreachable — caller's `requireUintInRange` above bounds assertionMode
      // to 0..=MAX_ASSERTION_MODE_VALUE (=7). A new mode 8+ would need a new
      // branch here; the on-chain validate_entries similarly rejects
      // unknown modes via `try_from(u8)`.
      throw new PostAssertionValidationError(
        "assertion_mode_out_of_range",
        index,
        `PostAssertion[${index}]: assertion_mode ${entry.assertionMode} has no validation branch`,
      );
  }
}
