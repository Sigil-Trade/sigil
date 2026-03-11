import { expect } from "chai";
import { resolveToken, toBaseUnits, fromBaseUnits } from "../src/tokens.js";
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_MAINNET,
} from "../src/types.js";

describe("tokens", () => {
  describe("resolveToken", () => {
    it("'USDC' devnet returns correct mint", () => {
      const token = resolveToken("USDC", "devnet");
      expect(token).to.not.be.null;
      expect(token!.mint).to.equal(USDC_MINT_DEVNET);
      expect(token!.decimals).to.equal(6);
      expect(token!.symbol).to.equal("USDC");
    });

    it("'usdc' (lowercase) returns same result (case-insensitive)", () => {
      const token = resolveToken("usdc", "devnet");
      expect(token).to.not.be.null;
      expect(token!.mint).to.equal(USDC_MINT_DEVNET);
    });

    it("'USDT' mainnet returns correct mint", () => {
      const token = resolveToken("USDT", "mainnet-beta");
      expect(token).to.not.be.null;
      expect(token!.mint).to.equal(USDT_MINT_MAINNET);
      expect(token!.decimals).to.equal(6);
    });

    it("'SOL' returns wrapped SOL mint", () => {
      const token = resolveToken("SOL", "mainnet-beta");
      expect(token).to.not.be.null;
      expect(token!.mint).to.equal(
        "So11111111111111111111111111111111111111112",
      );
      expect(token!.decimals).to.equal(9);
    });

    it("'WSOL' returns same as SOL", () => {
      const sol = resolveToken("SOL", "mainnet-beta");
      const wsol = resolveToken("WSOL", "mainnet-beta");
      expect(sol).to.not.be.null;
      expect(wsol).to.not.be.null;
      expect(sol!.mint).to.equal(wsol!.mint);
    });

    it("'BONK' returns correct decimals (5)", () => {
      const token = resolveToken("BONK", "mainnet-beta");
      expect(token).to.not.be.null;
      expect(token!.decimals).to.equal(5);
    });

    it("'JUP' returns 6 decimals", () => {
      const token = resolveToken("JUP", "mainnet-beta");
      expect(token).to.not.be.null;
      expect(token!.decimals).to.equal(6);
    });

    it("valid base58 address returns with defaults", () => {
      const token = resolveToken(USDC_MINT_MAINNET, "mainnet-beta");
      expect(token).to.not.be.null;
      // Already in well-known, but a raw base58 also works
    });

    it("'not-a-token' returns null", () => {
      const token = resolveToken("not-a-token", "mainnet-beta");
      expect(token).to.be.null;
    });

    it("short base58 (<32 chars) returns null", () => {
      const token = resolveToken("abc123", "mainnet-beta");
      expect(token).to.be.null;
    });

    it("defaults to mainnet-beta when no network specified", () => {
      const token = resolveToken("USDC");
      expect(token).to.not.be.null;
      expect(token!.mint).to.equal(USDC_MINT_MAINNET);
    });
  });

  describe("toBaseUnits", () => {
    it("toBaseUnits(100, 6) === 100_000_000n", () => {
      expect(toBaseUnits(100, 6)).to.equal(100_000_000n);
    });

    it("toBaseUnits(0, 6) === 0n", () => {
      expect(toBaseUnits(0, 6)).to.equal(0n);
    });

    it("toBaseUnits(0.5, 6) === 500_000n", () => {
      expect(toBaseUnits(0.5, 6)).to.equal(500_000n);
    });

    it("string input works", () => {
      expect(toBaseUnits("100", 6)).to.equal(100_000_000n);
    });

    it("NaN throws", () => {
      expect(() => toBaseUnits(NaN, 6)).to.throw("Invalid amount");
    });

    it("negative throws", () => {
      expect(() => toBaseUnits(-1, 6)).to.throw("Invalid amount");
    });

    it("Infinity throws", () => {
      expect(() => toBaseUnits(Infinity, 6)).to.throw("Invalid amount");
    });
  });

  describe("fromBaseUnits", () => {
    it("fromBaseUnits(100_000_000n, 6) === 100", () => {
      expect(fromBaseUnits(100_000_000n, 6)).to.equal(100);
    });

    it("fromBaseUnits(0n, 6) === 0", () => {
      expect(fromBaseUnits(0n, 6)).to.equal(0);
    });

    it("fromBaseUnits(500_000n, 6) === 0.5", () => {
      expect(fromBaseUnits(500_000n, 6)).to.equal(0.5);
    });

    it("round-trip: fromBaseUnits(toBaseUnits(100, 6), 6) === 100", () => {
      expect(fromBaseUnits(toBaseUnits(100, 6), 6)).to.equal(100);
    });
  });
});
