/**
 * Structural transport-error classification and safe error redaction.
 *
 * {@link isTransportError} inspects structural signals only (error class,
 * `.name`, `.cause.code`) — never message regex — to distinguish transport
 * failures (ECONNREFUSED, timeouts, TLS errors, HTTP/2 resets, 5xx upstream
 * responses) from provider denials or logic errors. Intended for SDK call
 * sites that want to surface "this was a network problem, retry may help"
 * in a redacted, diagnosable form without leaking secrets from the raw
 * error to downstream logs.
 *
 * {@link redactCause} returns a small, log-safe projection of any thrown
 * value. Never returns raw `err` — message is sliced, `.stack` is dropped,
 * cycles are broken via WeakSet, and every property access is try-guarded
 * so a hostile error (Proxy traps, throwing getters, null-prototype
 * objects) cannot re-introduce a silent failure by throwing through the
 * redactor itself.
 */

// ─── Transport error codes ─────────────────────────────────────────────────

/**
 * Provider-denial class names. Errors whose `.name` matches one of these are
 * NEVER classified as transport, even if other signals look transport-shaped.
 * A provider that throws a `TimeoutError` for business reasons (e.g., policy
 * lockout after N failed attempts) shouldn't be mis-classified as a network
 * retry candidate. Extend this denylist when wiring a new custody adapter.
 */
export const PROVIDER_DENIAL_NAMES: ReadonlySet<string> = new Set([
  "ProviderDeniedError",
  "CustodyDeniedError",
  "UnauthorizedError",
  "ForbiddenError",
]);

/**
 * Error codes that indicate a transport-layer failure (network, TLS,
 * HTTP/2, upstream gateway). `.cause.code` is inspected by
 * {@link isTransportError}.
 *
 * Scope:
 *   - Classic POSIX: ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND,
 *     EAI_AGAIN, ENETUNREACH, EPIPE.
 *   - Undici (Node 18/20/22 fetch): UND_ERR_CONNECT_TIMEOUT,
 *     UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_SOCKET,
 *     UND_ERR_ABORTED.
 *   - TLS: CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE,
 *     DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID.
 *   - HTTP/2: ERR_HTTP2_STREAM_ERROR, ERR_HTTP2_SESSION_ERROR,
 *     ERR_HTTP2_GOAWAY_SESSION.
 *   - Sigil custody adapters: HTTP_5XX (set on tagged upstream 5xx errors).
 */
export const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  // POSIX
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
  // Undici
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  // TLS
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  // HTTP/2
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  // Custody adapter tag (set by sdk/custody adapters on 5xx upstream)
  "HTTP_5XX",
]);

/**
 * Undici's causal ConnectTimeoutError class-name signal. Checked separately
 * from `TRANSPORT_CODES` because some undici paths populate `.name` but not
 * `.code` on the cause.
 */
const TRANSPORT_CAUSE_NAMES: ReadonlySet<string> = new Set([
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
]);

// ─── isTransportError ──────────────────────────────────────────────────────

/**
 * `instanceof` that survives hostile proxies. `x instanceof C` internally
 * walks the prototype chain and can invoke `get` traps; a throwing trap
 * would propagate out of the predicate and re-introduce a silent-failure
 * vector. Wrapping the check lets the classifier fall through to `false`
 * instead of crashing.
 */
function safeInstanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
): value is T {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

function safeGetName(value: unknown): string | undefined {
  try {
    if (value && typeof value === "object" && "name" in value) {
      const n = (value as { name: unknown }).name;
      return typeof n === "string" ? n : undefined;
    }
  } catch {
    // Throwing getter / Proxy trap — treat as unnameable.
  }
  return undefined;
}

function safeGetCause(value: unknown): unknown {
  try {
    if (value && typeof value === "object" && "cause" in value) {
      return (value as { cause: unknown }).cause;
    }
  } catch {
    // Throwing getter / Proxy trap.
  }
  return undefined;
}

function safeGetCode(value: unknown): string | undefined {
  try {
    if (value && typeof value === "object" && "code" in value) {
      const c = (value as { code: unknown }).code;
      if (typeof c === "string") return c;
      if (typeof c === "number" || typeof c === "bigint") return String(c);
    }
  } catch {
    // Throwing getter / Proxy trap.
  }
  return undefined;
}

function safeGetStatusCode(value: unknown): number | undefined {
  try {
    if (value && typeof value === "object") {
      for (const key of ["statusCode", "status"] as const) {
        if (key in value) {
          const v = (value as Record<string, unknown>)[key];
          if (typeof v === "number" && Number.isFinite(v)) return v;
        }
      }
    }
  } catch {
    // Throwing getter / Proxy trap.
  }
  return undefined;
}

/**
 * Classify an error as transport-layer (retry-worthy network/TLS/upstream
 * failure) or not. Structural checks only — no message regex.
 *
 * Recognized transport signals (in order of evaluation):
 *   1. `DOMException` with name `AbortError` or `TimeoutError` — undici
 *      surfaces `AbortSignal.timeout()` as DOMException, NOT plain Error.
 *   2. `Error` with name `AbortError` or `TimeoutError` — non-undici runtimes.
 *   3. `err.cause.name` ∈ {ConnectTimeoutError, HeadersTimeoutError,
 *      BodyTimeoutError, SocketError} — undici class names.
 *   4. `err.cause.code` ∈ {@link TRANSPORT_CODES} — POSIX / undici / TLS /
 *      HTTP/2 / HTTP_5XX-tagged codes.
 *   5. `AggregateError` — recurses into `.errors` (Node's Happy Eyeballs
 *      fetch surfaces multi-IP failures this way).
 *   6. `err.statusCode` ≥ 500 — for custody adapters that throw Error
 *      with a numeric `statusCode` on upstream 5xx without setting a cause.
 *   7. `TypeError("fetch failed")` with no cause — Node undici's bare
 *      shape when cause attachment failed.
 *
 * Provider-denial short-circuit: if `err.name` is in
 * {@link PROVIDER_DENIAL_NAMES}, returns false immediately — a provider
 * that throws a `TimeoutError` for business reasons shouldn't be
 * retry-classified.
 *
 * Non-Error inputs (`null`, `undefined`, strings, numbers, plain objects
 * without the expected shape) return false.
 */
export function isTransportError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // Provider denial denylist wins over everything.
  const name = safeGetName(err);
  if (name !== undefined && PROVIDER_DENIAL_NAMES.has(name)) return false;

  // DOMException (undici fetch timeout/abort shape). `safeInstanceOf` is
  // required because a Proxy with a throwing `get` trap would propagate
  // out of a raw `instanceof` check and reintroduce silent failure.
  if (
    typeof DOMException !== "undefined" &&
    safeInstanceOf(err, DOMException)
  ) {
    return name === "AbortError" || name === "TimeoutError";
  }

  // AggregateError — recurse into wrapped errors.
  if (
    typeof AggregateError !== "undefined" &&
    safeInstanceOf(err, AggregateError)
  ) {
    try {
      const wrapped = (err as { errors: unknown[] }).errors;
      if (Array.isArray(wrapped)) return wrapped.some(isTransportError);
    } catch {
      // Throwing getter on .errors — treat as non-transport.
    }
    return false;
  }

  if (!safeInstanceOf(err, Error)) return false;

  // Plain Error with transport-shaped name (non-undici runtimes).
  if (name === "AbortError" || name === "TimeoutError") return true;

  // cause-chain signals — undici typically wraps the real error in `.cause`.
  const cause = safeGetCause(err);
  if (cause !== undefined && cause !== null) {
    const causeName = safeGetName(cause);
    if (causeName !== undefined && TRANSPORT_CAUSE_NAMES.has(causeName)) {
      return true;
    }
    const causeCode = safeGetCode(cause);
    if (causeCode !== undefined && TRANSPORT_CODES.has(causeCode)) {
      return true;
    }
  }

  // Direct `.code` on the error (some legacy undici paths set this on Error,
  // not cause).
  const directCode = safeGetCode(err);
  if (directCode !== undefined && TRANSPORT_CODES.has(directCode)) return true;

  // Upstream HTTP 5xx tagged on the error itself.
  const statusCode = safeGetStatusCode(err);
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // Bare `TypeError("fetch failed")` with no cause — fall-through undici
  // shape when cause attachment failed. Recognized only if nothing else
  // matched.
  if (safeInstanceOf(err, TypeError) && cause === undefined) {
    try {
      const msg = (err as { message: unknown }).message;
      if (typeof msg === "string" && msg === "fetch failed") return true;
    } catch {
      // Throwing getter on message — fall through.
    }
  }

  return false;
}

