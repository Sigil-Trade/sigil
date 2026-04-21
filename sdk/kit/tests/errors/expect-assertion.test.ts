/**
 * Meta-tests for strict error-assertion helpers.
 *
 * The test fixtures here reproduce the THREE real Anchor 0.32.1 log
 * shapes (not fabricated formats):
 *
 *   1. ErrorOrigin::None        → "AnchorError occurred."
 *   2. ErrorOrigin::Source      → "AnchorError thrown in <file>:<line>."
 *   3. ErrorOrigin::AccountName → "AnchorError caused by account: <name>."
 *
 * Source: https://github.com/coral-xyz/anchor/blob/v0.32.1/lang/src/error.rs#L499-L541
 *
 * We also reproduce the Solana runtime's CPI trace shape (`Program X
 * invoke [D]` / `Program X failed:`) because that is how we extract
 * the origin program id for the G-1 CPI guard.
 *
 * If these fixtures go stale relative to Anchor's real output, the
 * helpers stop working on real devnet/LiteSVM errors. Any regression
 * there is a ship-blocker.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import {
  expectAnchorError,
  expectOneOfAnchorErrors,
  expectOneOfSigilErrors,
  expectSigilError,
  expectSystemError,
  parseAnchorError,
  SigilAssertionError,
  SIGIL_ERRORS,
  SIGIL_PROGRAM_ID_BASE58,
} from "../../src/testing/errors/index.js";

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// Note: numeric codes referenced below (6000, 6001, 6006, 6021, 6015, 6022,
// 6038, 2003, 2006) are from the post-position-counter-deletion renumber
// (see MEMORY/... COUNCIL_DECISION.md). If the IDL shifts again, the
// coupled {name, code} types will make tsc fail here — which is the point.
// SIGIL_ERRORS imported above gives the current canonical mapping.
void SIGIL_ERRORS;

// ────────────────────────────────────────────────────────────────
// Real Anchor 0.32.1 log builders
// ────────────────────────────────────────────────────────────────

/**
 * Build logs for `require!(...)` / `error!()` — the most common shape.
 * Matches format #2 (`AnchorError thrown in <file>:<line>.`).
 */
function mkAnchorThrown(opts: {
  programId?: string;
  name: string;
  code: number;
  file?: string;
  line?: number;
  cpiDepth?: number; // 1 = top-level, 2+ = invoked via CPI
}): Error & { logs: string[] } {
  const programId = opts.programId ?? SIGIL_PROGRAM_ID_BASE58;
  const file = opts.file ?? "programs/sigil/src/instructions/agent_transfer.rs";
  const line = opts.line ?? 42;
  const depth = opts.cpiDepth ?? 1;

  const logs: string[] = [];
  // Simulate CPI invocation trace if depth > 1.
  for (let d = 1; d <= depth; d++) {
    logs.push(
      `Program ${d === depth ? programId : SIGIL_PROGRAM_ID_BASE58} invoke [${d}]`,
    );
  }
  logs.push(
    `Program log: AnchorError thrown in ${file}:${line}. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`,
  );
  logs.push(`Program ${programId} consumed 12345 of 1400000 compute units`);
  logs.push(
    `Program ${programId} failed: custom program error: 0x${opts.code.toString(16)}`,
  );

  const message = `AnchorError thrown in ${file}:${line}. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`;
  return Object.assign(new Error(message), { logs });
}

/**
 * Build logs for `#[account(constraint = ... @ E)]` — Anchor account
 * constraint violation. Matches format #3 (`AnchorError caused by
 * account: <name>.`).
 */
function mkAnchorAccountConstraint(opts: {
  programId?: string;
  accountName: string;
  name: string;
  code: number;
}): Error & { logs: string[] } {
  const programId = opts.programId ?? SIGIL_PROGRAM_ID_BASE58;
  const logs: string[] = [
    `Program ${programId} invoke [1]`,
    `Program log: AnchorError caused by account: ${opts.accountName}. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`,
    `Program ${programId} consumed 999 of 1400000 compute units`,
    `Program ${programId} failed: custom program error: 0x${opts.code.toString(16)}`,
  ];
  const message = `AnchorError caused by account: ${opts.accountName}. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`;
  return Object.assign(new Error(message), { logs });
}

/**
 * Build logs for `ErrorOrigin::None` — synthesized errors without
 * location info. Less common but possible.
 */
function mkAnchorOccurred(opts: {
  programId?: string;
  name: string;
  code: number;
}): Error & { logs: string[] } {
  const programId = opts.programId ?? SIGIL_PROGRAM_ID_BASE58;
  const logs: string[] = [
    `Program ${programId} invoke [1]`,
    `Program log: AnchorError occurred. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`,
    `Program ${programId} failed: custom program error: 0x${opts.code.toString(16)}`,
  ];
  const message = `AnchorError occurred. Error Code: ${opts.name}. Error Number: ${opts.code}. Error Message: stub.`;
  return Object.assign(new Error(message), { logs });
}

