import { expect } from "chai";
import type { Address } from "@solana/kit";
import { VelocityTracker, type VelocityConfig } from "../src/velocity-tracker.js";
import { ShieldState, ShieldDeniedError } from "../src/shield.js";

const SIGNER = "11111111111111111111111111111111" as Address;

function makeTracker(config?: VelocityConfig): VelocityTracker {
  const state = new ShieldState();
  return new VelocityTracker(state, config);
}

describe("VelocityTracker", () => {
  describe("TX/minute limit", () => {
    it("allows transactions within limit", () => {
      const tracker = makeTracker({ maxTxPerMinute: 5 });
      // First check is fine
      expect(() => tracker.check(SIGNER)).to.not.throw();
    });

    it("blocks when TX/minute exceeded", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxTxPerMinute: 3 });
      // Record 3 transactions in state
      for (let i = 0; i < 3; i++) {
        state.recordTransaction();
      }
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });
  });

  describe("TX/hour limit", () => {
    it("blocks when TX/hour exceeded", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxTxPerHour: 5 });
      for (let i = 0; i < 5; i++) {
        state.recordTransaction();
      }
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });
  });

  describe("USD/hour limit", () => {
    it("blocks when USD/hour exceeded", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxUsdPerHour: 100_000n });
      // Record $200 spend
      state.recordSpend("", 200_000n);
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });

    it("allows when within USD/hour limit", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxUsdPerHour: 500_000_000n });
      state.recordSpend("", 100_000n);
      expect(() => tracker.check(SIGNER)).to.not.throw();
    });
  });

  describe("rapid-fire detection", () => {
    it("detects rapid-fire transactions", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        rapidFireThreshold: { count: 3, windowMs: 60_000 },
        // Set high limits so TX/min and TX/hr don't trigger first
        maxTxPerMinute: 100,
        maxTxPerHour: 1000,
      });
      // Each check adds a timestamp to the internal tracker
      tracker.check(SIGNER);
      tracker.check(SIGNER);
      // Third check should trigger rapid-fire (3 within 60s window)
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });
  });

  describe("cooldown", () => {
    it("enters cooldown after velocity breach", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        maxTxPerMinute: 1,
        cooldownMs: 5_000,
      });
      state.recordTransaction();
      try {
        tracker.check(SIGNER);
      } catch {
        // Expected
      }
      expect(tracker.isInCooldown()).to.equal(true);
      expect(tracker.getCooldownRemainingMs()).to.be.greaterThan(0);
    });

    it("blocks during cooldown period", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        maxTxPerMinute: 1,
        cooldownMs: 60_000,
      });
      state.recordTransaction();
      try {
        tracker.check(SIGNER);
      } catch {
        // Expected — triggers cooldown
      }
      // Second check should throw cooldown error
      expect(() => tracker.check(SIGNER)).to.throw("cooldown");
    });

    it("returns 0 remaining when not in cooldown", () => {
      const tracker = makeTracker();
      expect(tracker.getCooldownRemainingMs()).to.equal(0);
    });
  });

  describe("recordTransaction", () => {
    it("records transaction in ShieldState", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      tracker.recordTransaction(100_000n);
      expect(state.getTransactionCountInWindow(60_000)).to.equal(1);
    });

    it("records without USD amount", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      tracker.recordTransaction();
      expect(state.getTransactionCountInWindow(60_000)).to.equal(1);
    });
  });

  describe("reset", () => {
    it("clears cooldown and timestamps", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        maxTxPerMinute: 1,
        cooldownMs: 60_000,
      });
      state.recordTransaction();
      try {
        tracker.check(SIGNER);
      } catch {
        // Expected
      }
      expect(tracker.isInCooldown()).to.equal(true);
      tracker.reset();
      expect(tracker.isInCooldown()).to.equal(false);
      expect(tracker.getCooldownRemainingMs()).to.equal(0);
    });
  });

  describe("getStats", () => {
    it("returns current velocity stats", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      state.recordTransaction();
      state.recordSpend("", 50_000n);
      const stats = tracker.getStats();
      expect(stats.txPerMinute).to.equal(1);
      expect(stats.txPerHour).to.equal(1);
      expect(stats.usdPerHour).to.equal(50_000n);
      expect(stats.inCooldown).to.equal(false);
      expect(stats.cooldownRemainingMs).to.equal(0);
    });
  });

  describe("cross-mint aggregation (BUG-3)", () => {
    it("USD/hour sees DeFi spend with mint 'USDC' + x402 spend with mint 'USDT'", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxUsdPerHour: 500_000n });
      // DeFi records with actual mint key
      state.recordSpend("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 300_000n);
      // x402 records with a different mint key
      state.recordSpend("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 250_000n);
      // Total = 550_000 > 500_000 limit
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });

    it("getStats returns aggregated USD/hour across mints", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      state.recordSpend("USDC", 100_000n);
      state.recordSpend("USDT", 200_000n);
      const stats = tracker.getStats();
      expect(stats.usdPerHour).to.equal(300_000n);
    });
  });

  describe("default config", () => {
    it("uses sane defaults", () => {
      const tracker = makeTracker();
      // Should not throw with default config and no prior state
      expect(() => tracker.check(SIGNER)).to.not.throw();
    });
  });

  describe("violation messages", () => {
    it("includes violation details in ShieldDeniedError", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, { maxTxPerMinute: 2 });
      state.recordTransaction();
      state.recordTransaction();
      try {
        tracker.check(SIGNER);
        expect.fail("should throw");
      } catch (err) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        const denied = err as ShieldDeniedError;
        expect(denied.violations.length).to.be.greaterThan(0);
        expect(denied.violations[0].rule).to.include("velocity");
      }
    });
  });
});
