import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  VelocityTracker,
  type VelocityConfig,
} from "../src/velocity-tracker.js";
import { ShieldState, ShieldDeniedError } from "../src/shield.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";

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
      const tracker = new VelocityTracker(state, {
        maxUsdPerHour: 500_000_000n,
      });
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
      state.recordSpend(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        300_000n,
      );
      // x402 records with a different mint key
      state.recordSpend(
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        250_000n,
      );
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

  describe("S-6: dryRun mode", () => {
    it("dryRun=true doesn't increment rapid-fire counter", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        rapidFireThreshold: { count: 5, windowMs: 60_000 },
        maxTxPerMinute: 100,
        maxTxPerHour: 1000,
      });
      // 5 dry checks — none should increment the counter
      for (let i = 0; i < 5; i++) {
        tracker.check(SIGNER, true);
      }
      // Real check should still pass (counter was not polluted)
      expect(() => tracker.check(SIGNER)).to.not.throw();
    });

    it("dryRun=false (default) increments counter", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        rapidFireThreshold: { count: 3, windowMs: 60_000 },
        maxTxPerMinute: 100,
        maxTxPerHour: 1000,
      });
      tracker.check(SIGNER);
      tracker.check(SIGNER);
      // Third should trigger rapid-fire (3 within window)
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });

    it("dry runs don't prevent real violations", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state, {
        rapidFireThreshold: { count: 4, windowMs: 60_000 },
        maxTxPerMinute: 100,
        maxTxPerHour: 1000,
      });
      // 3 real checks (dry in between doesn't count)
      tracker.check(SIGNER); // real #1, timestamps=[1]
      tracker.check(SIGNER); // real #2, timestamps=[1,2]
      tracker.check(SIGNER, true); // dry — not pushed, timestamps=[1,2]
      tracker.check(SIGNER); // real #3, timestamps=[1,2,3]
      // real #4: wouldBeCount = 3 + 1 = 4 >= count(4) → rapid-fire
      expect(() => tracker.check(SIGNER)).to.throw(ShieldDeniedError);
    });
  });

  describe("hybrid sync", () => {
    function mockResolvedState(
      overrides: Partial<ResolvedVaultState> = {},
    ): ResolvedVaultState {
      return {
        vault: {} as any,
        policy: {} as any,
        tracker: null,
        overlay: null,
        constraints: null,
        globalBudget: {
          spent24h: 0n,
          cap: 1_000_000_000n,
          remaining: 1_000_000_000n,
        },
        agentBudget: null,
        allAgentBudgets: new Map(),
        protocolBudgets: [],
        maxTransactionUsd: 500_000_000n,
        stablecoinBalances: { usdc: 0n, usdt: 0n },
        resolvedAtTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        ...overrides,
      };
    }

    it("getSpendStatus without sync returns client-side source", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      const status = tracker.getSpendStatus();
      expect(status.source).to.equal("client-side");
      expect(status.globalCap).to.be.null;
      expect(status.globalRemaining).to.be.null;
    });

    it("getSpendStatus with synced state returns on-chain source", () => {
      const state = new ShieldState();
      state.syncFromOnChain(
        mockResolvedState({
          globalBudget: { spent24h: 200n, cap: 1000n, remaining: 800n },
        }),
      );
      const tracker = new VelocityTracker(state);
      const status = tracker.getSpendStatus();
      expect(status.source).to.equal("on-chain");
      expect(status.globalSpent24h).to.equal(200n);
      expect(status.globalCap).to.equal(1000n);
    });

    it("getSpendStatus reflects local additions on top of baseline", () => {
      const state = new ShieldState();
      state.syncFromOnChain(
        mockResolvedState({
          globalBudget: { spent24h: 100n, cap: 1000n, remaining: 900n },
        }),
      );
      state.recordUsdSpend(50n);
      const tracker = new VelocityTracker(state);
      const status = tracker.getSpendStatus();
      expect(status.globalSpent24h).to.equal(150n);
    });

    it("getSpendStatus with agent budget returns agent fields", () => {
      const state = new ShieldState();
      state.syncFromOnChain(
        mockResolvedState({
          agentBudget: { spent24h: 300n, cap: 500n, remaining: 200n },
        }),
      );
      const tracker = new VelocityTracker(state);
      const status = tracker.getSpendStatus();
      expect(status.agentSpent24h).to.equal(300n);
      expect(status.agentCap).to.equal(500n);
    });

    it("check() with on-chain cap reached triggers violation", () => {
      const state = new ShieldState();
      state.syncFromOnChain(
        mockResolvedState({
          globalBudget: { spent24h: 1000n, cap: 1000n, remaining: 0n },
        }),
      );
      const tracker = new VelocityTracker(state, {
        maxTxPerMinute: 100,
        maxTxPerHour: 1000,
        maxUsdPerHour: 999_999_999n,
      });
      try {
        tracker.check(SIGNER);
        expect.fail("should throw");
      } catch (err) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        const denied = err as ShieldDeniedError;
        expect(
          denied.violations.some((v) => v.rule === "velocity_on_chain_cap"),
        ).to.be.true;
      }
    });

    it("check() rate limits still work after sync", () => {
      const state = new ShieldState();
      state.syncFromOnChain(mockResolvedState());
      const tracker = new VelocityTracker(state, { maxTxPerMinute: 1 });
      state.recordTransaction();
      try {
        tracker.check(SIGNER);
        expect.fail("should throw");
      } catch (err) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        const denied = err as ShieldDeniedError;
        expect(
          denied.violations.some((v) => v.rule === "velocity_tx_per_minute"),
        ).to.be.true;
      }
    });

    it("client-side fallback has null caps not 0n (F-9)", () => {
      const state = new ShieldState();
      const tracker = new VelocityTracker(state);
      const status = tracker.getSpendStatus();
      expect(status.globalCap).to.be.null;
      expect(status.globalRemaining).to.be.null;
      expect(status.agentCap).to.be.null;
      expect(status.agentSpent24h).to.be.null;
    });
  });
});
