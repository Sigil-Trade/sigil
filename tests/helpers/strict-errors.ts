/**
 * Strict error-assertion helpers for LiteSVM/on-chain tests.
 *
 * This file is an INLINED COPY of `sdk/kit/src/testing/errors/` —
 * deliberately duplicated (NOT re-exported) because:
 *
 *   1. `@usesigil/kit` has `"type": "module"` in its package.json,
 *      making every subpath ESM-only.
 *   2. LiteSVM tests run via `ts-mocha -p ./tsconfig.json` with
 *      `module: "commonjs"` — compiles tests to CJS.
 *   3. CJS `require("@usesigil/kit/testing")` would hit the ESM
 *      boundary, either failing with ERR_REQUIRE_ESM or (on Node 24)
 *      cascading into ESM-mode resolution where extensionless imports
 *      like `import { Sigil } from "../target/types/sigil"` break
 *      with ERR_MODULE_NOT_FOUND.
 *   4. A relative re-export shim doesn't help — the SDK source uses
 *      `.js` internal imports (ESM convention) which ts-mocha's CJS
 *      resolver can't map back to `.ts`.
 *
 * So we inline. If this file drifts from the SDK source, the CI
 * drift-check (`scripts/verify-error-drift.ts`) catches any SIGIL_ERRORS
 * table divergence; the helper LOGIC drift is caught by the SDK meta-
 * tests at `sdk/kit/tests/errors/expect-assertion.test.ts`.
 *
 * Council decision: 7-0 STRICT (2026-04-20). See:
 *   MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md
 *
 * Any behavioral change to assertions should be made HERE AND in
 * `sdk/kit/src/testing/errors/expect.ts` simultaneously.
 */

// ────────────────────────────────────────────────────────────────
// Sigil error names → codes (mirror of sdk/kit/src/testing/errors/names.generated.ts)
// ────────────────────────────────────────────────────────────────

