import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import {
  composePhalnxTransaction,
  validateTransactionSize,
  measureTransactionSize,
} from "../src/composer.js";
import type { ComposeTransactionParams } from "../src/composer.js";
import type { AddressesByLookupTableAddress } from "@solana/kit";
import { AltCache, mergeAltAddresses } from "../src/alt-loader.js";
import { toAgentError } from "../src/agent-errors.js";
import {
  PHALNX_ALT_DEVNET,
  PHALNX_ALT_MAINNET,
  getPhalnxAltAddress,
  EXPECTED_ALT_CONTENTS_DEVNET,
  EXPECTED_ALT_CONTENTS_MAINNET,
} from "../src/alt-config.js";

const MOCK_PAYER = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;
const MOCK_PROGRAM = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const MOCK_BLOCKHASH = {
  blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
  lastValidBlockHeight: 1000n,
};

// Well-known Solana addresses for testing
const ALT_ADDR = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const ADDR_1 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

function mockIx(programAddress: Address = MOCK_PROGRAM): Instruction {
  return {
    programAddress,
    accounts: [],
    data: new Uint8Array([1, 2, 3]),
  };
}

function baseParams(
  overrides?: Partial<ComposeTransactionParams>,
): ComposeTransactionParams {
  return {
    feePayer: MOCK_PAYER,
    validateIx: mockIx(),
    defiInstructions: [mockIx()],
    finalizeIx: mockIx(),
    blockhash: MOCK_BLOCKHASH,
    ...overrides,
  };
}

describe("ALT integration", () => {
  describe("measureTransactionSize", () => {
    it("returns correct structure", () => {
      const compiled = composePhalnxTransaction(baseParams());
      const result = measureTransactionSize(compiled);
      expect(result).to.have.property("wireBase64").that.is.a("string");
      expect(result).to.have.property("byteLength").that.is.a("number");
      expect(result).to.have.property("withinLimit").that.is.a("boolean");
    });

    it("small TX is within limit", () => {
      const compiled = composePhalnxTransaction(baseParams());
      const { withinLimit, byteLength } = measureTransactionSize(compiled);
      expect(withinLimit).to.be.true;
      expect(byteLength).to.be.lessThan(1232);
    });

    it("matches validateTransactionSize results", () => {
      const compiled = composePhalnxTransaction(baseParams());
      const { wireBase64 } = measureTransactionSize(compiled);
      const validated = validateTransactionSize(compiled);
      expect(wireBase64).to.equal(validated);
    });
  });

  describe("composer with ALTs", () => {
    it("composes without ALTs (regression)", () => {
      const compiled = composePhalnxTransaction(baseParams());
      expect(compiled).to.have.property("messageBytes");
    });

    it("composes with empty ALTs", () => {
      const compiled = composePhalnxTransaction(
        baseParams({ addressLookupTables: {} }),
      );
      expect(compiled).to.have.property("messageBytes");
    });

    it("composes with ALTs that do not match any accounts (no-op compression)", () => {
      // ALT addresses not referenced in the simple mock instructions
      const alts: AddressesByLookupTableAddress = {
        [ALT_ADDR]: [ADDR_1],
      };
      const compiled = composePhalnxTransaction(
        baseParams({ addressLookupTables: alts }),
      );
      expect(compiled).to.have.property("messageBytes");
    });
  });

  describe("ALT config", () => {
    it("getPhalnxAltAddress returns devnet ALT for devnet", () => {
      expect(getPhalnxAltAddress("devnet")).to.equal(PHALNX_ALT_DEVNET);
    });

    it("getPhalnxAltAddress throws for mainnet while ALT is placeholder", () => {
      expect(() => getPhalnxAltAddress("mainnet-beta")).to.throw(/not yet deployed/);
    });

    it("expected ALT contents have correct entry count per network", () => {
      expect(EXPECTED_ALT_CONTENTS_DEVNET).to.have.lengthOf(7); // 5 base + 2 treasury ATAs
      expect(EXPECTED_ALT_CONTENTS_MAINNET).to.have.lengthOf(5); // mainnet ATAs not yet added
    });

    it("devnet and mainnet ALT contents differ in mints", () => {
      // First two entries are USDC/USDT mints — different per network
      expect(EXPECTED_ALT_CONTENTS_DEVNET[0]).to.not.equal(
        EXPECTED_ALT_CONTENTS_MAINNET[0],
      );
    });
  });

  describe("SIZE_OVERFLOW error (7033)", () => {
    it("error code 7033 converts to TX_SIZE_OVERFLOW AgentError", () => {
      const err = { code: 7033, message: "TX too large" };
      const agentErr = toAgentError(err);
      expect(agentErr.code).to.equal("TX_SIZE_OVERFLOW");
      expect(agentErr.category).to.equal("INPUT_VALIDATION");
      expect(agentErr.retryable).to.be.false;
    });

    // Deleted 2 false-positive tests that constructed error objects and asserted
    // their own properties. Replaced with a real test that exercises validateTransactionSize().
  });

  describe("mergeAltAddresses with protocol ALTs", () => {
    it("Jupiter ALT + Phalnx ALT produces merged list", () => {
      const jupiterAlt = ALT_ADDR;
      const merged = mergeAltAddresses(PHALNX_ALT_DEVNET, [jupiterAlt]);
      expect(merged).to.have.lengthOf(2);
      expect(merged[0]).to.equal(PHALNX_ALT_DEVNET);
      expect(merged[1]).to.equal(jupiterAlt);
    });

    it("overlapping ALTs are deduplicated", () => {
      const merged = mergeAltAddresses(PHALNX_ALT_DEVNET, [
        ALT_ADDR,
        PHALNX_ALT_DEVNET,
        ALT_ADDR,
      ]);
      expect(merged).to.have.lengthOf(2);
    });
  });

  describe("CU recompose preserves ALT compression (V3)", () => {
    it("size delta is small between initial and recomposed CU", () => {
      // Compose with a specific CU value
      const compiled1 = composePhalnxTransaction(
        baseParams({ computeUnits: 200_000 }),
      );
      const size1 = measureTransactionSize(compiled1);

      // Recompose with different CU (simulating adjustCU result)
      const compiled2 = composePhalnxTransaction(
        baseParams({ computeUnits: 250_000 }),
      );
      const size2 = measureTransactionSize(compiled2);

      // CU change only affects the ComputeBudget ix data (~3 bytes difference max)
      const delta = Math.abs(size1.byteLength - size2.byteLength);
      expect(delta).to.be.lessThanOrEqual(5);
    });

    it("CU recompose with ALTs still within limit", () => {
      const alts: AddressesByLookupTableAddress = {
        [ALT_ADDR]: [ADDR_1],
      };
      const compiled = composePhalnxTransaction(
        baseParams({ computeUnits: 300_000, addressLookupTables: alts }),
      );
      const { withinLimit } = measureTransactionSize(compiled);
      expect(withinLimit).to.be.true;
    });
  });

  describe("AltCache integration", () => {
    it("getCachedAddresses works with populated cache", () => {
      const cache = new AltCache();
      const altAddr = ALT_ADDR;

      (cache as any).cache.set(altAddr as string, {
        data: { [altAddr]: [ADDR_1] },
        expiresAt: Date.now() + 300_000,
      });

      const resolved = cache.getCachedAddresses(altAddr);
      expect(resolved).to.deep.equal([ADDR_1]);
    });

    it("graceful degradation: resolve returns empty on RPC failure", async () => {
      const cache = new AltCache();
      const result = await cache.resolve({} as any, [ALT_ADDR]);
      expect(result).to.deep.equal({});
    });
  });
});
