import { expect } from "chai";
import { lookupError, formatError, ERROR_MAP } from "../src/errors";

describe("errors", () => {
  describe("ERROR_MAP", () => {
    it("has entries for error codes 6000–6045", () => {
      for (let code = 6000; code <= 6045; code++) {
        expect(ERROR_MAP[code], `Missing error code ${code}`).to.exist;
        expect(ERROR_MAP[code].code).to.equal(code);
        expect(ERROR_MAP[code].name).to.be.a("string");
        expect(ERROR_MAP[code].message).to.be.a("string");
        expect(ERROR_MAP[code].suggestion).to.be.a("string");
      }
    });

    it("has exactly 46 entries", () => {
      expect(Object.keys(ERROR_MAP)).to.have.length(46);
    });
  });

  describe("lookupError", () => {
    it("returns known error info for valid code", () => {
      const info = lookupError(6000);
      expect(info.name).to.equal("VaultNotActive");
      expect(info.message).to.include("not active");
      expect(info.suggestion).to.include("reactivate");
    });

    it("returns DailyCapExceeded for code 6006", () => {
      const info = lookupError(6006);
      expect(info.name).to.equal("DailyCapExceeded");
      expect(info.suggestion).to.include("rolling window");
    });

    it("returns Overflow for code 6025", () => {
      const info = lookupError(6025);
      expect(info.name).to.equal("Overflow");
    });

    it("returns generic info for unknown code", () => {
      const info = lookupError(9999);
      expect(info.name).to.equal("UnknownError");
      expect(info.message).to.include("9999");
    });
  });

  describe("formatError", () => {
    it("formats Anchor errors with code and suggestion", () => {
      const error = { code: 6003 };
      const msg = formatError(error);
      expect(msg).to.include("TokenNotRegistered");
      expect(msg).to.include("Suggestion:");
    });

    it("formats nested AnchorError format", () => {
      const error = {
        error: {
          errorCode: { code: "VaultNotActive", number: 6000 },
          errorMessage: "Vault is not active",
        },
      };
      const msg = formatError(error);
      expect(msg).to.include("VaultNotActive");
      expect(msg).to.include("Suggestion:");
    });

    it("formats network errors", () => {
      const error = new Error("failed to send transaction: Node is behind");
      const msg = formatError(error);
      expect(msg).to.include("Transaction failed");
      expect(msg).to.include("RPC endpoint");
    });

    it("formats account-not-found errors", () => {
      const error = new Error("Account does not exist or has no data");
      const msg = formatError(error);
      expect(msg).to.include("Account not found");
    });

    it("formats generic Error objects", () => {
      const error = new Error("Something went wrong");
      const msg = formatError(error);
      expect(msg).to.include("Something went wrong");
    });

    it("formats non-Error values", () => {
      const msg = formatError("string error");
      expect(msg).to.include("string error");
    });

    it("handles null/undefined gracefully", () => {
      const msg = formatError(null);
      expect(msg).to.be.a("string");
    });

    it("includes suggestion for every Anchor error", () => {
      for (let code = 6000; code <= 6045; code++) {
        const msg = formatError({ code });
        expect(msg, `Code ${code} missing suggestion`).to.include(
          "Suggestion:",
        );
      }
    });

    it("formatError maps code 6042 to OracleRegistryFull", () => {
      const msg = formatError({ code: 6042 });
      expect(msg).to.include("OracleRegistryFull");
      expect(msg).to.include("105");
    });

    it("formatError maps code 6044 to OraclePriceDivergence", () => {
      const msg = formatError({ code: 6044 });
      expect(msg).to.include("OraclePriceDivergence");
      expect(msg).to.include("diverge");
    });

    it("formatError maps code 6045 to OracleBothFeedsFailed", () => {
      const msg = formatError({ code: 6045 });
      expect(msg).to.include("OracleBothFeedsFailed");
      expect(msg).to.include("failed");
    });

    it("formatError maps code 6043 to UnauthorizedRegistryAdmin", () => {
      const msg = formatError({ code: 6043 });
      expect(msg).to.include("UnauthorizedRegistryAdmin");
      expect(msg).to.include("authority");
    });
  });
});
