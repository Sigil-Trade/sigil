import { expect } from "chai";
import type { Address } from "@solana/kit";
import { AltCache, mergeAltAddresses } from "../src/alt-loader.js";

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
});
