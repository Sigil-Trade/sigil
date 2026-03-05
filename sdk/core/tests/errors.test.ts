import { expect } from "chai";
import {
  ShieldDeniedError,
  ShieldConfigError,
  type PolicyViolation,
} from "../src/index";

describe("Errors", () => {
  describe("ShieldDeniedError", () => {
    it("extends Error", () => {
      const err = new ShieldDeniedError([]);
      expect(err).to.be.instanceOf(Error);
    });

    it("has name 'ShieldDeniedError'", () => {
      const err = new ShieldDeniedError([]);
      expect(err.name).to.equal("ShieldDeniedError");
    });

    it("stores violations array and formats message with summaries", () => {
      const violations: PolicyViolation[] = [
        {
          rule: "spending_cap",
          message: "Exceeded USDC cap",
          suggestion: "Lower amount",
        },
        {
          rule: "rate_limit",
          message: "Too many transactions",
          suggestion: "Wait",
        },
      ];
      const err = new ShieldDeniedError(violations);
      expect(err.violations).to.deep.equal(violations);
      expect(err.message).to.include("Exceeded USDC cap");
      expect(err.message).to.include("Too many transactions");
      expect(err.message).to.include("Transaction denied by Phalnx");
    });
  });

  describe("ShieldConfigError", () => {
    it("extends Error", () => {
      const err = new ShieldConfigError("bad config");
      expect(err).to.be.instanceOf(Error);
    });

    it("has name 'ShieldConfigError'", () => {
      const err = new ShieldConfigError("bad config");
      expect(err.name).to.equal("ShieldConfigError");
    });
  });
});
