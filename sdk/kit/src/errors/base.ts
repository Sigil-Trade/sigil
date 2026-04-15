/**
 * SigilError — base class for all programmatic errors raised by @usesigil/kit.
 *
 * Pattern: viem-style BaseError + @solana/kit-style code+context discrimination.
 *
 * - `shortMessage` — the human-readable message passed to the constructor, before
 *   formatting. Stable across `metaMessages`/`details` additions.
 * - `code` — single canonical SigilErrorCode discriminant (per UD1).
 * - `context` — typed payload bound at compile time via `SigilErrorContext[TCode]`.
 * - `cause` — chained underlying error; `walk()` traverses the chain.
 * - `version` — SDK version string for bug-report reproducibility.
 *
 * Subclass via the four domain classes (`SigilShieldError`, `SigilTeeError`,
 * `SigilX402Error`, `SigilComposeError`) — never extend `SigilError` directly
 * outside the errors/ module.
 */

import type { SigilErrorCode } from "./codes.js";
import type { SigilErrorContext } from "./context.js";
import { walk as walkChain } from "./walk.js";

/** Bumped manually with each release; matches sdk/kit/package.json. */
export const SIGIL_KIT_VERSION = "0.4.0";

export interface SigilErrorParameters<TContext = unknown> {
  /** Underlying error that caused this one. Surfaces via `walk()`. */
  cause?: SigilError | Error | unknown;
  /** Extra context lines appended after `shortMessage` (e.g., request args). */
  metaMessages?: string[];
  /** Optional documentation deep-link path appended to the message. */
  docsPath?: string;
  /** Typed context payload — see `SigilErrorContext` for shape per code. */
  context?: TContext;
}

export class SigilError<TCode extends SigilErrorCode = SigilErrorCode> extends Error {
  readonly code: TCode;
  readonly shortMessage: string;
  readonly details: string;
  readonly version: string;
  readonly metaMessages?: string[];
  readonly docsPath?: string;
  readonly context?: TCode extends keyof SigilErrorContext ? SigilErrorContext[TCode] : undefined;
  override cause?: Error | unknown;
  override name: string = "SigilError";

  constructor(
    code: TCode,
    shortMessage: string,
    args: SigilErrorParameters<
      TCode extends keyof SigilErrorContext ? SigilErrorContext[TCode] : undefined
    > = {},
  ) {
    const details = extractDetails(args.cause);
    const docsPath = args.docsPath ?? extractDocsPath(args.cause);
    const formatted = formatMessage(shortMessage, args.metaMessages, docsPath, details);
    super(formatted);
    this.code = code;
    this.shortMessage = shortMessage;
    this.details = details;
    this.version = SIGIL_KIT_VERSION;
    this.metaMessages = args.metaMessages;
    this.docsPath = docsPath;
    this.context = args.context;
    this.cause = args.cause;
  }

  /** Returns the root cause in the chain (or this error if no cause). */
  walk(): Error;
  /** Returns the first error in the chain (or this) matching the predicate, or null. */
  walk(fn: (err: unknown) => boolean): Error | null;
  walk(fn?: (err: unknown) => boolean): Error | null {
    return fn ? walkChain(this, fn) : walkChain(this);
  }
}

/**
 * Inherit `details` from a SigilError cause, falling back to the cause's message
 * for plain Error or non-Error values. Truncated to 500 chars to bound message size.
 */
function extractDetails(cause: unknown): string {
  if (cause === undefined) return "";
  if (cause instanceof SigilError) return cause.details || cause.shortMessage;
  if (cause instanceof Error) return truncate(cause.message, 500);
  if (typeof cause === "string") return truncate(cause, 500);
  return "";
}

function extractDocsPath(cause: unknown): string | undefined {
  if (cause instanceof SigilError) return cause.docsPath;
  return undefined;
}

function formatMessage(
  shortMessage: string,
  metaMessages: string[] | undefined,
  docsPath: string | undefined,
  details: string,
): string {
  const lines: string[] = [shortMessage];
  if (metaMessages && metaMessages.length > 0) {
    lines.push("", ...metaMessages);
  }
  if (docsPath) {
    lines.push("", `Docs: https://docs.sigil.trade${docsPath}`);
  }
  if (details && details !== shortMessage) {
    lines.push("", `Details: ${details}`);
  }
  lines.push("", `Version: @usesigil/kit@${SIGIL_KIT_VERSION}`);
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
