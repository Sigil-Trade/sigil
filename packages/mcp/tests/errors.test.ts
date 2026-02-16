import { expect } from "chai";
import { lookupError, formatError, ERROR_MAP } from "../src/errors";

describe("errors", () => {
  describe("ERROR_MAP", () => {
    it("has entries for error codes 6000–6027", () => {
      for (let code = 6000; code <= 6027; code++) {
        expect(ERROR_MAP[code], `Missing error code ${code}`).to.exist;
        expect(ERROR_MAP[code].code).to.equal(code);
        expect(ERROR_MAP[code].name).to.be.a("string");
        expect(ERROR_MAP[code].message).to.be.a("string");
        expect(ERROR_MAP[code].suggestion).to.be.a("string");
      }
    });

    it("has exactly 28 entries", () => {
      expect(Object.keys(ERROR_MAP)).to.have.length(28);
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

    it("returns Overflow for code 6027", () => {
      const info = lookupError(6027);
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
      expect(msg).to.include("TokenNotAllowed");
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
      for (let code = 6000; code <= 6027; code++) {
        const msg = formatError({ code });
        expect(msg, `Code ${code} missing suggestion`).to.include(
          "Suggestion:"
        );
      }
    });
  });
});
