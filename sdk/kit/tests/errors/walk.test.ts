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

      const found = walkSigilCause(top, (e: unknown) => (e as Error).message === "root");
      expect(found).to.equal(root);
    });

    it("returns the predicate match at the top level (no descent needed)", () => {
      const top = new Error("top");
      const found = walkSigilCause(top, (e: unknown) => (e as Error).message === "top");
      expect(found).to.equal(top);
    });

    it("returns null when no error matches", () => {
      const top = new Error("top");
      const cause = new Error("middle");
      Object.defineProperty(top, "cause", { value: cause });
      const found = walkSigilCause(top, () => false);
      expect(found).to.equal(null);
    });

    it("returns null for non-Error input", () => {
      expect(walkSigilCause("not an error", () => true)).to.equal(null);
      expect(walkSigilCause(42, () => true)).to.equal(null);
      expect(walkSigilCause(null, () => true)).to.equal(null);
      expect(walkSigilCause(undefined, () => true)).to.equal(null);
    });

    it("breaks cyclic chains via the visited set (does not infinite-loop)", () => {
      const a = new Error("a");
      const b = new Error("b");
      Object.defineProperty(a, "cause", { value: b });
      Object.defineProperty(b, "cause", { value: a }); // cycle a -> b -> a

      // Should terminate (not stack-overflow) and return null since neither
      // matches a predicate that requires a third error.
      const result = walkSigilCause(a, (e: unknown) => (e as Error).message === "c");
      expect(result).to.equal(null);
    });

    it("handles self-referential cause (err.cause = err)", () => {
      const self = new Error("self");
      Object.defineProperty(self, "cause", { value: self });
      const found = walkSigilCause(self, (e: unknown) => (e as Error).message === "self");
      expect(found).to.equal(self);
    });

    it("breaks at max-depth (10 levels) to bound runtime on deep chains", () => {
      // Build a chain of 30 errors to confirm max-depth fuse stops at 10.
      let prev = new Error("level-0");
      for (let i = 1; i < 30; i++) {
        const e = new Error(`level-${i}`);
        Object.defineProperty(e, "cause", { value: prev });
        prev = e;
      }
      const top = prev;

      // The level-25 error is past the max-depth fuse from the top.
      const past = walkSigilCause(top, (e: unknown) => (e as Error).message === "level-15");
      expect(past).to.equal(null);

      // The level-25 (close to top) IS reachable.
      const reachable = walkSigilCause(
        top,
        (e: unknown) => (e as Error).message === "level-25",
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
        (e: unknown) => e instanceof SigilError && e.code === SIGIL_ERROR__RPC__TX_FAILED,
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