export const SIGIL_ERRORS = {
  VaultNotActive: 6000,
  UnauthorizedAgent: 6001,
  UnauthorizedOwner: 6002,
  UnsupportedToken: 6003,
  ProtocolNotAllowed: 6004,
  TransactionTooLarge: 6005,
  SpendingCapExceeded: 6006,
  SessionNotAuthorized: 6007,
  InvalidSession: 6008,
  TooManyAllowedProtocols: 6009,
  AgentAlreadyRegistered: 6010,
  NoAgentRegistered: 6011,
  VaultNotFrozen: 6012,
  VaultAlreadyClosed: 6013,
  InsufficientBalance: 6014,
  DeveloperFeeTooHigh: 6015,
  InvalidFeeDestination: 6016,
  InvalidProtocolTreasury: 6017,
  InvalidAgentKey: 6018,
  AgentIsOwner: 6019,
  Overflow: 6020,
  InvalidTokenAccount: 6021,
  TimelockNotExpired: 6022,
  NoTimelockConfigured: 6023,
  DestinationNotAllowed: 6024,
  TooManyDestinations: 6025,
  InvalidProtocolMode: 6026,
  CpiCallNotAllowed: 6027,
  MissingFinalizeInstruction: 6028,
  NonTrackedSwapMustReturnStablecoin: 6029,
  UnauthorizedTokenTransfer: 6030,
  SlippageBpsTooHigh: 6031,
  ProtocolMismatch: 6032,
  TooManyDeFiInstructions: 6033,
  MaxAgentsReached: 6034,
  InsufficientPermissions: 6035,
  InvalidPermissions: 6036,
  InvalidConstraintConfig: 6037,
  AgentSpendLimitExceeded: 6038,
  OverlaySlotExhausted: 6039,
  AgentSlotNotFound: 6040,
  UnauthorizedTokenApproval: 6041,
  InvalidSessionExpiry: 6042,
  ProtocolCapExceeded: 6043,
  ProtocolCapsMismatch: 6044,
  PendingPolicyExists: 6045,
  AgentPaused: 6046,
  AgentAlreadyPaused: 6047,
  AgentNotPaused: 6048,
  UnauthorizedPostFinalizeInstruction: 6049,
  UnexpectedBalanceDecrease: 6050,
  TimelockTooShort: 6051,
  PolicyVersionMismatch: 6052,
  ActiveSessionsExist: 6053,
  PostAssertionFailed: 6054,
  InvalidPostAssertionIndex: 6055,
  UnauthorizedPreValidateInstruction: 6056,
  SnapshotNotCaptured: 6057,
  InvalidConstraintOperator: 6058,
  ZeroCopyVaultMismatch: 6059,
  QueuedUpdateExpired: 6060,
  AccountWritabilityMismatch: 6061,
  SysvarScanBoundExceeded: 6062,
  AsyncFulfillmentNotPermitted: 6063,
  ConfidentialTransferBlocked: 6064,
  PermanentDelegateBlocked: 6065,
  TransferHookBlocked: 6066,
  LamportDrainBlocked: 6067,
  BatchInstructionBlocked: 6068,
  InvalidDestinationMode: 6069,
  InvalidCapability: 6070,
  PolicyPreviewMismatch: 6071,
  ObserveOnlyModeBlocksExecute: 6072,
  ActiveVaultRequiresAllowlist: 6073,
  ErrMintNotPinned: 6074,
  ErrOutsideOperatingHours: 6075,
  ErrCooldownActive: 6076,
  ErrGraylistFriction: 6077,
  ErrGraylistFull: 6078,
  ErrToken2022ExtensionForbidden: 6079,
  ErrCosignRequired: 6080,
  ErrAutoRevoked: 6081,
  ErrSandwichIntegrity: 6082,
  ErrProtectedWritable: 6083,
  ErrSessionNonceMismatch: 6084,
  ErrStableFloorViolation: 6085,
  ErrDailyCapExceeded: 6086,
  ErrRecipientCapExceeded: 6087,
  ErrMintDeltaCapExceeded: 6088,
  MintDeltaCapMisconfigured: 6089,
  ErrAtaAuthorityChanged: 6090,
  ErrOutputBelowFloor: 6091,
  ErrDeclarationInconsistent: 6092,
  IxMetaCountExceeded: 6093,
  ErrPendingOwnershipExists: 6094,
  ErrPendingOwnershipNotReady: 6095,
  ErrInvalidFreezeReason: 6096,
  ErrReactivateCooldownActive: 6097,
  ErrInvalidOwnershipTarget: 6098,
  ErrTooManyRevokePairs: 6099,
  ErrPostAssertionsNotClosed: 6100,
  ErrDestinationIsProtectedPda: 6101,
  ErrIntentDigestMismatch: 6102,
  ErrPendingAgentGrantDigestMismatch: 6103,
  ErrReactivateCosignRequiredForFullCapability: 6104,
} as const;

export type SigilErrorName = keyof typeof SIGIL_ERRORS;
export type SigilErrorCode = (typeof SIGIL_ERRORS)[SigilErrorName];
export type SigilErrorCodeFor<N extends SigilErrorName> =
  (typeof SIGIL_ERRORS)[N];