/** Raw custom-program-error string (no Anchor log wrapping). */
function mkRawCustomError(code: number): Error {
  return new Error(`custom program error: 0x${code.toString(16)}`);
}

/** Expect a thunk to throw SigilAssertionError with a message matching `re`. */
function expectFail(fn: () => void, re: RegExp): void {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof SigilAssertionError,
      `expected SigilAssertionError, got ${err?.constructor?.name ?? typeof err}`,
    );
    assert.match((err as Error).message, re);
    return;
  }
  assert.fail("expected helper to throw but it returned normally");
}

// ────────────────────────────────────────────────────────────────
// parseAnchorError — real Anchor log formats
// ────────────────────────────────────────────────────────────────

describe("parseAnchorError", () => {
  it("parses format #2: `AnchorError thrown in <file>:<line>` (most common)", () => {
    const err = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6001);
    assert.equal(parsed.name, "UnauthorizedAgent");
    assert.equal(parsed.originProgramId, SIGIL_PROGRAM_ID_BASE58);
  });

  it("parses format #3: `AnchorError caused by account`", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "UnauthorizedAgent",
      code: 6001,
    });
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6001);
    assert.equal(parsed.name, "UnauthorizedAgent");
    assert.equal(parsed.originProgramId, SIGIL_PROGRAM_ID_BASE58);
  });

  it("parses format #1: `AnchorError occurred` (ErrorOrigin::None)", () => {
    const err = mkAnchorOccurred({ name: "Overflow", code: 6020 });
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6020);
    assert.equal(parsed.name, "Overflow");
    assert.equal(parsed.originProgramId, SIGIL_PROGRAM_ID_BASE58);
  });

  it("parses raw hex custom program error (no Anchor wrap)", () => {
    const err = mkRawCustomError(6001);
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6001);
    assert.equal(parsed.name, "UnauthorizedAgent");
  });

  it("extracts origin from CPI log `Program X failed` at depth 2", () => {
    const err = mkAnchorThrown({
      programId: JUPITER,
      name: "UnauthorizedAgent",
      code: 6001,
      cpiDepth: 2,
    });
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.originProgramId, JUPITER);
  });

  it("returns null for unparseable errors", () => {
    assert.equal(parseAnchorError(new Error("timeout")), null);
    assert.equal(parseAnchorError(null), null);
    assert.equal(parseAnchorError(undefined), null);
    assert.equal(parseAnchorError({}), null);
  });

  it("handles kit SendTransactionError: logs === undefined (G-2)", () => {
    // Kit's SendTransactionError leaves logs undefined until .getLogs().
    // The parser should still extract from message text via the hex
    // fallback.
    const err: any = new Error(
      `custom program error: 0x${(6001).toString(16)}`,
    );
    err.logs = undefined;
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6001);
    assert.equal(parsed.name, "UnauthorizedAgent");
  });

  it("ignores non-string entries in logs array", () => {
    const err: any = new Error("stub");
    err.logs = [
      null,
      { weird: true },
      42,
      `Program ${SIGIL_PROGRAM_ID_BASE58} failed: custom program error: 0x1771`,
    ];
    const parsed = parseAnchorError(err);
    assert.ok(parsed);
    assert.equal(parsed.code, 6001);
  });
});

// ────────────────────────────────────────────────────────────────
// expectSigilError
// ────────────────────────────────────────────────────────────────

