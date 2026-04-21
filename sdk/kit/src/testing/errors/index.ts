// @usesigil/kit/testing/errors
//
// Strict error-assertion helpers for Sigil tests.
//
// See: MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md

export {
  expectAnchorError,
  expectOneOfAnchorErrors,
  expectOneOfSigilErrors,
  expectSigilError,
  expectSystemError,
  parseAnchorError,
  SIGIL_PROGRAM_ID_BASE58,
  SigilAssertionError,
  type OneOfAnchorErrors,
  type OneOfSigilErrors,
} from "./expect.js";

export {
  ANCHOR_FRAMEWORK_ERRORS,
  SIGIL_ERROR_COUNT,
  SIGIL_ERROR_MAX,
  SIGIL_ERROR_MIN,
  SIGIL_ERRORS,
  type AnchorFrameworkCodeFor,
  type AnchorFrameworkName,
  type SigilErrorCode,
  type SigilErrorCodeFor,
  type SigilErrorName,
} from "./names.generated.js";
