// @usesigil/kit/testing — Test utilities for consumers of the Sigil SDK.
//
// Mock utilities (unit tests — no network)

export {
  MOCK_VAULT,
  MOCK_AGENT,
  MOCK_OWNER,
  MOCK_POLICY,
  MOCK_SIGNATURE,
  MOCK_BLOCKHASH,
  USDC_MINT,
  SOL_MINT,
  createMockRpc,
  createMockAgent,
  type MockRpcOverrides,
} from "./mock-rpc.js";

export {
  createMockVaultState,
  type MockVaultStateOverrides,
} from "./mock-state.js";

// Strict error-assertion helpers — see:
//   MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md
//
// Replaces the legacy substring-matching helpers with structured
// {name, code}-coupled typed helpers. Importing from the barrel gives
// consumers a one-import experience; the implementation and its
// IDL-derived types live under ./errors/.
export {
  ANCHOR_FRAMEWORK_ERRORS,
  SIGIL_ERRORS,
  SIGIL_ERROR_COUNT,
  SIGIL_ERROR_MAX,
  SIGIL_ERROR_MIN,
  SIGIL_PROGRAM_ID_BASE58,
  SigilAssertionError,
  expectAnchorError,
  expectOneOfAnchorErrors,
  expectOneOfSigilErrors,
  expectSigilError,
  expectSystemError,
  parseAnchorError,
  type AnchorFrameworkCodeFor,
  type AnchorFrameworkName,
  type OneOfAnchorErrors,
  type OneOfSigilErrors,
  type SigilErrorCode,
  type SigilErrorCodeFor,
  type SigilErrorName,
} from "./errors/index.js";

// NOTE: Devnet utilities intentionally NOT re-exported here.
// devnet.ts imports node:fs + @solana/web3.js — breaks browser bundlers.
// Import directly: import { ... } from "@usesigil/kit/testing/devnet"
