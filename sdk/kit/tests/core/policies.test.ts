import { expect } from "chai";
import {
  parseSpendLimit,
  resolvePolicies,
  DEFAULT_POLICIES,
  ShieldConfigError,
} from "../../src/core/index.js";

describe("Policies", () => {
  describe("parseSpendLimit", () => {
    it("parses '500 USDC/day' correctly", () => {
      const limit = parseSpendLimit("500 USDC/day");
      expect(limit.mint).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(limit.amount).to.equal(BigInt(500_000_000));
      expect(limit.windowMs).to.equal(86_400_000);
    });

    it("parses '10 SOL/hour' correctly", () => {
      const limit = parseSpendLimit("10 SOL/hour");
      expect(limit.mint).to.equal(
        "So11111111111111111111111111111111111111112",
      );
      expect(limit.amount).to.equal(BigInt(10_000_000_000));
      expect(limit.windowMs).to.equal(3_600_000);
    });

    it("parses '0.5 wBTC/day' with fractional amount", () => {
      const limit = parseSpendLimit("0.5 wBTC/day");
      expect(limit.mint).to.equal(
        "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      );
      expect(limit.amount).to.equal(BigInt(50_000_000));
    });

    it("defaults to /day when no window specified", () => {
      const limit = parseSpendLimit("100 USDC");
      expect(limit.windowMs).to.equal(86_400_000);
    });

    it("throws ShieldConfigError for invalid format", () => {
      expect(() => parseSpendLimit("not-valid")).to.throw(ShieldConfigError);
    });

    it("throws ShieldConfigError for unknown token", () => {
      expect(() => parseSpendLimit("100 FAKE/day")).to.throw(ShieldConfigError);
    });

    it("throws ShieldConfigError for unknown time window", () => {
      expect(() => parseSpendLimit("100 USDC/week")).to.throw(
        ShieldConfigError,
      );
    });
  });

  describe("resolvePolicies", () => {
    it("returns defaults when called with no arguments", () => {
      const resolved = resolvePolicies();
      expect(resolved.spendLimits).to.have.length(3);
      expect(resolved.blockUnknownPrograms).to.be.true;
      expect(resolved.rateLimit.maxTransactions).to.equal(60);
      expect(resolved.rateLimit.windowMs).to.equal(3_600_000);
    });

    it("replaces default spend limits with maxSpend string", () => {
      const resolved = resolvePolicies({ maxSpend: "500 USDC/day" });
      expect(resolved.spendLimits).to.have.length(1);
      expect(resolved.spendLimits[0].amount).to.equal(BigInt(500_000_000));
    });

    it("creates Set from allowedProtocols array", () => {
      const protocols = [
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
      ];
      const resolved = resolvePolicies({ allowedProtocols: protocols });
      expect(resolved.allowedProtocols).to.be.instanceOf(Set);
      expect(resolved.allowedProtocols!.size).to.equal(2);
      expect(resolved.allowedProtocols!.has(protocols[0])).to.be.true;
    });

    it("creates Set from allowedTokens array", () => {
      const tokens = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
      const resolved = resolvePolicies({ allowedTokens: tokens });
      expect(resolved.allowedTokens).to.be.instanceOf(Set);
      expect(resolved.allowedTokens!.size).to.equal(1);
    });

    it("overrides blockUnknownPrograms default", () => {
      const resolved = resolvePolicies({ blockUnknownPrograms: false });
      expect(resolved.blockUnknownPrograms).to.be.false;
    });

    it("overrides rateLimit", () => {
      const resolved = resolvePolicies({
        rateLimit: { maxTransactions: 10, windowMs: 60_000 },
      });
      expect(resolved.rateLimit.maxTransactions).to.equal(10);
      expect(resolved.rateLimit.windowMs).to.equal(60_000);
    });

    it("accepts SpendLimit objects directly", () => {
      const limit = {
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: BigInt(100_000_000),
        windowMs: 3_600_000,
      };
      const resolved = resolvePolicies({ maxSpend: limit });
      expect(resolved.spendLimits).to.have.length(1);
      expect(resolved.spendLimits[0]).to.deep.equal(limit);
    });
  });

  describe("DEFAULT_POLICIES", () => {
    it("has 3 default spend limits", () => {
      expect(DEFAULT_POLICIES.maxSpend).to.have.length(3);
    });

    it("has blockUnknownPrograms true", () => {
      expect(DEFAULT_POLICIES.blockUnknownPrograms).to.be.true;
    });

    it("has rateLimit of 60 txs/hour", () => {
      expect(DEFAULT_POLICIES.rateLimit.maxTransactions).to.equal(60);
      expect(DEFAULT_POLICIES.rateLimit.windowMs).to.equal(3_600_000);
    });
  });
});
