import { expect } from "chai";
import {
  CU_AGENT_TRANSFER,
  CU_JUPITER_SWAP,
  CU_JUPITER_MULTI_HOP,
  CU_FLASH_TRADE,
  CU_JUPITER_LEND,
  CU_DRIFT,
  CU_KAMINO_LEND,
  CU_DEFAULT_COMPOSED,
  CU_VAULT_CREATION,
  CU_OWNER_ACTION,
  estimateComposedCU,
  PriorityFeeEstimator,
} from "../src/priority-fees.js";
import type { Address, Instruction } from "@solana/kit";

/** Create a mock Instruction with a given programAddress */
function mockIx(programAddress: string): Instruction {
  return {
    programAddress: programAddress as Address,
    accounts: [],
    data: new Uint8Array(),
  };
}

describe("priority-fees", () => {
  describe("CU constants", () => {
    it("CU_AGENT_TRANSFER = 200_000", () => {
      expect(CU_AGENT_TRANSFER).to.equal(200_000);
    });

    it("CU_JUPITER_SWAP = 600_000", () => {
      expect(CU_JUPITER_SWAP).to.equal(600_000);
    });

    it("CU_JUPITER_MULTI_HOP = 900_000", () => {
      expect(CU_JUPITER_MULTI_HOP).to.equal(900_000);
    });

    it("CU_FLASH_TRADE = 800_000", () => {
      expect(CU_FLASH_TRADE).to.equal(800_000);
    });

    it("CU_JUPITER_LEND = 400_000", () => {
      expect(CU_JUPITER_LEND).to.equal(400_000);
    });

    it("CU_DRIFT = 800_000", () => {
      expect(CU_DRIFT).to.equal(800_000);
    });

    it("CU_KAMINO_LEND = 400_000", () => {
      expect(CU_KAMINO_LEND).to.equal(400_000);
    });

    it("CU_DEFAULT_COMPOSED = 800_000", () => {
      expect(CU_DEFAULT_COMPOSED).to.equal(800_000);
    });

    it("CU_VAULT_CREATION = 400_000", () => {
      expect(CU_VAULT_CREATION).to.equal(400_000);
    });

    it("CU_OWNER_ACTION = 200_000", () => {
      expect(CU_OWNER_ACTION).to.equal(200_000);
    });
  });

  describe("estimateComposedCU", () => {
    it("empty instructions returns CU_AGENT_TRANSFER", () => {
      expect(estimateComposedCU([])).to.equal(CU_AGENT_TRANSFER);
    });

    it("Jupiter program returns CU_JUPITER_SWAP", () => {
      const ixs = [mockIx("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")];
      expect(estimateComposedCU(ixs)).to.equal(CU_JUPITER_SWAP);
    });

    it("Jupiter with >2 instructions returns CU_JUPITER_MULTI_HOP", () => {
      const jupAddr = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
      const ixs = [mockIx(jupAddr), mockIx(jupAddr), mockIx(jupAddr)];
      expect(estimateComposedCU(ixs)).to.equal(CU_JUPITER_MULTI_HOP);
    });

    it("Flash Trade program returns CU_FLASH_TRADE", () => {
      const ixs = [mockIx("FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn")];
      expect(estimateComposedCU(ixs)).to.equal(CU_FLASH_TRADE);
    });

    it("Drift program returns CU_DRIFT", () => {
      const ixs = [mockIx("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH")];
      expect(estimateComposedCU(ixs)).to.equal(CU_DRIFT);
    });

    it("unknown program returns CU_DEFAULT_COMPOSED", () => {
      const ixs = [mockIx("11111111111111111111111111111111")];
      expect(estimateComposedCU(ixs)).to.equal(CU_DEFAULT_COMPOSED);
    });

    it("Jupiter Lend program returns CU_JUPITER_LEND", () => {
      const ixs = [mockIx("JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu")];
      expect(estimateComposedCU(ixs)).to.equal(CU_JUPITER_LEND);
    });

    it("Kamino Lend program returns CU_KAMINO_LEND", () => {
      const ixs = [mockIx("KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM")];
      expect(estimateComposedCU(ixs)).to.equal(CU_KAMINO_LEND);
    });
  });

  describe("PriorityFeeEstimator", () => {
    it("static fallback returns fallbackMicroLamports when no RPC", async () => {
      const estimator = new PriorityFeeEstimator(
        "http://localhost:8899",
        null,
        { fallbackMicroLamports: 5_000, strategy: "static" },
      );
      const fee = await estimator.estimate("medium");
      expect(fee).to.equal(5_000);
    });

    it("max cap enforced", async () => {
      const estimator = new PriorityFeeEstimator(
        "http://localhost:8899",
        null,
        {
          fallbackMicroLamports: 2_000_000,
          maxMicroLamports: 500_000,
          strategy: "static",
        },
      );
      const fee = await estimator.estimate("high");
      expect(fee).to.equal(500_000);
    });
  });
});
