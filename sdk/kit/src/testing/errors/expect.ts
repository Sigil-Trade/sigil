/**
 * Strict error-assertion helpers for Sigil tests.
 *
 * Replaces the legacy `expectError(err, ...keywords)` and variadic
 * `expectSigilError(errString, ...names)` helpers.
 *
 * Council decision: 7-0 STRICT (2026-04-20). See:
 *   MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md
 *
 * Design tenets:
 *   1. Coupled {name, code} pairs via IDL-generated types.
 *      A typo on the name fails tsc.
 *   2. No substring matching on error names. Match against structured
 *      Anchor error log formats.
 *   3. CPI-origin guard (MIKE G-1): assertions never pass for Anchor errors
 *      thrown by CPI callees (e.g., Jupiter) that happen to share a code
 *      number with a Sigil error. Extract origin from the Solana runtime's
 *      `Program <id> invoke|failed` log lines (NOT the Anchor error line —
 *      those do not carry program id per anchor-lang-0.32.1/src/error.rs).
 *   4. @solana/kit log-fetch awareness (MIKE G-2): SendTransactionError
 *      from kit simulation has `logs === undefined` until `.getLogs()` is
 *      awaited. Diagnostic output calls this out explicitly.
 *   5. Diagnostic failure messages. When an assertion fails, the message
 *      says exactly what was expected, what was received, and where to
 *      look for the logs.
 */

import {
  ANCHOR_FRAMEWORK_ERRORS,
  SIGIL_ERRORS,
  type AnchorFrameworkCodeFor,
  type AnchorFrameworkName,
  type SigilErrorCodeFor,
  type SigilErrorName,
} from "./names.generated.js";

// ────────────────────────────────────────────────────────────────
// Sigil program ID — canonical mainnet/devnet/localnet address.
// Used for CPI-origin guard (G-1).
// ────────────────────────────────────────────────────────────────

export const SIGIL_PROGRAM_ID_BASE58 =
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";

// ────────────────────────────────────────────────────────────────
// ParsedAnchorError — structured extraction from raw error / logs.
// ────────────────────────────────────────────────────────────────

interface ParsedAnchorError {
  /** Numeric error code (6000+ for Sigil, 2000-5999 for Anchor framework). */
  code: number;
  /** Error name as declared in Rust `#[error_code]` or Anchor framework. */
  name: string;
  /**
   * Base58 program ID that emitted the error, extracted from the
   * Solana runtime's `Program <id> failed` log line (NOT the Anchor
   * error log, which does not carry program id per Anchor 0.32.1).
   * `undefined` means we could not resolve the origin — treat as
   * unverified.
   */
  originProgramId?: string;
  /** Raw log lines (best-effort; may be empty). */
  logs: string[];
}

/**
 * Real Anchor 0.32.1 emits EXACTLY three log shapes for an AnchorError.
 * Source: https://github.com/coral-xyz/anchor/blob/v0.32.1/lang/src/error.rs#L499-L541
 *
 *   1. ErrorOrigin::None        → "AnchorError occurred. Error Code: X. Error Number: N. Error Message: Y."
 *   2. ErrorOrigin::Source      → "AnchorError thrown in <file>:<line>. Error Code: X. Error Number: N. Error Message: Y."
 *   3. ErrorOrigin::AccountName → "AnchorError caused by account: <name>. Error Code: X. Error Number: N. Error Message: Y."
 *
 * The Solana runtime wraps the error in `Program <base58> failed: ...`
 * so we extract origin from those lines separately.
 */
// ReDoS-hardened patterns. Every unbounded repetition is constrained to
// either (a) a character class that excludes whitespace (so no backtracking
// over log-line boundaries) OR (b) a {min,max} length bound (so worst-case
// is linear). The filename portion of format #2 is bounded at 256 chars —
// longer than any realistic Rust source path — to kill polynomial
// backtracking on adversarial `err.logs` input (CodeQL js/polynomial-redos).
const ANCHOR_ERROR_RES: Array<RegExp> = [
  // Source variant — produced by `error!()` / `require!()` (most common).
  // `[^:\s]{1,256}` = non-whitespace, non-colon filename, max 256 chars.
  /AnchorError thrown in [^:\s]{1,256}:\d{1,10}\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
  // AccountName variant — produced by `#[account(..., constraint = ... @ E)]`.
  /AnchorError caused by account:\s{0,8}\w{1,64}\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
  // None variant.
  /AnchorError occurred\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
];

