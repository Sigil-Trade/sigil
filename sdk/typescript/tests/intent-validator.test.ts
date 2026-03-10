import { expect } from "chai";
import { validateIntentInput } from "../src/intent-validator";
import type { IntentAction } from "../src/intents";

describe("intent-validator", () => {
  // ── Amount validation ──────────────────────────────────────────────────

  describe("amount validation", () => {
    it("accepts valid positive numeric string", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.true;
      expect(result.errors).to.have.length(0);
    });

    it("accepts decimal amounts (human-readable)", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100.5",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects negative amount", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "-50",
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].context).to.have.property("field", "amount");
    });

    it("rejects zero amount", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "0",
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].message).to.include("positive");
    });

    it("rejects non-numeric string", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "abc",
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].message).to.include("not a valid number");
    });

    it("rejects empty string amount", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "",
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects amount exceeding u64 max", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "18446744073709551616", // u64::MAX + 1
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].message).to.include("u64");
    });

    it("accepts amount at u64 max", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "18446744073709551615", // u64::MAX
        },
      });
      expect(result.valid).to.be.true;
    });
  });

  // ── Address validation ─────────────────────────────────────────────────

  describe("address validation", () => {
    it("accepts valid base58 address", () => {
      const result = validateIntentInput({
        type: "transfer",
        params: {
          destination: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          mint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects address with invalid characters", () => {
      const result = validateIntentInput({
        type: "transfer",
        params: {
          destination: "0xInvalidEthAddress1234567890abcdef12345678",
          mint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.false;
      const addrError = result.errors.find(
        (e) => e.context.field === "destination",
      );
      expect(addrError).to.not.be.undefined;
      expect(addrError!.message).to.include("base58");
    });

    it("rejects too-short address", () => {
      const result = validateIntentInput({
        type: "transfer",
        params: {
          destination: "short",
          mint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects empty address", () => {
      const result = validateIntentInput({
        type: "transfer",
        params: {
          destination: "",
          mint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.false;
    });
  });

  // ── Slippage validation ────────────────────────────────────────────────

  describe("slippage validation", () => {
    it("accepts valid slippage (50 = 0.5%)", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          slippageBps: 50,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("accepts slippage of 0", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          slippageBps: 0,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects negative slippage", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          slippageBps: -10,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects slippage > 10000", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          slippageBps: 10001,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects non-integer slippage", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          slippageBps: 50.5,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("does not validate slippage when not provided", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.true;
    });
  });

  // ── Leverage validation ────────────────────────────────────────────────

  describe("leverage validation", () => {
    it("accepts valid leverage (10x)", () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 10,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects leverage > 100", () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 101,
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].context).to.have.property("field", "leverage");
    });

    it("rejects zero leverage", () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 0,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects negative leverage", () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: -5,
        },
      });
      expect(result.valid).to.be.false;
    });
  });

  // ── Side validation ────────────────────────────────────────────────────

  describe("side validation", () => {
    it('accepts "long"', () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 5,
        },
      });
      expect(result.valid).to.be.true;
    });

    it('accepts "short"', () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "short",
          collateral: "100",
          leverage: 5,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects invalid side value", () => {
      const result = validateIntentInput({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "buy" as "long",
          collateral: "100",
          leverage: 5,
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].message).to.include("long");
    });
  });

  // ── Escrow duration validation ─────────────────────────────────────────

  describe("escrow duration validation", () => {
    it("accepts valid duration", () => {
      const result = validateIntentInput({
        type: "createEscrow",
        params: {
          destinationVault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "100",
          mint: "So11111111111111111111111111111111111111112",
          expiresInSeconds: 86400, // 1 day
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects duration > MAX_ESCROW_DURATION (30 days)", () => {
      const result = validateIntentInput({
        type: "createEscrow",
        params: {
          destinationVault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "100",
          mint: "So11111111111111111111111111111111111111112",
          expiresInSeconds: 2_592_001,
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors[0].message).to.include("30 days");
    });

    it("rejects zero duration", () => {
      const result = validateIntentInput({
        type: "createEscrow",
        params: {
          destinationVault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "100",
          mint: "So11111111111111111111111111111111111111112",
          expiresInSeconds: 0,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("rejects negative duration", () => {
      const result = validateIntentInput({
        type: "createEscrow",
        params: {
          destinationVault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "100",
          mint: "So11111111111111111111111111111111111111112",
          expiresInSeconds: -3600,
        },
      });
      expect(result.valid).to.be.false;
    });
  });

  // ── Multiple errors ────────────────────────────────────────────────────

  describe("multiple error accumulation", () => {
    it("reports all invalid fields at once", () => {
      const result = validateIntentInput({
        type: "swap",
        params: {
          inputMint: "invalid",
          outputMint: "",
          amount: "-50",
          slippageBps: -1,
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThanOrEqual(3);

      const fields = result.errors.map((e) => e.context.field);
      expect(fields).to.include("inputMint");
      expect(fields).to.include("outputMint");
      expect(fields).to.include("amount");
    });
  });

  // ── Error structure ────────────────────────────────────────────────────

  describe("error structure", () => {
    it("returns AgentError format with correct fields", () => {
      const result = validateIntentInput({
        type: "deposit",
        params: {
          mint: "invalid-mint",
          amount: "-1",
        },
      });
      expect(result.valid).to.be.false;

      for (const err of result.errors) {
        expect(err.code).to.equal("INTENT_VALIDATION_FAILED");
        expect(err.category).to.equal("INPUT_VALIDATION");
        expect(err.retryable).to.be.false;
        expect(err.recovery_actions)
          .to.be.an("array")
          .with.length.greaterThan(0);
        expect(err.context).to.have.property("field");
        expect(err.context).to.have.property("received");
      }
    });
  });

  // ── Protocol (generic) validation ──────────────────────────────────────

  describe("protocol intent validation", () => {
    it("validates protocolId and action are non-empty", () => {
      const result = validateIntentInput({
        type: "protocol",
        params: {
          protocolId: "",
          action: "",
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors.length).to.equal(2);
    });

    it("accepts valid protocol intent", () => {
      const result = validateIntentInput({
        type: "protocol",
        params: {
          protocolId: "drift",
          action: "deposit",
          mint: "USDC",
          amount: "100",
        },
      });
      expect(result.valid).to.be.true;
    });
  });

  // ── Drift-specific validation ──────────────────────────────────────────

  describe("drift intent validation", () => {
    it("validates driftDeposit", () => {
      const result = validateIntentInput({
        type: "driftDeposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "1000",
          marketIndex: 0,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects negative marketIndex", () => {
      const result = validateIntentInput({
        type: "driftDeposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "1000",
          marketIndex: -1,
        },
      });
      expect(result.valid).to.be.false;
    });

    it("validates driftPerpOrder", () => {
      const result = validateIntentInput({
        type: "driftPerpOrder",
        params: {
          marketIndex: 0,
          side: "long",
          amount: "100",
          orderType: "market",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("validates driftCancelOrder", () => {
      const result = validateIntentInput({
        type: "driftCancelOrder",
        params: { orderId: 42 },
      });
      expect(result.valid).to.be.true;
    });
  });

  // ── Kamino validation ──────────────────────────────────────────────────

  describe("kamino intent validation", () => {
    it("validates kaminoDeposit", () => {
      const result = validateIntentInput({
        type: "kaminoDeposit",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "500",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("validates kaminoBorrow with optional market", () => {
      const result = validateIntentInput({
        type: "kaminoBorrow",
        params: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "200",
          market: "main",
        },
      });
      expect(result.valid).to.be.true;
    });
  });

  // ── Close position (minimal validation) ────────────────────────────────

  describe("closePosition validation", () => {
    it("accepts valid closePosition", () => {
      const result = validateIntentInput({
        type: "closePosition",
        params: { market: "SOL-PERP" },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects empty market", () => {
      const result = validateIntentInput({
        type: "closePosition",
        params: { market: "" },
      });
      expect(result.valid).to.be.false;
    });
  });

  // ── LeverageBps validation ─────────────────────────────────────────────

  describe("leverageBps validation", () => {
    it("accepts valid leverageBps in swapAndOpenPosition", () => {
      const result = validateIntentInput({
        type: "swapAndOpenPosition",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          market: "SOL-PERP",
          side: "long",
          sizeAmount: "50",
          leverageBps: 50000, // 5x
        },
      });
      expect(result.valid).to.be.true;
    });

    it("rejects leverageBps > 1_000_000", () => {
      const result = validateIntentInput({
        type: "swapAndOpenPosition",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
          market: "SOL-PERP",
          side: "long",
          sizeAmount: "50",
          leverageBps: 1_000_001,
        },
      });
      expect(result.valid).to.be.false;
    });
  });
});