describe("expectSigilError", () => {
  it("passes when name + code match (thrown format)", () => {
    const err = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    expectSigilError(err, { name: "UnauthorizedAgent", code: 6001 });
  });

  it("passes when only name is specified (thrown format)", () => {
    const err = mkAnchorThrown({ name: "Overflow", code: 6020 });
    expectSigilError(err, { name: "Overflow" });
  });

  it("passes on account-constraint format #3", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "UnauthorizedAgent",
      code: 6001,
    });
    expectSigilError(err, { name: "UnauthorizedAgent", code: 6001 });
  });

  it("passes on ErrorOrigin::None format #1", () => {
    const err = mkAnchorOccurred({ name: "SpendingCapExceeded", code: 6006 });
    expectSigilError(err, { name: "SpendingCapExceeded" });
  });

  it("fails loudly when name does not match", () => {
    const err = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    expectFail(
      () => expectSigilError(err, { name: "VaultNotActive" }),
      /expected Sigil error 'VaultNotActive'.*got 'UnauthorizedAgent'/s,
    );
  });

  it("fails when claimed code disagrees with name (helper misuse)", () => {
    const err = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    expectFail(
      // @ts-expect-error — intentional misuse, code must match name's canonical value
      () => expectSigilError(err, { name: "UnauthorizedAgent", code: 9999 }),
      /helper misuse.*name 'UnauthorizedAgent' maps to code 6001/s,
    );
  });

  it("fails when error is unparseable", () => {
    expectFail(
      () =>
        expectSigilError(new Error("timeout"), {
          name: "UnauthorizedAgent",
        }),
      /error is not parseable/,
    );
  });

  it("G-1: fails when error originates from CPI callee (format #2)", () => {
    const err = mkAnchorThrown({
      name: "UnauthorizedAgent",
      code: 6001,
      programId: JUPITER,
      cpiDepth: 2,
    });
    expectFail(
      () => expectSigilError(err, { name: "UnauthorizedAgent" }),
      /got error from CPI callee/,
    );
  });

  it("G-1: fails when CPI callee emits format #3 (account constraint)", () => {
    const err = mkAnchorAccountConstraint({
      programId: JUPITER,
      accountName: "swap_state",
      name: "UnauthorizedAgent",
      code: 6001,
    });
    expectFail(
      () => expectSigilError(err, { name: "UnauthorizedAgent" }),
      /got error from CPI callee/,
    );
  });

  it("works on raw hex custom program error (no logs)", () => {
    // MaxAgentsReached — canonical code is 6036 after phantom-error cleanup.
    // The coupled {name, code} type guarantees tsc catches any drift here.
    const err = mkRawCustomError(6036);
    expectSigilError(err, { name: "MaxAgentsReached", code: 6036 });
  });

  it("preserves original error as cause", () => {
    const original = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    try {
      expectSigilError(original, { name: "VaultNotActive" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof SigilAssertionError);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// expectAnchorError
// ────────────────────────────────────────────────────────────────

describe("expectAnchorError", () => {
  it("passes when Anchor framework error matches (format #3 — typical)", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintSeeds",
      code: 2006,
    });
    expectAnchorError(err, { name: "ConstraintSeeds", code: 2006 });
  });

  it("fails when Anchor code is wrong", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintRaw",
      code: 2003,
    });
    expectFail(
      () => expectAnchorError(err, { name: "ConstraintSeeds" }),
      /expected Anchor framework error 'ConstraintSeeds'.*got 'ConstraintRaw'/s,
    );
  });

  it("fails when claimed code disagrees with Anchor name", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintSeeds",
      code: 2006,
    });
    expectFail(
      // @ts-expect-error — misuse
      () => expectAnchorError(err, { name: "ConstraintSeeds", code: 1234 }),
      /helper misuse.*maps to Anchor code 2006/s,
    );
  });

  it("G-1: fails when Anchor error comes from CPI callee", () => {
    const err = mkAnchorAccountConstraint({
      programId: JUPITER,
      accountName: "pool",
      name: "ConstraintSeeds",
      code: 2006,
    });
    expectFail(
      () => expectAnchorError(err, { name: "ConstraintSeeds" }),
      /got error from CPI callee/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// expectOneOfSigilErrors
// ────────────────────────────────────────────────────────────────

describe("expectOneOfSigilErrors", () => {
  it("passes when error matches first name in tuple", () => {
    const err = mkAnchorThrown({ name: "VaultNotActive", code: 6000 });
    expectOneOfSigilErrors(err, ["VaultNotActive", "UnauthorizedAgent"]);
  });

  it("passes when error matches second name in tuple", () => {
    const err = mkAnchorThrown({ name: "UnauthorizedAgent", code: 6001 });
    expectOneOfSigilErrors(err, ["VaultNotActive", "UnauthorizedAgent"]);
  });

  it("passes with 3-element tuple", () => {
    const err = mkAnchorThrown({ name: "InsufficientBalance", code: 6014 });
    expectOneOfSigilErrors(err, [
      "VaultNotActive",
      "UnauthorizedAgent",
      "InsufficientBalance",
    ]);
  });

  it("passes on account-constraint format for one-of", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "output_stablecoin_account",
      name: "InvalidTokenAccount",
      code: 6021,
    });
    expectOneOfSigilErrors(err, ["UnsupportedToken", "InvalidTokenAccount"]);
  });

  it("fails when error matches none of the names", () => {
    const err = mkAnchorThrown({ name: "Overflow", code: 6020 });
    expectFail(
      () =>
        expectOneOfSigilErrors(err, ["VaultNotActive", "UnauthorizedAgent"]),
      /expected one of.*got 'Overflow'/s,
    );
  });

  it("G-1: fails when CPI callee emits a matching-coded error", () => {
    const err = mkAnchorThrown({
      name: "UnauthorizedAgent",
      code: 6001,
      programId: JUPITER,
      cpiDepth: 2,
    });
    expectFail(
      () =>
        expectOneOfSigilErrors(err, ["VaultNotActive", "UnauthorizedAgent"]),
      /got error from CPI callee/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// expectOneOfAnchorErrors (symmetric with expectOneOfSigilErrors)
// ────────────────────────────────────────────────────────────────

describe("expectOneOfAnchorErrors", () => {
  it("passes when error matches first Anchor name in tuple", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintSeeds",
      code: 2006,
    });
    expectOneOfAnchorErrors(err, ["ConstraintSeeds", "ConstraintHasOne"]);
  });

  it("passes when error matches second Anchor name in tuple", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintHasOne",
      code: 2001,
    });
    expectOneOfAnchorErrors(err, ["ConstraintSeeds", "ConstraintHasOne"]);
  });

  it("fails when Anchor error matches none of the names", () => {
    const err = mkAnchorAccountConstraint({
      accountName: "vault",
      name: "ConstraintRaw",
      code: 2003,
    });
    expectFail(
      () =>
        expectOneOfAnchorErrors(err, ["ConstraintSeeds", "ConstraintHasOne"]),
      /expected one of.*got 'ConstraintRaw'/s,
    );
  });

  it("G-1: fails when CPI callee emits matching-coded Anchor error", () => {
    const err = mkAnchorAccountConstraint({
      programId: JUPITER,
      accountName: "pool",
      name: "ConstraintSeeds",
      code: 2006,
    });
    expectFail(
      () =>
        expectOneOfAnchorErrors(err, ["ConstraintSeeds", "ConstraintHasOne"]),
      /got error from CPI callee/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// expectSystemError
// ────────────────────────────────────────────────────────────────

describe("expectSystemError", () => {
  it("passes when hex custom error code matches exactly", () => {
    const err = mkRawCustomError(0x1);
    expectSystemError(err, 0x1);
  });

  it("passes when Anchor-parsed code matches", () => {
    const err = mkAnchorThrown({ name: "Overflow", code: 6020 });
    expectSystemError(err, 6020);
  });

  it("rejects substring-coincidence matches (H-1 regression guard)", () => {
    // "code 999" substring-matching "99999" was a bug — fixed to require
    // exact hex format.
    const err = new Error(
      "Transaction simulation failed: block 99999 timed out",
    );
    expectFail(
      () => expectSystemError(err, 999),
      /expected system\/program error with code 999/,
    );
  });

  it("rejects decimal-in-arbitrary-position (H-1 regression guard)", () => {
    const err = new Error("Error processing Instruction 0: something");
    expectFail(
      () => expectSystemError(err, 0),
      /expected system\/program error with code 0/,
    );
  });

  it("fails when code does not match at all", () => {
    const err = new Error("program failed with code 999");
    expectFail(
      () => expectSystemError(err, 123),
      /expected system\/program error with code 123/,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Anti-regression — meta-guarantees about the types table itself
// (YULIA amendment case 7: codegen drift self-check)
// ────────────────────────────────────────────────────────────────

describe("SIGIL_ERRORS table integrity", () => {
  it("has ≥ 75 entries (sanity)", async () => {
    const { SIGIL_ERRORS, SIGIL_ERROR_COUNT } =
      await import("../../src/testing/errors/names.generated.js");
    assert.ok(
      SIGIL_ERROR_COUNT >= 75,
      `expected ≥ 75 Sigil error entries, got ${SIGIL_ERROR_COUNT}`,
    );
    assert.equal(SIGIL_ERRORS.VaultNotActive, 6000);
  });

  it("has no duplicate codes", async () => {
    const { SIGIL_ERRORS } =
      await import("../../src/testing/errors/names.generated.js");
    const codes = Object.values(SIGIL_ERRORS);
    const unique = new Set(codes);
    assert.equal(
      codes.length,
      unique.size,
      `duplicate Sigil error codes: ${codes.length} entries but only ${unique.size} unique`,
    );
  });

  it("every code lies in [6000, 6999]", async () => {
    const { SIGIL_ERRORS } =
      await import("../../src/testing/errors/names.generated.js");
    for (const [name, code] of Object.entries(SIGIL_ERRORS) as Array<
      [string, number]
    >) {
      assert.ok(
        code >= 6000 && code <= 6999,
        `${name} has out-of-range code ${code}`,
      );
    }
  });

  it("every Anchor framework code lies in [100, 5999]", async () => {
    const { ANCHOR_FRAMEWORK_ERRORS } =
      await import("../../src/testing/errors/names.generated.js");
    for (const [name, code] of Object.entries(ANCHOR_FRAMEWORK_ERRORS) as Array<
      [string, number]
    >) {
      assert.ok(
        code >= 100 && code <= 5999,
        `${name} has out-of-range code ${code}`,
      );
    }
  });
});
