import { expect } from "chai";
import {
  getTokenInfo,
  getProtocolName,
  isSystemProgram,
  isKnownProtocol,
  KNOWN_TOKENS,
  KNOWN_PROTOCOLS,
  SYSTEM_PROGRAMS,
} from "../../src/core/index.js";

describe("Registry", () => {
  describe("getTokenInfo", () => {
    it("returns symbol and decimals for USDC", () => {
      const info = getTokenInfo("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(info).to.deep.equal({ symbol: "USDC", decimals: 6 });
    });

    it("returns symbol and decimals for SOL", () => {
      const info = getTokenInfo("So11111111111111111111111111111111111111112");
      expect(info).to.deep.equal({ symbol: "SOL", decimals: 9 });
    });

    it("returns symbol and decimals for wBTC", () => {
      const info = getTokenInfo("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh");
      expect(info).to.deep.equal({ symbol: "wBTC", decimals: 8 });
    });

    it("returns undefined for unknown mint", () => {
      expect(getTokenInfo("UnknownMint111111111111111111111")).to.be.undefined;
    });
  });

  describe("getProtocolName", () => {
    it("returns name for Jupiter V6", () => {
      expect(
        getProtocolName("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
      ).to.equal("Jupiter V6");
    });

    it("returns undefined for unknown program", () => {
      expect(getProtocolName("UnknownProgram1111111111111111")).to.be.undefined;
    });
  });

  describe("isSystemProgram", () => {
    it("returns true for System Program", () => {
      expect(isSystemProgram("11111111111111111111111111111111")).to.be.true;
    });

    it("returns true for Token Program", () => {
      expect(isSystemProgram("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).to
        .be.true;
    });

    it("returns false for Jupiter V6", () => {
      expect(isSystemProgram("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).to
        .be.false;
    });
  });

  describe("isKnownProtocol", () => {
    it("returns true for Jupiter V6", () => {
      expect(isKnownProtocol("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).to
        .be.true;
    });

    it("returns false for random key", () => {
      expect(isKnownProtocol("RandomKey111111111111111111111111")).to.be.false;
    });
  });

  describe("Registry sizes", () => {
    it("KNOWN_TOKENS has expected number of entries", () => {
      expect(KNOWN_TOKENS.size).to.equal(10);
    });

    it("SYSTEM_PROGRAMS has expected number of entries", () => {
      expect(SYSTEM_PROGRAMS.size).to.equal(7);
    });

    it("KNOWN_PROTOCOLS includes system programs", () => {
      expect(KNOWN_PROTOCOLS.size).to.be.greaterThan(SYSTEM_PROGRAMS.size);
    });
  });
});
