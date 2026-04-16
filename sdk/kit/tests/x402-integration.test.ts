/**
 * x402 Integration Tests — PR 3.A subpath audit.
 *
 * Minimal smoke tests verifying the x402 subpath exports work and the
 * core codec functions round-trip correctly. NOT a full shieldedFetch
 * E2E test (which requires a real 402-speaking server) — just the
 * unit-level codec + error class surface.
 */

import { expect } from "chai";
import {
  decodePaymentRequiredHeader,
  X402ParseError,
  X402PaymentError,
  X402UnsupportedError,
  X402DestinationBlockedError,
  X402ReplayError,
} from "../src/x402/index.js";

describe("x402 subpath — integration smoke tests", () => {
  describe("error classes exist and carry correct codes", () => {
    it("X402ParseError has SIGIL_ERROR__X402__HEADER_MALFORMED code", () => {
      const err = new X402ParseError("test");
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal("X402ParseError");
      expect(err.code).to.equal("SIGIL_ERROR__X402__HEADER_MALFORMED");
      expect(err.legacyNumericCode).to.equal(7024);
    });

    it("X402PaymentError has SIGIL_ERROR__X402__PAYMENT_FAILED code", () => {
      const err = new X402PaymentError("test");
      expect(err.code).to.equal("SIGIL_ERROR__X402__PAYMENT_FAILED");
      expect(err.legacyNumericCode).to.equal(7025);
    });

    it("X402UnsupportedError has SIGIL_ERROR__X402__UNSUPPORTED code", () => {
      const err = new X402UnsupportedError("test");
      expect(err.code).to.equal("SIGIL_ERROR__X402__UNSUPPORTED");
      expect(err.legacyNumericCode).to.equal(7026);
    });

    it("X402DestinationBlockedError carries payTo field", () => {
      const err = new X402DestinationBlockedError(
        "Bad1111111111111111111111111111111111111111",
      );
      expect(err.code).to.equal("SIGIL_ERROR__X402__DESTINATION_BLOCKED");
      expect(err.payTo).to.equal("Bad1111111111111111111111111111111111111111");
      expect(err.legacyNumericCode).to.equal(7027);
    });

    it("X402ReplayError carries nonceKey field", () => {
      const err = new X402ReplayError("nonce-abc");
      expect(err.code).to.equal("SIGIL_ERROR__X402__REPLAY");
      expect(err.nonceKey).to.equal("nonce-abc");
      expect(err.legacyNumericCode).to.equal(7028);
    });
  });

  describe("codec — decodePaymentRequiredHeader", () => {
    it("rejects empty header string", () => {
      expect(() => decodePaymentRequiredHeader("")).to.throw(X402ParseError);
    });

    it("rejects malformed base64 (not valid x402 V2 header)", () => {
      expect(() => decodePaymentRequiredHeader("not-valid-json")).to.throw(
        X402ParseError,
      );
    });

    it("rejects header missing x402Version field", () => {
      const encoded = Buffer.from(JSON.stringify({ accepts: [] })).toString(
        "base64",
      );
      expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
        X402ParseError,
      );
    });
  });
});
