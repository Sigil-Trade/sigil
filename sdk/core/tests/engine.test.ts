import { expect } from "chai";
import {
  evaluatePolicy,
  enforcePolicy,
  recordTransaction,
  resolvePolicies,
  ShieldState,
  ShieldDeniedError,
  type TransactionAnalysis,
} from "../src/index";

/** Helper: system-only transaction */
function systemOnlyTx(): TransactionAnalysis {
  return {
    programIds: ["11111111111111111111111111111111"],
    transfers: [],
    estimatedValueLamports: BigInt(0),
  };
}

describe("Engine", () => {
  describe("evaluatePolicy", () => {
    it("returns [] for compliant system-program-only transaction", () => {
      const policies = resolvePolicies();
      const state = new ShieldState(undefined);
      const violations = evaluatePolicy(systemOnlyTx(), policies, state);
      expect(violations).to.deep.equal([]);
    });

    it("returns protocol_not_allowed for unlisted protocol with allowedProtocols set", () => {
      const policies = resolvePolicies({
        allowedProtocols: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["RandomProgram11111111111111111111"],
        transfers: [],
        estimatedValueLamports: BigInt(0),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations).to.have.length(1);
      expect(violations[0].rule).to.equal("protocol_not_allowed");
    });

    it("returns unknown_program for unknown program with blockUnknownPrograms", () => {
      const policies = resolvePolicies({ blockUnknownPrograms: true });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["UnknownProg111111111111111111111111"],
        transfers: [],
        estimatedValueLamports: BigInt(0),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations).to.have.length(1);
      expect(violations[0].rule).to.equal("unknown_program");
    });

    it("allows system programs regardless of allowlist settings", () => {
      const policies = resolvePolicies({
        allowedProtocols: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: [
          "11111111111111111111111111111111",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ],
        transfers: [],
        estimatedValueLamports: BigInt(0),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations).to.deep.equal([]);
    });

    it("returns token_not_allowed for unlisted token", () => {
      const policies = resolvePolicies({
        allowedTokens: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "So11111111111111111111111111111111111111112",
            amount: BigInt(1_000_000),
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(1_000_000),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.some((v) => v.rule === "token_not_allowed")).to.be.true;
    });

    it("returns spending_cap when spend exceeds limit", () => {
      const policies = resolvePolicies({
        maxSpend: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: BigInt(100_000_000), // 100 USDC
          windowMs: 86_400_000,
        },
      });
      const state = new ShieldState(undefined);
      // Pre-spend 90 USDC
      state.recordSpend(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        BigInt(90_000_000),
      );

      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(20_000_000), // 20 USDC — would push to 110
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(20_000_000),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.some((v) => v.rule === "spending_cap")).to.be.true;
    });

    it("returns transaction_size when value exceeds max", () => {
      const policies = resolvePolicies({
        maxTransactionSize: BigInt(1_000_000),
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [],
        estimatedValueLamports: BigInt(2_000_000),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.some((v) => v.rule === "transaction_size")).to.be.true;
    });

    it("returns rate_limit when count >= maxTransactions", () => {
      const policies = resolvePolicies({
        rateLimit: { maxTransactions: 2, windowMs: 3_600_000 },
      });
      const state = new ShieldState(undefined);
      state.recordTransaction();
      state.recordTransaction();

      const violations = evaluatePolicy(systemOnlyTx(), policies, state);
      expect(violations.some((v) => v.rule === "rate_limit")).to.be.true;
    });

    it("returns multiple violations simultaneously", () => {
      const policies = resolvePolicies({
        allowedTokens: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        maxTransactionSize: BigInt(100),
        rateLimit: { maxTransactions: 0, windowMs: 3_600_000 },
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "So11111111111111111111111111111111111111112",
            amount: BigInt(1_000),
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(1_000),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.be.greaterThanOrEqual(2);
      const rules = violations.map((v) => v.rule);
      expect(rules).to.include("token_not_allowed");
      expect(rules).to.include("transaction_size");
    });

    it("ignores incoming transfers for spending cap checks", () => {
      const policies = resolvePolicies({
        maxSpend: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: BigInt(100_000_000),
          windowMs: 86_400_000,
        },
      });
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(999_000_000_000), // huge incoming
            direction: "incoming",
          },
        ],
        estimatedValueLamports: BigInt(0),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(
        violations.filter((v) => v.rule === "spending_cap"),
      ).to.have.length(0);
    });

    it("spending cap boundary: exactly at limit triggers violation", () => {
      const limit = BigInt(100_000_000);
      const policies = resolvePolicies({
        maxSpend: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: limit,
          windowMs: 86_400_000,
        },
      });
      const state = new ShieldState(undefined);
      state.recordSpend(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        BigInt(50_000_000),
      );

      // Attempt exactly at limit: 50M existing + 50M+1 = over
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(50_000_001), // pushes 1 over
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(50_000_001),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.some((v) => v.rule === "spending_cap")).to.be.true;
    });

    it("spending cap boundary: one below limit is allowed", () => {
      const limit = BigInt(100_000_000);
      const policies = resolvePolicies({
        maxSpend: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: limit,
          windowMs: 86_400_000,
        },
      });
      const state = new ShieldState(undefined);
      state.recordSpend(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        BigInt(50_000_000),
      );

      // Attempt exactly at limit: 50M existing + 50M = exactly 100M (allowed since totalAfterTx <= limit)
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(50_000_000), // exactly at limit
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(50_000_000),
      };
      const violations = evaluatePolicy(analysis, policies, state);
      expect(
        violations.filter((v) => v.rule === "spending_cap"),
      ).to.have.length(0);
    });
  });

  describe("enforcePolicy", () => {
    it("throws ShieldDeniedError on violation", () => {
      const policies = resolvePolicies({
        rateLimit: { maxTransactions: 0, windowMs: 3_600_000 },
      });
      const state = new ShieldState(undefined);
      expect(() => enforcePolicy(systemOnlyTx(), policies, state)).to.throw(
        ShieldDeniedError,
      );
    });

    it("does not throw on compliant transaction", () => {
      const policies = resolvePolicies();
      const state = new ShieldState(undefined);
      expect(() =>
        enforcePolicy(systemOnlyTx(), policies, state),
      ).to.not.throw();
    });
  });

  describe("recordTransaction", () => {
    it("records outgoing spend in state", () => {
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(1_000_000),
            direction: "outgoing",
          },
        ],
        estimatedValueLamports: BigInt(1_000_000),
      };
      recordTransaction(analysis, state);
      const spend = state.getSpendInWindow(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        86_400_000,
      );
      expect(spend).to.equal(BigInt(1_000_000));
    });

    it("ignores incoming transfers for spend tracking", () => {
      const state = new ShieldState(undefined);
      const analysis: TransactionAnalysis = {
        programIds: ["11111111111111111111111111111111"],
        transfers: [
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            amount: BigInt(5_000_000),
            direction: "incoming",
          },
        ],
        estimatedValueLamports: BigInt(0),
      };
      recordTransaction(analysis, state);
      const spend = state.getSpendInWindow(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        86_400_000,
      );
      expect(spend).to.equal(BigInt(0));
    });

    it("increments transaction count", () => {
      const state = new ShieldState(undefined);
      recordTransaction(systemOnlyTx(), state);
      recordTransaction(systemOnlyTx(), state);
      expect(state.getTransactionCountInWindow(3_600_000)).to.equal(2);
    });
  });
});