// ─── redactCause ───────────────────────────────────────────────────────────

/**
 * Soft cap on cause-chain walks. Pure defense-in-depth against a hostile
 * error whose `.cause` getter returns a freshly-allocated wrapper on every
 * access — the WeakSet cycle-detection sees a new object each time and
 * would otherwise loop until the runtime's memory/stack limit. 16 is
 * deeper than any realistic middleware error-wrapper chain (4–6 is
 * typical for serverless + framework + SDK combinations).
 */
const MAX_CAUSE_WALK_DEPTH = 16;

/**
 * Safe, log-friendly projection of an error's identifying fields.
 *
 * Returned shape:
 *   - `name?` — string, from `err.name`, if accessible and a string.
 *   - `message?` — string, from `err.message`, sliced to at most 200
 *     chars. If `.message` is present but not a string (Symbol, BigInt,
 *     object), returns `"<non-string <typeof>>"` so the diagnostic
 *     distinguishes "we couldn't read" from "there was no message." This
 *     matters at every consumer site that does
 *     `cause.message ?? cause.name ?? cause.code ?? "unknown"` — without
 *     the non-string projection, `"unknown"` collapses across real gaps
 *     and hostile shapes.
 *   - `code?` — string, from `err.code` OR `err.cause.code` (walked),
 *     coerced from number/bigint if needed.
 *
 * Guarantees:
 *   - Never throws. Every property access is `try`-guarded. A hostile
 *     error with a throwing getter, Proxy `get` trap, or null-prototype
 *     object yields `{}` rather than re-introducing a silent failure.
 *   - Never reads `.stack` (may embed API keys, auth headers, or request
 *     bodies from upstream SDK wrappers).
 *   - Cycles in the cause chain are broken via {@link WeakSet}, and a
 *     soft depth cap of {@link MAX_CAUSE_WALK_DEPTH} protects against
 *     hostile causes that allocate a fresh wrapper per access (identity-
 *     based cycle detection alone cannot catch that pattern).
 *   - Non-Error inputs (null, undefined, string, number, Symbol, BigInt,
 *     Proxy, null-prototype) return a sensible projection or `{}`.
 */
export function redactCause(err: unknown): {
  name?: string;
  message?: string;
  code?: string;
} {
  // Handle primitives up-front.
  if (err === null || err === undefined) return {};
  if (typeof err === "string") {
    return { message: err.slice(0, 200) };
  }
  if (typeof err === "number" || typeof err === "bigint") {
    return { code: String(err) };
  }
  if (typeof err !== "object") return {};

  const out: { name?: string; message?: string; code?: string } = {};

  const name = safeGetName(err);
  if (name !== undefined) out.name = name;

  try {
    if ("message" in err) {
      const m = (err as { message: unknown }).message;
      if (typeof m === "string") {
        out.message = m.slice(0, 200);
      } else if (m !== undefined && m !== null) {
        // Present but non-string — preserve the distinguishability
        // signal at consumer sites (see doc-comment rationale).
        out.message = `<non-string ${typeof m}>`;
      }
    }
  } catch {
    // Throwing getter / Proxy trap — skip.
  }

  const directCode = safeGetCode(err);
  if (directCode !== undefined) {
    out.code = directCode;
  } else {
    // Walk the cause chain for a code, breaking cycles via WeakSet AND
    // capping depth so a hostile getter that allocates fresh objects on
    // every access can't drive the loop into a memory wall.
    const visited = new WeakSet<object>();
    let current: unknown = err;
    for (let depth = 0; depth < MAX_CAUSE_WALK_DEPTH; depth++) {
      if (current === null || current === undefined) break;
      if (typeof current !== "object") break;
      if (visited.has(current as object)) break;
      visited.add(current as object);

      const nextCause = safeGetCause(current);
      if (nextCause === undefined || nextCause === null) break;
      const causeCode = safeGetCode(nextCause);
      if (causeCode !== undefined) {
        out.code = causeCode;
        break;
      }
      current = nextCause;
    }
  }

  return out;
}
