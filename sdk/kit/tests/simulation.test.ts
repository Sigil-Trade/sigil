import { expect } from "chai";
import {
  RISK_FLAG_LARGE_OUTFLOW,
  RISK_FLAG_UNKNOWN_RECIPIENT,
  RISK_FLAG_FULL_DRAIN,
  RISK_FLAG_MULTI_OUTPUT,
  RISK_FLAG_SIZE_OVERFLOW,
  RISK_FLAG_ERROR_MAP,
  detectDrainAttempt,
  adjustCU,
} from "../src/simulation.js";
import type { BalanceDelta, DrainDetectionInput } from "../src/simulation.js";

function makeDelta(
  account: string,
  pre: bigint,
  post: bigint,
): BalanceDelta {
  return { account, preBalance: pre, postBalance: post, delta: post - pre };
}

describe("simulation", () => {
  describe("RISK_FLAG constants", () => {
    it("LARGE_OUTFLOW is correct string", () => {
      expect(RISK_FLAG_LARGE_OUTFLOW).to.equal("LARGE_OUTFLOW");
    });

    it("UNKNOWN_RECIPIENT is correct string", () => {
      expect(RISK_FLAG_UNKNOWN_RECIPIENT).to.equal("UNKNOWN_RECIPIENT");
    });

    it("FULL_DRAIN is correct string", () => {
      expect(RISK_FLAG_FULL_DRAIN).to.equal("FULL_DRAIN");
    });

    it("MULTI_OUTPUT is correct string", () => {
      expect(RISK_FLAG_MULTI_OUTPUT).to.equal("MULTI_OUTPUT");
    });

    it("SIZE_OVERFLOW is correct string", () => {
      expect(RISK_FLAG_SIZE_OVERFLOW).to.equal("SIZE_OVERFLOW");
    });
  });

  describe("RISK_FLAG_ERROR_MAP", () => {
    it("maps LARGE_OUTFLOW to 7001", () => {
      expect(RISK_FLAG_ERROR_MAP[RISK_FLAG_LARGE_OUTFLOW]).to.equal(7001);
    });

    it("maps UNKNOWN_RECIPIENT to 7002", () => {
      expect(RISK_FLAG_ERROR_MAP[RISK_FLAG_UNKNOWN_RECIPIENT]).to.equal(7002);
    });

    it("maps all 5 flags to codes 7001-7005", () => {
      const codes = Object.values(RISK_FLAG_ERROR_MAP);
      expect(codes).to.have.length(5);
      expect(codes).to.include(7001);
      expect(codes).to.include(7002);
      expect(codes).to.include(7003);
      expect(codes).to.include(7004);
      expect(codes).to.include(7005);
    });
  });

  describe("detectDrainAttempt", () => {
    const VAULT = "vault111111111111111111111111111111111111111";

    it("no vault delta returns no flags", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta("other", 100n, 200n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      expect(detectDrainAttempt(input)).to.deep.equal([]);
    });

    it("small outflow (<50%) returns no LARGE_OUTFLOW", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 600n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.not.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("large outflow (>50%) returns LARGE_OUTFLOW", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 400n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("full drain (>95%) returns FULL_DRAIN + LARGE_OUTFLOW", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 10n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_FULL_DRAIN);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("unknown recipient triggers flag", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta(VAULT, 1000n, 900n),
          makeDelta("unknown_acct", 0n, 100n),
        ],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
        knownRecipients: new Set(["known_acct"]),
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_UNKNOWN_RECIPIENT);
    });

    it("known recipients do not trigger flag", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta(VAULT, 1000n, 900n),
          makeDelta("known_acct", 0n, 100n),
        ],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
        knownRecipients: new Set(["known_acct"]),
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.not.include(RISK_FLAG_UNKNOWN_RECIPIENT);
    });

    it("3+ positive deltas triggers MULTI_OUTPUT", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta(VAULT, 1000n, 700n),
          makeDelta("acct1", 0n, 100n),
          makeDelta("acct2", 0n, 100n),
          makeDelta("acct3", 0n, 100n),
        ],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_MULTI_OUTPUT);
    });

    it("empty balance deltas returns no flags", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      expect(detectDrainAttempt(input)).to.deep.equal([]);
    });
  });

  describe("adjustCU", () => {
    it("undefined simulated returns estimated", () => {
      expect(adjustCU(200_000, undefined)).to.equal(200_000);
    });

    it("within 20% returns estimated", () => {
      // estimated=200_000, simulated=180_000 → headroom=198_000
      // diff = |198000-200000|/200000 = 0.01 < 0.2 → return estimated
      expect(adjustCU(200_000, 180_000)).to.equal(200_000);
    });

    it(">20% off returns adjusted with 10% headroom", () => {
      // estimated=200_000, simulated=100_000 → headroom=ceil(100_000*1.1)=110_000
      // diff = |110_000-200_000|/200_000 = 0.45 > 0.2 → return headroom
      const result = adjustCU(200_000, 100_000);
      expect(result).to.equal(Math.ceil(100_000 * 1.1));
    });

    it("simulated=0 returns headroom (0)", () => {
      // headroom = ceil(0 * 1.1) = 0
      // diff = |0-200000|/200000 = 1.0 > 0.2 → return headroom=0
      expect(adjustCU(200_000, 0)).to.equal(0);
    });
  });
});