/** `Program <base58> invoke [<depth>]` — Solana runtime CPI log. */
const PROGRAM_INVOKE_RE =
  /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]/;

/**
 * `Program <base58> failed: ...` — Solana runtime failure log. The LAST
 * occurrence before the Anchor error identifies the program that
 * actually emitted the error.
 */
const PROGRAM_FAILED_RE = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed:/;

/** Raw hex custom program error (fallback when logs are missing). */
const CUSTOM_PROGRAM_ERROR_RE = /custom program error:\s*0x([0-9a-f]+)/i;

/**
 * Extract structured {code, name, originProgramId} from a thrown error
 * or error-string. Returns null if the error is not parseable as an
 * Anchor/Sigil error.
 *
 * Safe to call with any thrown value — string, Error, SendTransactionError,
 * AnchorError, unknown. Never throws.
 */
export function parseAnchorError(err: unknown): ParsedAnchorError | null {
  if (err === null || err === undefined) return null;

  // Stage 1: collect all strings we can probe.
  const logs: string[] = [];
  const textSources: string[] = [];

  const anyErr = err as {
    logs?: unknown;
    message?: unknown;
    toString?: () => string;
  };

  if (Array.isArray(anyErr.logs)) {
    for (const l of anyErr.logs) {
      if (typeof l === "string") logs.push(l);
    }
  }

  if (typeof anyErr.message === "string") textSources.push(anyErr.message);
  if (typeof anyErr.toString === "function") {
    try {
      const s = anyErr.toString();
      if (typeof s === "string" && s.length > 0) textSources.push(s);
    } catch {
      // Exotic objects can throw from toString.
    }
  }
  if (typeof err === "string") textSources.push(err);

  const haystack = [...logs, ...textSources].join("\n");

  // Stage 2: identify the origin program from Solana runtime logs.
  // Walk lines in order; remember the last `Program X failed:` (that is
  // the program that actually threw). Fall back to the deepest-invoked
  // program if no explicit failure line is present.
  let originProgramId: string | undefined;
  let deepestInvoke: { programId: string; depth: number } | undefined;
  for (const line of logs) {
    const failed = line.match(PROGRAM_FAILED_RE);
    if (failed) {
      originProgramId = failed[1];
    }
    const invoked = line.match(PROGRAM_INVOKE_RE);
    if (invoked) {
      const depth = Number(invoked[2]);
      if (!deepestInvoke || depth > deepestInvoke.depth) {
        deepestInvoke = { programId: invoked[1], depth };
      }
    }
  }
  if (originProgramId === undefined && deepestInvoke) {
    originProgramId = deepestInvoke.programId;
  }

  // Stage 3: match any of the three real Anchor error formats.
  for (const re of ANCHOR_ERROR_RES) {
    const match = haystack.match(re);
    if (match) {
      return {
        name: match[1],
        code: Number(match[2]),
        originProgramId,
        logs,
      };
    }
  }

  // Stage 4: fall back to raw custom hex code. Resolve name by code.
  const hex = haystack.match(CUSTOM_PROGRAM_ERROR_RE);
  if (hex) {
    const code = parseInt(hex[1], 16);
    const name = nameForCode(code);
    return {
      code,
      name: name ?? "UnknownCustomError",
      originProgramId,
      logs,
    };
  }

  return null;
}

