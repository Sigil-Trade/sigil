import { expect } from "chai";
import {
  PhalnxSDKError,
  parseOnChainError,
  precheckError,
} from "../src/errors";

describe("errors", () => {
  describe("PhalnxSDKError", () => {
    it("extends Error with structured metadata", () => {
      const err = new PhalnxSDKError({
        code: 6006,
        name: "SpendingCapExceeded",
        message: "Rolling 24h spending cap would be exceeded",
        expected: "amount <= $50 remaining",
        actual: "requested $100",
        field: "amount",
        suggestion: "Reduce amount to $50",
      });

      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal("PhalnxSDKError");
      expect(err.code).to.equal(6006);
      expect(err.errorName).to.equal("SpendingCapExceeded");
      expect(err.message).to.equal("Daily spending cap would be exceeded");
      expect(err.expected).to.equal("amount <= $50 remaining");
      expect(err.actual).to.equal("requested $100");
      expect(err.field).to.equal("amount");
      expect(err.suggestion).to.equal("Reduce amount to $50");
    });

    it("has optional fields", () => {
      const err = new PhalnxSDKError({
        code: 6000,
        name: "VaultNotActive",
        message: "Vault is not active",
      });

      expect(err.expected).to.be.undefined;
      expect(err.actual).to.be.undefined;
      expect(err.field).to.be.undefined;
      expect(err.suggestion).to.be.undefined;
    });
  });

  describe("parseOnChainError", () => {
    it("parses error with code property", () => {
      const err = parseOnChainError({ code: 6006 });
      expect(err).to.not.be.null;
      expect(err!.code).to.equal(6006);
      expect(err!.errorName).to.equal("SpendingCapExceeded");
      expect(err!.suggestion).to.include("rolling window");
    });

    it("parses Anchor-format error", () => {
      const err = parseOnChainError({
        error: { errorCode: { number: 6044 } },
      });
      expect(err).to.not.be.null;
      expect(err!.code).to.equal(6044);
      expect(err!.errorName).to.equal("InsufficientPermissions");
    });

    it("parses hex error from log message", () => {
      const err = parseOnChainError({
        message: "custom program error: 0x1776", // 6006
      });
      expect(err).to.not.be.null;
      expect(err!.code).to.equal(6006);
    });

    it("returns null for non-Anchor errors", () => {
      const err = parseOnChainError(new Error("network error"));
      expect(err).to.be.null;
    });

    it("returns null for null input", () => {
      expect(parseOnChainError(null)).to.be.null;
    });

    it("returns UnknownError for unrecognized codes", () => {
      const err = parseOnChainError({ code: 6999 });
      expect(err).to.not.be.null;
      expect(err!.errorName).to.equal("UnknownError");
    });

    it("maps error 6000 (VaultNotActive)", () => {
      const err = parseOnChainError({ code: 6000 });
      expect(err).to.not.be.null;
      expect(err!.errorName).to.equal("VaultNotActive");
      expect(err!.suggestion).to.include("Reactivate");
    });

    it("maps error 6004 (ProtocolNotAllowed)", () => {
      const err = parseOnChainError({ code: 6004 });
      expect(err).to.not.be.null;
      expect(err!.errorName).to.equal("ProtocolNotAllowed");
    });

    it("maps error 6037 (SwapSlippageExceeded)", () => {
      const err = parseOnChainError({ code: 6037 });
      expect(err).to.not.be.null;
      expect(err!.errorName).to.equal("SwapSlippageExceeded");
    });
  });

  describe("precheckError", () => {
    it("creates structured precheck failure", () => {
      const err = precheckError({
        check: "spendingCap",
        expected: "amount <= $50",
        actual: "requested $100",
        suggestion: "Reduce amount",
      });

      expect(err).to.be.instanceOf(PhalnxSDKError);
      expect(err.code).to.equal(-1);
      expect(err.errorName).to.equal("PrecheckFailed");
      expect(err.message).to.include("spendingCap");
      expect(err.expected).to.equal("amount <= $50");
      expect(err.actual).to.equal("requested $100");
      expect(err.field).to.equal("spendingCap");
      expect(err.suggestion).to.equal("Reduce amount");
    });
  });
});
