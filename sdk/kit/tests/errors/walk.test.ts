/**
 * walk() — cause-chain traversal with cycle protection.
 *
 * Covers: predicate-match, root-finding, cyclic chains (max-depth fuse),
 * non-Error causes, and the SigilError.walk() instance method.
 */

import { expect } from "chai";
import {
  SigilError,
  walk as walkSigilCause,
  SIGIL_ERROR__SDK__UNKNOWN,
  SIGIL_ERROR__RPC__TX_FAILED,
} from "../../src/errors/index.js";

describe("walk() — cause-chain traversal", () => {
  describe("predicate variant", () => {
    it("returns the first error matching the predicate", () => {
      const root = new Error("root");
      const middle = new Error("middle");
      Object.defineProperty(middle, "cause", { value: root });
      const top = new Error("top");
      Object.defineProperty(top, "cause", { value: middle });

      const found = walkSigilCause(
        top,
        (e: unknown) => (e as Error).message === "root",
      );
      expect(found).to.equal(root);
    });

    it("returns the predicate match at the top level (no descent needed)", () => {
      const top = new Error("top");
      const found = walkSigilCause(
        top,
        (e: unknown) => (e as Error).message === "top",
      );
      expect(found).to.equal(top);
    });

    it("returns null when no error matches", () => {
      const top = new Error("top");
      const cause = new Error("middle");
      Object.defineProperty(top, "cause", { value: cause });
      const found = walkSigilCause(top, () => false);
      expect(found).to.equal(null);
    });

    it("tests non-Error inputs against the predicate (Finding 1 fix)", () => {
      // PR 2.A C1 fix: predicate variant now applies fn to non-Error causes
      // (e.g., undici's `cause: { code: "ECONNRESET" }` shape) instead of
      // silently dropping them. When matched, the result is wrapped in Error.
      const matchedString = walkSigilCause(
        "not an error",
        (e: unknown) => e === "not an error",
      );
      expect(matchedString).to.be.instanceOf(Error);
      expect(matchedString?.message).to.equal("not an error");

      // When the predicate doesn't match the non-Error value, returns null.
      expect(walkSigilCause("foo", (e: unknown) => e === "bar")).to.equal(null);
      expect(walkSigilCause(42, (e: unknown) => e === "no match")).to.equal(
        null,
      );
      expect(walkSigilCause(null, (e: unknown) => e === "no match")).to.equal(
        null,
      );
      expect(
        walkSigilCause(undefined, (e: unknown) => e === "no match"),
      ).to.equal(null);
    });

    it("walks into non-Error cause objects (undici cause shape)", () => {
      // Real-world pattern: undici's fetch throws `TypeError("fetch failed")`
      // with `cause: { code: "ECONNRESET" }` (a plain object, not Error).
      // The predicate must be able to find the .code on the non-Error cause.
      const fetchErr = new Error("fetch failed");
      Object.defineProperty(fetchErr, "cause", {
        value: { code: "ECONNRESET" },
      });
      const found = walkSigilCause(
        fetchErr,
        (e: unknown) =>
          typeof e === "object" &&
          e !== null &&
          "code" in e &&
          (e as { code: unknown }).code === "ECONNRESET",
      );
      expect(found).to.not.equal(null);
    });

    it("breaks cyclic chains via the visited set (does not infinite-loop)", () => {
      const a = new Error("a");
      const b = new Error("b");
      Object.defineProperty(a, "cause", { value: b });
      Object.defineProperty(b, "cause", { value: a }); // cycle a -> b -> a

      // Should terminate (not stack-overflow) and return null since neither
      // matches a predicate that requires a third error.
      const result = walkSigilCause(
        a,
        (e: unknown) => (e as Error).message === "c",
      );
      expect(result).to.equal(null);
    });

    it("handles self-referential cause (err.cause = err)", () => {
      const self = new Error("self");
      Object.defineProperty(self, "cause", { value: self });
      const found = walkSigilCause(
        self,
        (e: unknown) => (e as Error).message === "self",
      );
      expect(found).to.equal(self);
    });

    it("breaks at max-depth (32 levels) to bound runtime on deep chains", () => {
      // Build a chain of 50 errors to confirm max-depth fuse stops at 32.
      // PR 2.A: depth raised from 10 → 32 per silent-failure-hunter Finding 1
      // (real chains routinely exceed 10 with SDK + Solana + Anchor + custody).
      let prev = new Error("level-0");
      for (let i = 1; i < 50; i++) {
        const e = new Error(`level-${i}`);
        Object.defineProperty(e, "cause", { value: prev });
        prev = e;
      }
      const top = prev;

      // The level-10 error is past the max-depth fuse (>32 from the top).
      const past = walkSigilCause(
        top,
        (e: unknown) => (e as Error).message === "level-10",
      );
      expect(past).to.equal(null);

      // The level-30 (close to top, depth ≤ 32) IS reachable.
      const reachable = walkSigilCause(
        top,
        (e: unknown) => (e as Error).message === "level-30",
      );
      expect(reachable).to.not.equal(null);
    });
  });

  describe("no-arg variant (root finder)", () => {
    it("returns the root cause when called without a predicate", () => {
      const root = new Error("root");
      const middle = new Error("middle");
      Object.defineProperty(middle, "cause", { value: root });
      const top = new Error("top");
      Object.defineProperty(top, "cause", { value: middle });

      const found = walkSigilCause(top);
      expect(found).to.equal(root);
    });

    it("returns the input when there is no cause", () => {
      const lone = new Error("alone");
      expect(walkSigilCause(lone)).to.equal(lone);
    });

    it("wraps non-Error input as Error", () => {
      const result = walkSigilCause("string cause");
      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.equal("string cause");
    });

    it("breaks cyclic chains (max-depth fuse)", () => {
      const a = new Error("a");
      const b = new Error("b");
      Object.defineProperty(a, "cause", { value: b });
      Object.defineProperty(b, "cause", { value: a });
      // Should terminate, not infinite-recurse. The exact return is one of a/b
      // depending on which is hit first by the visited check.
      const result = walkSigilCause(a);
      expect([a, b]).to.include(result);
    });
  });

  describe("SigilError.walk() instance method", () => {
    it("delegates to walkSigilCause for predicate variant", () => {
      const inner = new SigilError(SIGIL_ERROR__RPC__TX_FAILED, "rpc broke");
      const wrapper = new SigilError(SIGIL_ERROR__SDK__UNKNOWN, "wrap", {
        cause: inner,
      });

      const found = wrapper.walk(
        (e: unknown) =>
          e instanceof SigilError && e.code === SIGIL_ERROR__RPC__TX_FAILED,
      );
      expect(found).to.equal(inner);
    });

    it("delegates to walkSigilCause for root-finder variant", () => {
      const inner = new SigilError(SIGIL_ERROR__RPC__TX_FAILED, "rpc broke");
      const wrapper = new SigilError(SIGIL_ERROR__SDK__UNKNOWN, "wrap", {
        cause: inner,
      });

      // No-arg walk returns the deepest cause.
      const root = wrapper.walk();
      expect(root).to.equal(inner);
    });
  });
});
