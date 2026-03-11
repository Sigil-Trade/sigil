import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  resolvePolicies,
  toCoreAnalysis,
  parseSpendLimit,
  DEFAULT_POLICIES,
} from "../src/policies.js";
import type { TransactionAnalysis } from "../src/policies.js";

describe("policies", () => {
  describe("resolvePolicies", () => {
    it("undefined returns defaults from core", () => {
      const resolved = resolvePolicies(undefined);
      expect(resolved).to.have.property("maxTransactionSize");
      expect(resolved).to.have.property("blockUnknownPrograms");
    });

    it("empty object returns defaults", () => {
      const resolved = resolvePolicies({});
      expect(resolved).to.have.property("blockUnknownPrograms");
    });

    it("with maxSpend string resolves correctly", () => {
      const resolved = resolvePolicies({
        maxSpend: "500 USDC/day",
      });
      expect(resolved).to.have.property("spendLimits");
    });

    it("with allowedProtocols passes through", () => {
      const protocols = [
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
      ];
      const resolved = resolvePolicies({
        allowedProtocols: protocols,
      });
      expect(resolved).to.have.property("allowedProtocols");
    });

    it("customCheck is preserved on result", () => {
      const customFn = () => ({ allowed: true as const });
      const resolved = resolvePolicies({
        customCheck: customFn,
      });
      expect(resolved.customCheck).to.equal(customFn);
    });
  });

  describe("toCoreAnalysis", () => {
    it("programIds cast to strings", () => {
      const analysis: TransactionAnalysis = {
        programIds: [
          "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
        ],
        transfers: [],
        estimatedValueLamports: 0n,
      };
      const core = toCoreAnalysis(analysis);
      expect(core.programIds[0]).to.equal(
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      );
      expect(typeof core.programIds[0]).to.equal("string");
    });

    it("transfers mapped with all fields", () => {
      const analysis: TransactionAnalysis = {
        programIds: [],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
            amount: 100n,
            direction: "outgoing",
            destination:
              "11111111111111111111111111111111" as Address,
          },
        ],
        estimatedValueLamports: 100n,
      };
      const core = toCoreAnalysis(analysis);
      expect(core.transfers).to.have.length(1);
      expect(core.transfers[0].mint).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(core.transfers[0].amount).to.equal(100n);
      expect(core.transfers[0].direction).to.equal("outgoing");
      expect(core.transfers[0].destination).to.equal(
        "11111111111111111111111111111111",
      );
    });

    it("direction values preserved", () => {
      const directions = ["outgoing", "incoming", "unknown"] as const;
      for (const dir of directions) {
        const analysis: TransactionAnalysis = {
          programIds: [],
          transfers: [
            {
              mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
              amount: 0n,
              direction: dir,
            },
          ],
          estimatedValueLamports: 0n,
        };
        const core = toCoreAnalysis(analysis);
        expect(core.transfers[0].direction).to.equal(dir);
      }
    });

    it("estimatedValueLamports passed through", () => {
      const analysis: TransactionAnalysis = {
        programIds: [],
        transfers: [],
        estimatedValueLamports: 999_999n,
      };
      const core = toCoreAnalysis(analysis);
      expect(core.estimatedValueLamports).to.equal(999_999n);
    });
  });

  describe("parseSpendLimit re-export", () => {
    it("'500 USDC/day' parses correctly", () => {
      const limit = parseSpendLimit("500 USDC/day");
      expect(limit.mint).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(limit.amount).to.equal(500_000_000n);
      expect(limit.windowMs).to.equal(86_400_000);
    });

    it("invalid string throws", () => {
      expect(() => parseSpendLimit("gibberish")).to.throw();
    });
  });

  describe("DEFAULT_POLICIES re-export", () => {
    it("accessible and has expected shape", () => {
      expect(DEFAULT_POLICIES).to.exist;
      expect(DEFAULT_POLICIES).to.have.property("blockUnknownPrograms");
    });
  });
});
