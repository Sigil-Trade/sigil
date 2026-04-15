/**
 * Structural transport-error classifier + redactCause tests.
 *
 * Covers three surfaces:
 *
 *   1. {@link isTransportError} correctly classifies undici, POSIX, TLS,
 *      HTTP/2, AggregateError, and DOMException shapes Node 18/20/22
 *      produce from `fetch()` failures, while rejecting provider-denial
 *      classes and logic errors.
 *   2. {@link redactCause} returns a safe, log-friendly projection under
 *      adversarial inputs (Proxy traps, throwing getters, null-prototype,
 *      BigInt/Symbol causes, cyclic cause chains).
 *   3. The provider-denial denylist has precedence over transport-shaped
 *      signals — a `ProviderDeniedError` thrown with a transport-shaped
 *      cause is NOT classified as transport.
 */

import { expect } from "chai";
import { isTransportError, redactCause } from "../src/network-errors.js";

// Helper: build an Error with a cause (ES2022 ErrorOptions) without the
// type-system fighting us on every line. Returns a plain `Error`; tests
// that need a specific subclass construct it directly.
function errWithCause(message: string, cause: unknown, name?: string): Error {
  const e = new Error(message, { cause });
  if (name) e.name = name;
  return e;
}

function typeErrWithCause(message: string, cause: unknown): TypeError {
  return new TypeError(message, { cause });
}

// ─── isTransportError ───────────────────────────────────────────────────────

