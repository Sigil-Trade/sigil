import { expect } from "chai";
import type { Address, AddressesByLookupTableAddress } from "@solana/kit";
import { AltCache, mergeAltAddresses, verifyPhalnxAlt } from "../src/alt-loader.js";

const ALT_A = "ALTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const ALT_B = "ALTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const ADDR_1 = "Addr1111111111111111111111111111111111111111" as Address;
const ADDR_2 = "Addr2222222222222222222222222222222222222222" as Address;
const ADDR_3 = "Addr3333333333333333333333333333333333333333" as Address;

describe("alt-loader", () => {
  describe("AltCache", () => {
    it("returns empty map for empty input", async () => {
      const cache = new AltCache();
      const mockRpc = {} as any;
      const result = await cache.resolve(mockRpc, []);
      expect(result).to.deep.equal({});
    });

    it("getCachedAddresses returns undefined when not cached", () => {
      const cache = new AltCache();
      expect(cache.getCachedAddresses(ALT_A)).to.be.undefined;
    });

    it("invalidate clears all entries", async () => {
      const cache = new AltCache();
      // Manually populate cache by creating a resolve with a mock
      const mockRpc = {
        getMultipleAccounts: () => ({
          send: async () => ({ value: [] }),
        }),
      } as any;

      // Force a cache entry
      (cache as any).cache.set(ALT_A as string, {
        data: { [ALT_A]: [ADDR_1, ADDR_2] },
        expiresAt: Date.now() + 300_000,
      });

      expect(cache.getCachedAddresses(ALT_A)).to.deep.equal([ADDR_1, ADDR_2]);
      cache.invalidate();
      expect(cache.getCachedAddresses(ALT_A)).to.be.undefined;
    });

    it("getCachedAddresses returns data after manual cache population", () => {
      const cache = new AltCache();
      (cache as any).cache.set(ALT_A as string, {
        data: { [ALT_A]: [ADDR_1, ADDR_2, ADDR_3] },
        expiresAt: Date.now() + 300_000,
      });
      const addresses = cache.getCachedAddresses(ALT_A);
      expect(addresses).to.deep.equal([ADDR_1, ADDR_2, ADDR_3]);
    });

    it("expired cache entries return undefined", () => {
      const cache = new AltCache();
      (cache as any).cache.set(ALT_A as string, {
        data: { [ALT_A]: [ADDR_1] },
        expiresAt: Date.now() - 1, // expired
      });
      expect(cache.getCachedAddresses(ALT_A)).to.be.undefined;
    });

    it("resolve returns cached data without RPC call", async () => {
      const cache = new AltCache();
      (cache as any).cache.set(ALT_A as string, {
        data: { [ALT_A]: [ADDR_1] },
        expiresAt: Date.now() + 300_000,
      });

      let rpcCalled = false;
      const mockRpc = new Proxy(
        {},
        {
          get: () => {
            rpcCalled = true;
            return () => ({ send: async () => ({ value: [] }) });
          },
        },
      ) as any;

      const result = await cache.resolve(mockRpc, [ALT_A]);
      expect(rpcCalled).to.be.false;
      expect(result[ALT_A]).to.deep.equal([ADDR_1]);
    });

    it("graceful degradation on RPC failure returns empty map", async () => {
      const cache = new AltCache();
      // Mock RPC that throws
      const mockRpc = {} as any;

      // resolve should not throw, should return {}
      const result = await cache.resolve(mockRpc, [ALT_A]);
      expect(result).to.deep.equal({});
    });
  });

  describe("mergeAltAddresses", () => {
    it("returns phalnx ALT when no protocol ALTs", () => {
      const result = mergeAltAddresses(ALT_A);
      expect(result).to.deep.equal([ALT_A]);
    });

    it("returns phalnx ALT when protocol ALTs is empty", () => {
      const result = mergeAltAddresses(ALT_A, []);
      expect(result).to.deep.equal([ALT_A]);
    });

    it("merges phalnx + protocol ALTs", () => {
      const result = mergeAltAddresses(ALT_A, [ALT_B]);
      expect(result).to.deep.equal([ALT_A, ALT_B]);
    });

    it("deduplicates overlapping ALTs", () => {
      const result = mergeAltAddresses(ALT_A, [ALT_B, ALT_A, ALT_B]);
      expect(result).to.deep.equal([ALT_A, ALT_B]);
    });

    it("phalnx ALT always comes first", () => {
      const result = mergeAltAddresses(ALT_B, [ALT_A]);
      expect(result[0]).to.equal(ALT_B);
    });
  });

  describe("verifyPhalnxAlt", () => {
    it("passes when all expected addresses are present", () => {
      const resolved: AddressesByLookupTableAddress = {
        [ALT_A]: [ADDR_1, ADDR_2, ADDR_3],
      };
      // Should not throw
      verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2]);
    });

    it("passes when ALT has extra addresses beyond expected", () => {
      const resolved: AddressesByLookupTableAddress = {
        [ALT_A]: [ADDR_1, ADDR_2, ADDR_3],
      };
      // Extra ADDR_3 is fine — ALTs can have more than expected
      verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2]);
    });

    it("throws when expected address is missing from ALT", () => {
      const resolved: AddressesByLookupTableAddress = {
        [ALT_A]: [ADDR_1], // missing ADDR_2
      };
      expect(() =>
        verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2]),
      ).to.throw(/missing 1 expected address/);
    });

    it("throws with address details when multiple addresses missing", () => {
      const resolved: AddressesByLookupTableAddress = {
        [ALT_A]: [], // missing all
      };
      expect(() =>
        verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2, ADDR_3]),
      ).to.throw(/missing 3 expected address/);
    });

    it("is a no-op when Phalnx ALT was not resolved (graceful degradation)", () => {
      const resolved: AddressesByLookupTableAddress = {
        // ALT_A not present — RPC fetch failed for this ALT
      };
      // Should not throw — graceful degradation
      verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2]);
    });

    it("is a no-op with completely empty resolved map", () => {
      const resolved: AddressesByLookupTableAddress = {};
      verifyPhalnxAlt(resolved, ALT_A, [ADDR_1, ADDR_2]);
    });

    it("stale cache scenario: first verify throws, second with fresh data passes", () => {
      // Simulates the retry pattern in wrap.ts:
      // 1. Cache has old ALT (2 entries), expected has 3 entries → throws
      // 2. Cache invalidated, fresh fetch has 3 entries → passes

      const staleResolved: AddressesByLookupTableAddress = {
        [ALT_A]: [ADDR_1, ADDR_2], // missing ADDR_3
      };
      const freshResolved: AddressesByLookupTableAddress = {
        [ALT_A]: [ADDR_1, ADDR_2, ADDR_3], // all present after re-fetch
      };
      const expected = [ADDR_1, ADDR_2, ADDR_3];

      // First attempt throws (stale)
      expect(() => verifyPhalnxAlt(staleResolved, ALT_A, expected)).to.throw(/missing 1/);

      // Second attempt passes (fresh) — simulates the retry in wrap.ts
      verifyPhalnxAlt(freshResolved, ALT_A, expected);
    });
  });
});