export const ANCHOR_FRAMEWORK_ERRORS = {
  InstructionMissing: 100,
  InstructionFallbackNotFound: 101,
  InstructionDidNotDeserialize: 102,
  InstructionDidNotSerialize: 103,
  IdlInstructionStub: 1000,
  IdlInstructionInvalidProgram: 1001,
  IdlAccountNotEmpty: 1002,
  ConstraintMut: 2000,
  ConstraintHasOne: 2001,
  ConstraintSigner: 2002,
  ConstraintRaw: 2003,
  ConstraintOwner: 2004,
  ConstraintRentExempt: 2005,
  ConstraintSeeds: 2006,
  ConstraintExecutable: 2007,
  ConstraintState: 2008,
  ConstraintAssociated: 2009,
  ConstraintAssociatedInit: 2010,
  ConstraintClose: 2011,
  ConstraintAddress: 2012,
  ConstraintZero: 2013,
  ConstraintTokenMint: 2014,
  ConstraintTokenOwner: 2015,
  ConstraintMintMintAuthority: 2016,
  ConstraintMintFreezeAuthority: 2017,
  ConstraintMintDecimals: 2018,
  ConstraintSpace: 2019,
  ConstraintAccountIsNone: 2020,
  ConstraintTokenTokenProgram: 2021,
  ConstraintMintTokenProgram: 2022,
  ConstraintAssociatedTokenTokenProgram: 2023,
  AccountDiscriminatorAlreadySet: 3000,
  AccountDiscriminatorNotFound: 3001,
  AccountDiscriminatorMismatch: 3002,
  AccountDidNotDeserialize: 3003,
  AccountDidNotSerialize: 3004,
  AccountNotEnoughKeys: 3005,
  AccountNotMutable: 3006,
  AccountOwnedByWrongProgram: 3007,
  InvalidProgramId: 3008,
  InvalidProgramExecutable: 3009,
  AccountNotSigner: 3010,
  AccountNotSystemOwned: 3011,
  AccountNotInitialized: 3012,
  AccountNotProgramData: 3013,
  AccountNotAssociatedTokenAccount: 3014,
  AccountSysvarMismatch: 3015,
  AccountReallocExceedsLimit: 3016,
  AccountDuplicateReallocs: 3017,
  StateInvalidAddress: 4000,
  DeclaredProgramIdMismatch: 4100,
  TryingToInitPayerAsProgramAccount: 4101,
  InvalidNumericConversion: 4102,
  Deprecated: 5000,
} as const;

export type AnchorFrameworkName = keyof typeof ANCHOR_FRAMEWORK_ERRORS;
export type AnchorFrameworkCodeFor<N extends AnchorFrameworkName> =
  (typeof ANCHOR_FRAMEWORK_ERRORS)[N];

// ────────────────────────────────────────────────────────────────
// Program ID + parser (mirror of sdk/kit/src/testing/errors/expect.ts)
// ────────────────────────────────────────────────────────────────

export const SIGIL_PROGRAM_ID_BASE58 =
  "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK";

interface ParsedAnchorError {
  code: number;
  name: string;
  originProgramId?: string;
  logs: string[];
}

// ReDoS-hardened patterns — bounded quantifiers prevent polynomial backtracking.
const ANCHOR_ERROR_RES: Array<RegExp> = [
  /AnchorError thrown in [^:\s]{1,256}:\d{1,10}\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
  /AnchorError caused by account:\s{0,8}\w{1,64}\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
  /AnchorError occurred\.\s{0,8}Error Code:\s{0,8}(\w{1,64})\.\s{0,8}Error Number:\s{0,8}(\d{1,10})\./,
];
const PROGRAM_INVOKE_RE =
  /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]/;
const PROGRAM_FAILED_RE = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed:/;
const CUSTOM_PROGRAM_ERROR_RE = /custom program error:\s*0x([0-9a-f]+)/i;

export function parseAnchorError(err: unknown): ParsedAnchorError | null {
  if (err === null || err === undefined) return null;

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

  // Identify the origin program from Solana runtime logs.
  let originProgramId: string | undefined;
  let deepestInvoke: { programId: string; depth: number } | undefined;
  for (const line of logs) {
    const failed = line.match(PROGRAM_FAILED_RE);
    if (failed) originProgramId = failed[1];
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

  // Match any of the three real Anchor error formats.
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

  // Fall back to raw custom hex code.
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
    throw new SigilAssertionError(
      `helper misuse: expected.name '${expected.name}' maps to code ` +
        `${canonicalCode}, but expected.code was ${claimedCode}. ` +
        `Drop expected.code or fix the value.`,
    );
  }

  assertSigilOrigin(parsed, `expected Sigil error '${expected.name}'`, err);

  if (parsed.name !== expected.name || parsed.code !== canonicalCode) {
    throw new SigilAssertionError(
      `expected Sigil error '${expected.name}' (${canonicalCode}); ` +
        `got '${parsed.name}' (${parsed.code}).\n` +
        formatErrorForDiagnostic(err),
    );
  }
}

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

export class SigilAssertionError extends Error {
  constructor(message: string, cause?: unknown) {
    // @ts-ignore — ErrorOptions is ES2022+ but our target is ES2022.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SigilAssertionError";
    if (cause !== undefined && this.cause === undefined) {
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