describe("isTransportError — structural transport classifier", () => {
  describe("undici fetch shapes", () => {
    it("TypeError('fetch failed') with ECONNREFUSED cause → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", { code: "ECONNREFUSED" }),
        ),
      ).to.equal(true);
    });

    it("TypeError('fetch failed') with UND_ERR_CONNECT_TIMEOUT cause → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", {
            name: "ConnectTimeoutError",
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        ),
      ).to.equal(true);
    });

    it("TypeError('fetch failed') with no cause → transport (bare fallback)", () => {
      expect(isTransportError(new TypeError("fetch failed"))).to.equal(true);
    });

    it("TypeError('fetch failed') with UND_ERR_HEADERS_TIMEOUT cause → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", {
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        ),
      ).to.equal(true);
    });

    it("TypeError('fetch failed') with UND_ERR_BODY_TIMEOUT cause → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", { code: "UND_ERR_BODY_TIMEOUT" }),
        ),
      ).to.equal(true);
    });

    it("TypeError('fetch failed') with UND_ERR_SOCKET cause → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", { code: "UND_ERR_SOCKET" }),
        ),
      ).to.equal(true);
    });
  });

  describe("POSIX error codes", () => {
    it("cause.code = ECONNRESET → transport", () => {
      expect(
        isTransportError(errWithCause("socket reset", { code: "ECONNRESET" })),
      ).to.equal(true);
    });

    it("cause.code = ENOTFOUND (DNS) → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", {
            code: "ENOTFOUND",
            syscall: "getaddrinfo",
          }),
        ),
      ).to.equal(true);
    });

    it("cause.code = ETIMEDOUT → transport", () => {
      expect(
        isTransportError(errWithCause("timed out", { code: "ETIMEDOUT" })),
      ).to.equal(true);
    });
  });

  describe("TLS errors", () => {
    it("cause.code = CERT_HAS_EXPIRED → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", { code: "CERT_HAS_EXPIRED" }),
        ),
      ).to.equal(true);
    });

    it("cause.code = UNABLE_TO_VERIFY_LEAF_SIGNATURE → transport", () => {
      expect(
        isTransportError(
          typeErrWithCause("fetch failed", {
            code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          }),
        ),
      ).to.equal(true);
    });
  });

  describe("HTTP/2 errors", () => {
    it("cause.code = ERR_HTTP2_STREAM_ERROR → transport", () => {
      expect(
        isTransportError(
          errWithCause("h2 stream reset", { code: "ERR_HTTP2_STREAM_ERROR" }),
        ),
      ).to.equal(true);
    });
  });

  describe("AbortError / TimeoutError shapes", () => {
    it("plain Error with name AbortError → transport", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      expect(isTransportError(err)).to.equal(true);
    });

    it("plain Error with name TimeoutError → transport", () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      expect(isTransportError(err)).to.equal(true);
    });

    it("DOMException with name AbortError → transport (AbortSignal.abort)", () => {
      const err = new DOMException("aborted", "AbortError");
      expect(isTransportError(err)).to.equal(true);
    });

    it("DOMException with name TimeoutError → transport (AbortSignal.timeout)", () => {
      const err = new DOMException("timed out", "TimeoutError");
      expect(isTransportError(err)).to.equal(true);
    });
  });

  describe("AggregateError (Happy Eyeballs)", () => {
    it("AggregateError wrapping ECONNREFUSED → transport via recursion", () => {
      const inner = errWithCause("connect failed", { code: "ECONNREFUSED" });
      const agg = new globalThis.AggregateError([inner], "all IPs failed");
      expect(isTransportError(agg)).to.equal(true);
    });

    it("AggregateError wrapping only logic errors → NOT transport", () => {
      const inner = new Error("logic bug");
      const agg = new globalThis.AggregateError([inner], "all failed");
      expect(isTransportError(agg)).to.equal(false);
    });
  });

  describe("HTTP 5xx status-code tag", () => {
    it("Error with statusCode 502 → transport", () => {
      const err = new Error("Crossmint get wallet failed (502): Bad Gateway");
      Object.assign(err, { statusCode: 502 });
      expect(isTransportError(err)).to.equal(true);
    });

    it("Error with status 503 → transport (alternate property name)", () => {
      const err = new Error("upstream unavailable");
      Object.assign(err, { status: 503 });
      expect(isTransportError(err)).to.equal(true);
    });

    it("Error with statusCode 400 → NOT transport (client error)", () => {
      const err = new Error("bad request");
      Object.assign(err, { statusCode: 400 });
      expect(isTransportError(err)).to.equal(false);
    });
  });

  describe("HTTP_5XX tagged cause (for future custody-adapter updates)", () => {
    it("cause.code = HTTP_5XX → transport", () => {
      expect(
        isTransportError(
          errWithCause("adapter tag", {
            code: "HTTP_5XX",
            statusCode: 502,
          }),
        ),
      ).to.equal(true);
    });
  });

  describe("provider-denial denylist (precedence)", () => {
    it("ProviderDeniedError with transport-shaped cause → NOT transport", () => {
      // Denylist must win — a provider denying a request for business
      // reasons shouldn't be retry-classified even if the thrown error
      // happens to have a transport-looking cause.
      expect(
        isTransportError(
          errWithCause(
            "denied",
            { code: "ECONNREFUSED" },
            "ProviderDeniedError",
          ),
        ),
      ).to.equal(false);
    });

    it("CustodyDeniedError → NOT transport", () => {
      const err = new Error("custody denied");
      err.name = "CustodyDeniedError";
      expect(isTransportError(err)).to.equal(false);
    });
  });

  describe("non-transport shapes", () => {
    it("plain Error('something broke') → NOT transport", () => {
      expect(isTransportError(new Error("something broke"))).to.equal(false);
    });

    it("null → NOT transport", () => {
      expect(isTransportError(null)).to.equal(false);
    });

    it("undefined → NOT transport", () => {
      expect(isTransportError(undefined)).to.equal(false);
    });

    it("empty object → NOT transport", () => {
      expect(isTransportError({})).to.equal(false);
    });

    it("string → NOT transport", () => {
      expect(isTransportError("ECONNREFUSED")).to.equal(false);
    });
  });

  describe("hostile error shapes (must not throw)", () => {
    it("Proxy with throwing get trap → does not throw", () => {
      const proxied = new Proxy(new Error("test"), {
        get() {
          throw new Error("proxy trap");
        },
      });
      expect(() => isTransportError(proxied)).to.not.throw();
    });

    it("Error with throwing getter on name → does not throw", () => {
      const err = new Error("test");
      Object.defineProperty(err, "name", {
        get() {
          throw new Error("pwn");
        },
      });
      expect(() => isTransportError(err)).to.not.throw();
    });

    it("Error with throwing getter on cause → does not throw", () => {
      const err = new Error("test");
      Object.defineProperty(err, "cause", {
        get() {
          throw new Error("pwn");
        },
      });
      expect(() => isTransportError(err)).to.not.throw();
    });
  });
});

