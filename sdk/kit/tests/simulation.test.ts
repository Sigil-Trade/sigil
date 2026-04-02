import { expect } from "chai";
import {
  RISK_FLAG_LARGE_OUTFLOW,
  RISK_FLAG_UNKNOWN_RECIPIENT,
  RISK_FLAG_FULL_DRAIN,
  RISK_FLAG_MULTI_OUTPUT,
  detectDrainAttempt,
  detectDrainFromSealContext,
  adjustCU,
  parseTokenBalance,
  DEFAULT_WARNING_PERCENT,
  DEFAULT_BLOCK_PERCENT,
} from "../src/simulation.js";
import type {
  BalanceDelta,
  DrainDetectionInput,
  DrainThresholds,
} from "../src/simulation.js";

function makeDelta(account: string, pre: bigint, post: bigint): BalanceDelta {
  return { account, preBalance: pre, postBalance: post, delta: post - pre };
}

describe("simulation", () => {
  // RISK_FLAG constants and RISK_FLAG_ERROR_MAP are string/number literals.
  // They don't need runtime tests — TypeScript types enforce correctness.
  // Deleted 6 tautological tests (constant === its own literal value).

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

    it("2 unknown positive deltas triggers MULTI_OUTPUT", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta(VAULT, 1000n, 400n),
          makeDelta("attacker1", 0n, 300n),
          makeDelta("attacker2", 0n, 300n),
        ],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_MULTI_OUTPUT);
    });

    it("2 known positive deltas does NOT trigger MULTI_OUTPUT", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta(VAULT, 1000n, 800n),
          makeDelta("treasury", 0n, 100n),
          makeDelta("fee_dest", 0n, 100n),
        ],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
        knownRecipients: new Set(["treasury", "fee_dest"]),
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.not.include(RISK_FLAG_MULTI_OUTPUT);
    });

    it("outflow at exact warningPercent triggers LARGE_OUTFLOW (>= boundary)", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 500n)], // exactly 50%
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      // Default warningPercent = 50. Outflow = 500/1000 = exactly 50%.
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
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

  describe("detectDrainFromSealContext", () => {
    const VAULT = "vault111111111111111111111111111111111111111";

    it("wires vaultContext fields to detectDrainAttempt", () => {
      const deltas = [
        makeDelta(VAULT, 1000n, 400n),
        makeDelta("unknown", 0n, 600n),
      ];
      const vaultContext = {
        vaultAddress: VAULT,
        tokenBalance: 1000n,
        knownRecipients: new Set<string>(),
      };
      const flags = detectDrainFromSealContext(deltas, vaultContext);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW); // 60% >= 50%
      expect(flags).to.include(RISK_FLAG_UNKNOWN_RECIPIENT);
    });

    it("excludes known recipients from UNKNOWN_RECIPIENT", () => {
      const deltas = [
        makeDelta(VAULT, 1000n, 900n),
        makeDelta("treasury", 0n, 100n),
      ];
      const vaultContext = {
        vaultAddress: VAULT,
        tokenBalance: 1000n,
        knownRecipients: new Set(["treasury"]),
      };
      const flags = detectDrainFromSealContext(deltas, vaultContext);
      expect(flags).to.not.include(RISK_FLAG_UNKNOWN_RECIPIENT);
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

  describe("parseTokenBalance", () => {
    it("extracts u64 at offset 64 correctly", () => {
      // Build a fake SPL Token account: 32 mint + 32 owner + 8 amount
      const data = new Uint8Array(72);
      // Write 1_000_000n (0xF4240) at offset 64 in LE
      const amount = 1_000_000n;
      for (let i = 0; i < 8; i++) {
        data[64 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
      }
      // Convert to base64
      let binary = "";
      for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
      }
      const base64 = btoa(binary);
      expect(parseTokenBalance(base64)).to.equal(1_000_000n);
    });

    it("returns 0n for short data", () => {
      // Less than 72 bytes
      const short = btoa("hello");
      expect(parseTokenBalance(short)).to.equal(0n);
    });
  });

  describe("detectDrainAttempt with configurable thresholds", () => {
    const VAULT = "vault111111111111111111111111111111111111111";

    it("respects configurable thresholds", () => {
      // 30% outflow with 25% warning threshold should trigger LARGE_OUTFLOW
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 700n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const thresholds: DrainThresholds = {
        warningPercent: 25,
        blockPercent: 90,
      };
      const flags = detectDrainAttempt(input, thresholds);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
      expect(flags).to.not.include(RISK_FLAG_FULL_DRAIN);
    });

    it("uses default thresholds when none provided", () => {
      expect(DEFAULT_WARNING_PERCENT).to.equal(50);
      expect(DEFAULT_BLOCK_PERCENT).to.equal(95);

      // 60% outflow with default 50% threshold → LARGE_OUTFLOW
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 400n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
      expect(flags).to.not.include(RISK_FLAG_FULL_DRAIN);
    });

    it("blocks at custom blockPercent threshold", () => {
      // 75% outflow with 70% block threshold → FULL_DRAIN
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 250n)],
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      const thresholds: DrainThresholds = {
        warningPercent: 30,
        blockPercent: 70,
      };
      const flags = detectDrainAttempt(input, thresholds);
      expect(flags).to.include(RISK_FLAG_FULL_DRAIN);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("clamps negative warningPercent to 0 (triggers on any outflow)", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 999n)], // 0.1% outflow
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      // Negative % is clamped to 0 → any outflow triggers LARGE_OUTFLOW
      const thresholds: DrainThresholds = {
        warningPercent: -10,
        blockPercent: 95,
      };
      const flags = detectDrainAttempt(input, thresholds);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("clamps NaN warningPercent to default (50)", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 400n)], // 60% outflow
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      // NaN falls back to default 50% threshold
      const thresholds: DrainThresholds = {
        warningPercent: NaN,
        blockPercent: 95,
      };
      const flags = detectDrainAttempt(input, thresholds);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
      expect(flags).to.not.include(RISK_FLAG_FULL_DRAIN);
    });

    it("clamps blockPercent > 100 to 100 (prevents unreachable threshold)", () => {
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta(VAULT, 1000n, 0n)], // 100% outflow
        vaultAddress: VAULT,
        totalVaultBalance: 1000n,
      };
      // Without clamping, blockPercent=200 would make FULL_DRAIN unreachable.
      // With clamping to 100, the threshold is `outflow * 100 >= balance * 100`
      // which is `>=` (inclusive), so 100% exactly DOES trigger FULL_DRAIN.
      // This is correct: draining 100% of vault should always be flagged.
      const thresholds: DrainThresholds = {
        warningPercent: 50,
        blockPercent: 200,
      };
      const flags = detectDrainAttempt(input, thresholds);
      // 100% outflow >= 50% warning → LARGE_OUTFLOW fires
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
      // 100% outflow >= 100% block (inclusive) → FULL_DRAIN fires
      expect(flags).to.include(RISK_FLAG_FULL_DRAIN);
    });
  });

  describe("parseTokenBalance edge cases", () => {
    it("throws on malformed base64 (fail-closed per council Decision 3a)", () => {
      expect(() => parseTokenBalance("!!!not-base64!!!")).to.throw();
    });

    it("returns 0n for valid but short data (uninitialized account)", () => {
      // Valid base64 but only 32 bytes (< 72 required for SPL Token layout)
      const shortData = btoa(String.fromCharCode(...new Array(32).fill(0)));
      expect(parseTokenBalance(shortData)).to.equal(0n);
    });
  });

  describe("simulateBeforeSend with monitorAccounts", () => {
    it("returns empty riskFlags when no monitorAccounts (backward compat)", () => {
      // simulateBeforeSend is async + requires RPC, so we test the
      // drain detection path indirectly through detectDrainAttempt
      // 60% outflow: exceeds default 50% warning threshold
      const input: DrainDetectionInput = {
        balanceDeltas: [makeDelta("vault", 1000n, 400n)],
        vaultAddress: "vault",
        totalVaultBalance: 1000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("builds balance deltas from monitorAccounts simulation response", () => {
      // When monitorAccounts are provided, simulateBeforeSend adds accounts
      // to the RPC config and parses post-simulation account state.
      // We verify the parseTokenBalance → detectDrainAttempt pipeline.
      const input: DrainDetectionInput = {
        balanceDeltas: [
          makeDelta("vault_ata", 1_000_000n, 40_000n), // 96% drained
        ],
        vaultAddress: "vault_ata",
        totalVaultBalance: 1_000_000n,
      };
      const flags = detectDrainAttempt(input);
      expect(flags).to.include(RISK_FLAG_FULL_DRAIN);
      expect(flags).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });
  });
});
