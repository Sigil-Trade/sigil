import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  isTeeWallet,
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
} from "../src/tee/wallet-types.js";
import { AttestationCache, DEFAULT_CACHE_TTL_MS } from "../src/tee/cache.js";
import { AttestationStatus } from "../src/tee/types.js";
import {
  verifyTeeAttestation,
  clearAttestationCache,
} from "../src/tee/verify.js";
import type { WalletLike, TeeWallet } from "../src/tee/wallet-types.js";
import type { AttestationResult } from "../src/tee/types.js";

const MOCK_ADDRESS = "11111111111111111111111111111111" as Address;

function mockWallet(publicKey: Address = MOCK_ADDRESS): WalletLike {
  return { publicKey };
}

function mockTeeWallet(
  provider: string,
  publicKey: Address = MOCK_ADDRESS,
): TeeWallet {
  return { publicKey, provider };
}

function mockAttestationResult(
  status: AttestationStatus = AttestationStatus.ProviderVerified,
): AttestationResult {
  return {
    status,
    provider: "crossmint",
    publicKey: MOCK_ADDRESS,
    metadata: { provider: "crossmint", verifiedAt: Date.now() },
    message: "test",
  };
}

describe("tee-attestation", () => {
  // Reset cache between tests
  beforeEach(() => {
    clearAttestationCache();
  });

  describe("isTeeWallet", () => {
    it("WalletLike without provider returns false", () => {
      expect(isTeeWallet(mockWallet())).to.be.false;
    });

    it("TeeWallet with provider returns true", () => {
      expect(isTeeWallet(mockTeeWallet("crossmint"))).to.be.true;
    });

    it("empty provider string returns false", () => {
      expect(isTeeWallet(mockTeeWallet(""))).to.be.false;
    });

    it("non-string provider returns false", () => {
      const wallet = { publicKey: MOCK_ADDRESS, provider: 123 } as any;
      expect(isTeeWallet(wallet)).to.be.false;
    });
  });

  describe("Error classes", () => {
    it("TeeAttestationError has correct message and name", () => {
      const err = new TeeAttestationError("test error");
      expect(err.message).to.equal("test error");
      expect(err.name).to.equal("TeeAttestationError");
      expect(err).to.be.instanceOf(Error);
    });

    it("AttestationCertChainError extends TeeAttestationError", () => {
      const err = new AttestationCertChainError("cert fail");
      expect(err).to.be.instanceOf(TeeAttestationError);
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal("AttestationCertChainError");
    });

    it("AttestationPcrMismatchError stores pcrIndex/expected/actual", () => {
      const err = new AttestationPcrMismatchError(3, "aaa", "bbb");
      expect(err.pcrIndex).to.equal(3);
      expect(err.expected).to.equal("aaa");
      expect(err.actual).to.equal("bbb");
      expect(err.message).to.include("PCR3");
      expect(err.message).to.include("aaa");
      expect(err.message).to.include("bbb");
    });

    it("instanceof hierarchy is correct", () => {
      const pcr = new AttestationPcrMismatchError(0, "x", "y");
      expect(pcr).to.be.instanceOf(TeeAttestationError);
      expect(pcr).to.be.instanceOf(Error);
    });

    it("message format includes values", () => {
      const err = new AttestationPcrMismatchError(2, "expected_hash", "actual_hash");
      expect(err.message).to.include("expected_hash");
      expect(err.message).to.include("actual_hash");
      expect(err.message).to.include("PCR2");
    });
  });

  describe("AttestationCache", () => {
    it("set/get works", () => {
      const cache = new AttestationCache(60_000);
      const result = mockAttestationResult();
      cache.set("key1", result);
      expect(cache.get("key1")).to.deep.equal(result);
    });

    it("expired entry returns undefined", () => {
      const cache = new AttestationCache(1); // 1ms TTL
      cache.set("key1", mockAttestationResult());
      // Wait a bit for expiry
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy wait
      }
      expect(cache.get("key1")).to.be.undefined;
    });

    it("delete returns true on hit, false on miss", () => {
      const cache = new AttestationCache();
      cache.set("key1", mockAttestationResult());
      expect(cache.delete("key1")).to.be.true;
      expect(cache.delete("key1")).to.be.false;
    });

    it("clear empties cache", () => {
      const cache = new AttestationCache();
      cache.set("key1", mockAttestationResult());
      cache.set("key2", mockAttestationResult());
      expect(cache.size).to.equal(2);
      cache.clear();
      expect(cache.size).to.equal(0);
    });

    it("max entries eviction works", () => {
      const cache = new AttestationCache(60_000, 3);
      cache.set("a", mockAttestationResult());
      cache.set("b", mockAttestationResult());
      cache.set("c", mockAttestationResult());
      expect(cache.size).to.equal(3);
      cache.set("d", mockAttestationResult());
      // Oldest entry ("a") should be evicted
      expect(cache.size).to.equal(3);
      expect(cache.get("a")).to.be.undefined;
      expect(cache.get("d")).to.not.be.undefined;
    });

    it("NaN TTL falls back to default", () => {
      const cache = new AttestationCache(NaN);
      cache.set("key1", mockAttestationResult());
      // Should not expire immediately since it falls back to DEFAULT_CACHE_TTL_MS
      expect(cache.get("key1")).to.not.be.undefined;
    });
  });

  describe("AttestationStatus enum", () => {
    it("all 5 values accessible", () => {
      expect(AttestationStatus.CryptographicallyVerified).to.equal(
        "cryptographically_verified",
      );
      expect(AttestationStatus.ProviderVerified).to.equal("provider_verified");
      expect(AttestationStatus.ProviderTrusted).to.equal("provider_trusted");
      expect(AttestationStatus.Failed).to.equal("failed");
      expect(AttestationStatus.Unavailable).to.equal("unavailable");
    });

    it("values are distinct strings", () => {
      const values = [
        AttestationStatus.CryptographicallyVerified,
        AttestationStatus.ProviderVerified,
        AttestationStatus.ProviderTrusted,
        AttestationStatus.Failed,
        AttestationStatus.Unavailable,
      ];
      const unique = new Set(values);
      expect(unique.size).to.equal(5);
    });
  });

  describe("verifyTeeAttestation", () => {
    it("non-TEE wallet returns Unavailable", async () => {
      const result = await verifyTeeAttestation(mockWallet());
      expect(result.status).to.equal(AttestationStatus.Unavailable);
    });

    it("requireAttestation + Failed throws TeeAttestationError", async () => {
      try {
        await verifyTeeAttestation(mockWallet(), {
          requireAttestation: true,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(TeeAttestationError);
      }
    });

    it("minAttestationLevel enforcement", async () => {
      // Non-TEE wallet gets Unavailable, which doesn't meet any level
      try {
        await verifyTeeAttestation(mockWallet(), {
          minAttestationLevel: "provider_trusted",
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(TeeAttestationError);
        expect((err as Error).message).to.include("does not meet minimum");
      }
    });
  });

  describe("DEFAULT_CACHE_TTL_MS", () => {
    it("is 1 hour (3_600_000ms)", () => {
      expect(DEFAULT_CACHE_TTL_MS).to.equal(3_600_000);
    });
  });
});