// ─── redactCause ────────────────────────────────────────────────────────────

describe("redactCause — safe error projection", () => {
  it("extracts name + message from a plain Error", () => {
    const err = new Error("something happened");
    err.name = "CustomError";
    const r = redactCause(err);
    expect(r.name).to.equal("CustomError");
    expect(r.message).to.equal("something happened");
  });

  it("truncates message to 200 chars", () => {
    const long = "x".repeat(500);
    const r = redactCause(new Error(long));
    expect(r.message).to.exist;
    expect(r.message!.length).to.equal(200);
  });

  it("extracts code from direct Error.code property", () => {
    const err = new Error("test");
    Object.assign(err, { code: "ECONNREFUSED" });
    const r = redactCause(err);
    expect(r.code).to.equal("ECONNREFUSED");
  });

  it("walks cause chain for code when not on top-level", () => {
    const err = typeErrWithCause("fetch failed", { code: "ENOTFOUND" });
    const r = redactCause(err);
    expect(r.code).to.equal("ENOTFOUND");
  });

  it("coerces numeric code to string", () => {
    const err = new Error("test");
    Object.assign(err, { code: 502 });
    const r = redactCause(err);
    expect(r.code).to.equal("502");
  });

  it("does NOT read .stack (redaction invariant)", () => {
    const err = new Error("test");
    err.stack =
      "Error: test\n  at https://user:PASSWORD@example.com/api?token=SECRET";
    const r = redactCause(err);
    expect(r).to.not.have.property("stack");
    expect(JSON.stringify(r)).to.not.include("PASSWORD");
    expect(JSON.stringify(r)).to.not.include("SECRET");
  });

  describe("hostile inputs (must not throw, return sensible projection)", () => {
    it("null → {}", () => {
      expect(redactCause(null)).to.deep.equal({});
    });

    it("undefined → {}", () => {
      expect(redactCause(undefined)).to.deep.equal({});
    });

    it("string → { message }", () => {
      expect(redactCause("hello")).to.deep.equal({ message: "hello" });
    });

    it("number → { code }", () => {
      expect(redactCause(42)).to.deep.equal({ code: "42" });
    });

    it("BigInt → { code }", () => {
      expect(redactCause(9007199254740993n)).to.deep.equal({
        code: "9007199254740993",
      });
    });

    it("Error with throwing getter on message → does not throw", () => {
      const err = new Error("ok");
      Object.defineProperty(err, "message", {
        get() {
          throw new Error("pwn");
        },
      });
      expect(() => redactCause(err)).to.not.throw();
    });

    it("Proxy with throwing get trap → does not throw", () => {
      const proxied = new Proxy(new Error("test"), {
        get() {
          throw new Error("proxy trap");
        },
      });
      expect(() => redactCause(proxied)).to.not.throw();
    });

    it("null-prototype object with code field", () => {
      const obj = Object.create(null);
      obj.name = "NullProto";
      obj.code = "CUSTOM";
      const r = redactCause(obj);
      expect(r.name).to.equal("NullProto");
      expect(r.code).to.equal("CUSTOM");
    });

    it("cyclic cause chain — breaks cycle via WeakSet, does not stack-overflow", () => {
      const a = new Error("a");
      const b = new Error("b");
      Object.assign(a, { cause: b });
      Object.assign(b, { cause: a });
      expect(() => redactCause(a)).to.not.throw();
    });

    it("self-cyclic (err.cause === err) — does not stack-overflow", () => {
      const err = new Error("self");
      Object.assign(err, { cause: err });
      expect(() => redactCause(err)).to.not.throw();
    });

    it("deep linear chain (depth > 3) still finds code without artificial cap", () => {
      // Unlike a fixed depth-3 cutoff, the WeakSet-only strategy walks
      // until it finds a code or runs out of chain — deeply nested
      // middleware wrappers retain diagnostic value.
      const deepest = new Error("root");
      Object.assign(deepest, { code: "ROOT_CODE" });
      let current: Error = deepest;
      for (let i = 0; i < 7; i++) {
        const wrapper = new Error(`wrap ${i}`);
        Object.assign(wrapper, { cause: current });
        current = wrapper;
      }
      const r = redactCause(current);
      expect(r.code).to.equal("ROOT_CODE");
    });
  });
});