function nameForCode(code: number): string | undefined {
  // Check Sigil range first (6000+) — no overlap with Anchor framework (≤5999),
  // but we assert the range to be explicit if that ever changes.
  if (code >= 6000) {
    for (const [name, c] of Object.entries(SIGIL_ERRORS)) {
      if (c === code) return name;
    }
  } else {
    for (const [name, c] of Object.entries(ANCHOR_FRAMEWORK_ERRORS)) {
      if (c === code) return name;
    }
  }
  return undefined;
}

/**
 * Enforce that a parsed error originated from the Sigil program, not a
 * CPI callee. Throws {@link SigilAssertionError} on CPI origin mismatch.
 *
 * If the origin could not be resolved (unparseable logs, raw hex-only
 * fallback), we do NOT fail the assertion — the guard is best-effort,
 * not fail-closed — but the diagnostic notes the unverified state.
 */
function assertSigilOrigin(
  parsed: ParsedAnchorError,
  contextExpected: string,
  err: unknown,
): void {
  if (
    parsed.originProgramId !== undefined &&
    parsed.originProgramId !== SIGIL_PROGRAM_ID_BASE58
  ) {
    throw new SigilAssertionError(
      `${contextExpected} thrown by ${SIGIL_PROGRAM_ID_BASE58}; ` +
        `got error from CPI callee ${parsed.originProgramId} ` +
        `(${parsed.name} / ${parsed.code}).\n` +
        formatErrorForDiagnostic(err),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Public helpers
// ────────────────────────────────────────────────────────────────

/**
 * Assert that `err` is a Sigil program error matching the given name
 * (and optionally code).
 *
 * @param err   The thrown error — any shape. Raw Error, AnchorError,
 *              SendTransactionError, string, unknown.
 * @param expected.name  Sigil error name. Typed — typos fail tsc.
 * @param expected.code  Optional numeric code. If passed, must match
 *              the name's canonical code. Lets authors document intent;
 *              CI drift-check ensures name↔code coupling.
 *
 * Throws {@link SigilAssertionError} if:
 *   - error is unparseable as an Anchor/Sigil error
 *   - error name does not match
 *   - error code does not match (when provided)
 *   - error was thrown by a CPI callee (not Sigil program) — G-1 guard
 */
export function expectSigilError<N extends SigilErrorName>(
  err: unknown,
  expected: { name: N; code?: SigilErrorCodeFor<N> },
): void {
  const parsed = parseAnchorError(err);
  if (!parsed) {
    throw new SigilAssertionError(
      `expected Sigil error '${expected.name}' (${SIGIL_ERRORS[expected.name]}); ` +
        `error is not parseable as an Anchor/Sigil error.\n` +
        formatErrorForDiagnostic(err),
    );
  }

  const canonicalCode = SIGIL_ERRORS[expected.name];
  const claimedCode = expected.code ?? canonicalCode;

  if (claimedCode !== canonicalCode) {
    // Author passed an explicit code that disagrees with the name.
    // This is a programming error — fail loudly even before touching `err`.
    throw new SigilAssertionError(
      `helper misuse: expected.name '${expected.name}' maps to code ` +
        `${canonicalCode}, but expected.code was ${claimedCode}. ` +
        `Drop expected.code or fix the value.`,
    );
  }

  // G-1 CPI-origin guard — check BEFORE name match so a Jupiter
  // coincidentally-coded UnauthorizedAgent doesn't silently pass.
  assertSigilOrigin(parsed, `expected Sigil error '${expected.name}'`, err);

  if (parsed.name !== expected.name || parsed.code !== canonicalCode) {
    throw new SigilAssertionError(
      `expected Sigil error '${expected.name}' (${canonicalCode}); ` +
        `got '${parsed.name}' (${parsed.code}).\n` +
        formatErrorForDiagnostic(err),
    );
  }
}

/**
 * Assert that `err` is an Anchor framework error (2000-5999) matching
 * the given name, and was thrown by the Sigil program (not a CPI callee).
 *
 * Only for tests that *intentionally* verify framework-layer behavior —
 * seed derivation, account init, has_one constraints, etc. If the test
 * is about Sigil business logic, use {@link expectSigilError} instead.
 */
export function expectAnchorError<N extends AnchorFrameworkName>(
  err: unknown,
  expected: { name: N; code?: AnchorFrameworkCodeFor<N> },
): void {
  const parsed = parseAnchorError(err);
  if (!parsed) {
    throw new SigilAssertionError(
      `expected Anchor framework error '${expected.name}' (${ANCHOR_FRAMEWORK_ERRORS[expected.name]}); ` +
        `error is not parseable.\n` +
        formatErrorForDiagnostic(err),
    );
  }

  const canonicalCode = ANCHOR_FRAMEWORK_ERRORS[expected.name];
  const claimedCode = expected.code ?? canonicalCode;

  if (claimedCode !== canonicalCode) {
    throw new SigilAssertionError(
      `helper misuse: expected.name '${expected.name}' maps to Anchor code ` +
        `${canonicalCode}, but expected.code was ${claimedCode}.`,
    );
  }

  // G-1 applies to framework errors too — Anchor codes are emitted by
  // every Anchor program, so Jupiter's `ConstraintSeeds` would otherwise
  // satisfy a Sigil-scoped assertion.
  assertSigilOrigin(
    parsed,
    `expected Anchor framework error '${expected.name}'`,
    err,
  );

  if (parsed.name !== expected.name || parsed.code !== canonicalCode) {
    throw new SigilAssertionError(
      `expected Anchor framework error '${expected.name}' (${canonicalCode}); ` +
        `got '${parsed.name}' (${parsed.code}).\n` +
        formatErrorForDiagnostic(err),
    );
  }
}

/**
 * Assert that `err` is ONE of a tight set of Sigil errors.
 *
 * Tuple-typed at ≤3 elements (YULIA amendment). Use only for tests where
 * the error path is legitimately multi-valued AND both outcomes are
 * equally valid specifications — e.g., a race condition between two
 * independent checks where either firing first is acceptable.
 *
 * If you find yourself reaching for this helper on a single code path,
 * the underlying code has a non-determinism smell. Split the test.
 */
export type OneOfSigilErrors =
  | readonly [SigilErrorName]
  | readonly [SigilErrorName, SigilErrorName]
  | readonly [SigilErrorName, SigilErrorName, SigilErrorName];

export function expectOneOfSigilErrors(
  err: unknown,
  names: OneOfSigilErrors,
): void {
  const parsed = parseAnchorError(err);
  if (!parsed) {
    throw new SigilAssertionError(
      `expected one of [${names.join(", ")}]; error is not parseable.\n` +
        formatErrorForDiagnostic(err),
    );
  }

  assertSigilOrigin(parsed, `expected one of [${names.join(", ")}]`, err);

  for (const name of names) {
    if (parsed.name === name && parsed.code === SIGIL_ERRORS[name]) return;
  }

  const expected = names.map((n) => `${n} (${SIGIL_ERRORS[n]})`).join(" | ");
  throw new SigilAssertionError(
    `expected one of [${expected}]; got '${parsed.name}' (${parsed.code}).\n` +
      formatErrorForDiagnostic(err),
  );
}

/**
 * Assert that `err` is ONE of a tight set of Anchor framework errors,
 * thrown by the Sigil program (not a CPI callee).
 *
 * Tuple-typed at ≤3 elements, symmetric with {@link expectOneOfSigilErrors}.
 * Use only for tests where Anchor's check-order can legitimately produce
 * more than one constraint failure — e.g., "non-owner cannot X" tests
 * where either `ConstraintSeeds` (PDA derivation) or `ConstraintHasOne`
 * (`has_one = owner`) fires first depending on account ordering.
 *
 * If both constraints fire deterministically on one path, prefer the
 * specific {@link expectAnchorError} — this helper is for the genuine
 * multi-valued case.
 */
export type OneOfAnchorErrors =
  | readonly [AnchorFrameworkName]
  | readonly [AnchorFrameworkName, AnchorFrameworkName]
  | readonly [AnchorFrameworkName, AnchorFrameworkName, AnchorFrameworkName];

export function expectOneOfAnchorErrors(
  err: unknown,
  names: OneOfAnchorErrors,
): void {
  const parsed = parseAnchorError(err);
  if (!parsed) {
    throw new SigilAssertionError(
      `expected one of Anchor framework errors [${names.join(", ")}]; ` +
        `error is not parseable.\n` +
        formatErrorForDiagnostic(err),
    );
  }

  assertSigilOrigin(
    parsed,
    `expected one of Anchor framework errors [${names.join(", ")}]`,
    err,
  );

  for (const name of names) {
    if (parsed.name === name && parsed.code === ANCHOR_FRAMEWORK_ERRORS[name]) {
      return;
    }
  }

  const expected = names
    .map((n) => `${n} (${ANCHOR_FRAMEWORK_ERRORS[n]})`)
    .join(" | ");
  throw new SigilAssertionError(
    `expected one of [${expected}]; got '${parsed.name}' (${parsed.code}).\n` +
      formatErrorForDiagnostic(err),
  );
}

/**
 * Assert that `err` is a raw Solana/system-program error with the given
 * numeric code. For cases where no Anchor wrapper is involved — system
 * program, SPL Token, ComputeBudget, or explicit `custom program error:
 * 0x...` patterns.
 *
 * Matches against structured parse first (hex code or Anchor-parsed
 * numeric code). Only falls back to WORD-BOUNDED decimal/hex match in
 * the raw message, never to substring match — to avoid `code 1` matching
 * `instruction 1` or `index 1`.
 */
export function expectSystemError(err: unknown, code: number): void {
  const parsed = parseAnchorError(err);
  if (parsed && parsed.code === code) return;

  const text = String(err ?? "");
  const hexCode = `0x${code.toString(16).toLowerCase()}`;
  const hexRe = new RegExp(
    `custom program error:\\s*${hexCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  if (hexRe.test(text)) return;

  throw new SigilAssertionError(
    `expected system/program error with code ${code} (${hexCode}); ` +
      `did not match.\n` +
      formatErrorForDiagnostic(err),
  );
}

// ────────────────────────────────────────────────────────────────
// Helper error type + diagnostic formatter
// ────────────────────────────────────────────────────────────────

/**
 * Thrown by the `expect*Error` helpers when an assertion fails.
 * A distinct class so test runners can format it specially if desired.
 * Preserves `cause` with the original error for root-cause triage.
 */
export class SigilAssertionError extends Error {
  constructor(message: string, cause?: unknown) {
    // @ts-ignore — ErrorOptions is ES2022+ but our target is ES2022.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SigilAssertionError";
    if (cause !== undefined && this.cause === undefined) {
      // Polyfill for runtimes that ignore ErrorOptions.
      Object.defineProperty(this, "cause", {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
  }
}

function formatErrorForDiagnostic(err: unknown): string {
  if (err === null) return "  (actual: null)";
  if (err === undefined) return "  (actual: undefined)";

  const parts: string[] = [];
  const anyErr = err as { name?: unknown; message?: unknown; logs?: unknown };

  if (typeof anyErr.name === "string") parts.push(`  name: ${anyErr.name}`);
  if (typeof anyErr.message === "string") {
    const msg = anyErr.message.slice(0, 400);
    parts.push(`  message: ${msg}`);
  }
  if (Array.isArray(anyErr.logs)) {
    const logs = (anyErr.logs as unknown[])
      .filter((l): l is string => typeof l === "string")
      .slice(0, 20);
    if (logs.length > 0) parts.push(`  logs:\n    ${logs.join("\n    ")}`);
  } else if (anyErr.logs === undefined) {
    parts.push(
      `  logs: undefined — for @solana/kit SendTransactionError, call ` +
        `\`await err.getLogs(rpc)\` before assertion (G-2)`,
    );
  }

  if (parts.length === 0) parts.push(`  raw: ${String(err).slice(0, 200)}`);

  return `received:\n${parts.join("\n")}`;
}
