/**
 * Branded Types — compile-time safety + runtime validation tests.
 *
 * These tests verify that the branded bigint types (UsdBaseUnits,
 * CapabilityTier, Slot) work correctly at runtime and that their
 * constructor functions enforce invariants.
 */

import { expect } from "chai";
import { usd, capability, slot, FULL_CAPABILITY } from "../src/types.js";
import type { UsdBaseUnits, CapabilityTier, Slot } from "../src/types.js";

describe("Branded Types", () => {
  describe("usd()", () => {
    it("wraps a bigint as UsdBaseUnits", () => {
      const amount: UsdBaseUnits = usd(500_000_000n);
      expect(amount).to.equal(500_000_000n);
    });

    it("preserves zero", () => {
      const zero: UsdBaseUnits = usd(0n);
      expect(zero).to.equal(0n);
    });

    it("preserves large values", () => {
      const large: UsdBaseUnits = usd(1_000_000_000_000n); // $1M
      expect(large).to.equal(1_000_000_000_000n);
    });

    it("supports arithmetic on branded values", () => {
      const a = usd(100_000_000n);
      const b = usd(200_000_000n);
      // Arithmetic results in plain bigint (brand is lost) — this is expected.
      // Consumers re-wrap with usd() if they need the brand back.
      expect(a + b).to.equal(300_000_000n);
    });
  });

  describe("capability()", () => {
    it("wraps 0n as Disabled", () => {
      const tier: CapabilityTier = capability(0n);
      expect(tier).to.equal(0n);
    });

    it("wraps 1n as Observer", () => {
      const tier: CapabilityTier = capability(1n);
      expect(tier).to.equal(1n);
    });

    it("wraps 2n as Operator", () => {
      const tier: CapabilityTier = capability(2n);
      expect(tier).to.equal(2n);
    });

    it("FULL_CAPABILITY equals capability(2n)", () => {
      expect(FULL_CAPABILITY).to.equal(capability(2n));
    });
  });

  describe("slot()", () => {
    it("wraps a bigint as Slot", () => {
      const s: Slot = slot(12345n);
      expect(s).to.equal(12345n);
    });

    it("preserves zero", () => {
      const s: Slot = slot(0n);
      expect(s).to.equal(0n);
    });
  });

  describe("type safety", () => {
    it("branded values pass typeof bigint check", () => {
      const amount = usd(100n);
      const tier = capability(2n);
      const s = slot(42n);
      expect(typeof amount).to.equal("bigint");
      expect(typeof tier).to.equal("bigint");
      expect(typeof s).to.equal("bigint");
    });

    it("branded values work with BigInt comparisons", () => {
      const a = usd(100n);
      const b = usd(200n);
      expect(a < b).to.be.true;
      expect(b > a).to.be.true;
      expect(a === usd(100n)).to.be.true;
    });
  });
});
