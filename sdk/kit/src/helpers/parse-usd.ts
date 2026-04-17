/**
 * parseUsd — strict USD-string parser that returns 6-decimal base units.
 *
 * Rationale: consumers frequently need to express dollar amounts ("$500",
 * "$0.01") in UI surfaces, CLIs, and config files. Parsing those strings
 * with `parseFloat` or `Number(...)` introduces floating-point rounding
 * errors that compound into cap-enforcement bugs on-chain. This helper
 * uses a strict regex and BigInt arithmetic only — no floating-point path
 * exists at any step.
 *
 * Grammar (regex `^\$(0|[1-9]\d{0,14})(\.\d{1,6})?$`):
 *   - Leading literal `$` is required
 *   - Whole part: `0` alone, OR a 1-15 digit number with no leading zero
 *     (`$01` / `$007` are rejected as typos; `$0` / `$0.5` are valid)
 *   - 15 digits max × 10^6 scale = 10^21, well within BigInt range
 *   - Optional fractional part: `.` + 1–6 digits (matches USD_DECIMALS = 6)
 *   - No thousands separators, no exponent notation, no sign, no whitespace
 *
 * Output: bigint in 6-decimal USD base units (`$1 → 1_000_000n`).
 *
 * Errors: throws `SigilSdkDomainError` with code
 * `SIGIL_ERROR__SDK__INVALID_AMOUNT` for any malformed input. The error
 * `.context` carries the original input string to aid debugging.
 *
 * Examples:
 *   parseUsd("$0")              // → 0n
 *   parseUsd("$0.01")           // → 10_000n
 *   parseUsd("$1")              // → 1_000_000n
 *   parseUsd("$1.5")            // → 1_500_000n
 *   parseUsd("$100.000001")     // → 100_000_001n
 *   parseUsd("$999999999999999")// → 999_999_999_999_999_000_000n
 *   parseUsd("1.0")             // throws — missing "$"
 *   parseUsd("$1,000")          // throws — commas not allowed
 *   parseUsd("$1e3")            // throws — exponent not allowed
 *   parseUsd("$1.1234567")      // throws — > 6 decimals
 *   parseUsd("$-1")             // throws — negative not allowed
 *
 * @param input USD-denominated string, including literal leading "$"
 * @returns `bigint` in 6-decimal base units (USD_DECIMALS = 6)
 * @throws  {SigilSdkDomainError} code SIGIL_ERROR__SDK__INVALID_AMOUNT
 */

import { SigilSdkDomainError } from "../errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_AMOUNT } from "../errors/codes.js";

// USD_DECIMALS = 6 — hardcoded here to keep parse-usd.ts dependency-free
// from the larger types barrel. Must stay in sync with
// programs/sigil/src/state/mod.rs:224 and sdk/kit/src/types.ts USD_DECIMALS.
const USD_DECIMALS = 6;
const USD_BASE = 1_000_000n; // 10 ** USD_DECIMALS

// Strict format:
//   - Leading literal `$`
//   - Whole part: either "0" OR a 1-15 digit number that doesn't start with 0.
//     Prevents `$00`, `$01`, `$007` from silently parsing — those are almost
//     always typos, never intentional amounts.
//   - Optional `.` + 1–6 decimal digits (capture group 2 includes the dot)
const USD_REGEX = /^\$(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

export function parseUsd(input: string): bigint {
  if (typeof input !== "string") {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `parseUsd expected a string, received ${typeof input}`,
      { context: { input: String(input) } as never },
    );
  }

  const match = input.match(USD_REGEX);
  if (match === null) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `Invalid USD amount: "${input}". ` +
        `Expected format "$<whole>[.<fraction>]" — ` +
        `up to 15 whole digits, up to ${USD_DECIMALS} fractional digits, ` +
        `no commas, no exponent, no sign, no whitespace.`,
      { context: { input } as never },
    );
  }

  const [, whole, fractionPart] = match;
  // `whole` is guaranteed non-empty (regex `\d{1,15}`).
  const wholeBig = BigInt(whole!);
  let result = wholeBig * USD_BASE;

  if (fractionPart !== undefined) {
    // fractionPart includes the leading dot: ".5", ".000001"
    const fractionDigits = fractionPart.slice(1);
    // Pad fractionDigits to exactly USD_DECIMALS digits (right-pad with 0).
    // "5" → "500000"; "000001" → "000001"
    const padded = fractionDigits.padEnd(USD_DECIMALS, "0");
    result += BigInt(padded);
  }

  return result;
}
