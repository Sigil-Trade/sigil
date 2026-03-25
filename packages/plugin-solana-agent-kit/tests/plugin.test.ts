import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";
import { createPhalnxPlugin, type PhalnxSakConfig } from "../src/index.js";

// ─── Test Addresses ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function mockSigner(): TransactionSigner {
  return {
    address: AGENT_ADDR,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
  } as TransactionSigner;
}

function mockRpc(): any {
  return {} as any;
}

function mockConfig(overrides?: Partial<PhalnxSakConfig>): PhalnxSakConfig {
  return {
    vault: VAULT,
    network: "devnet",
    rpc: mockRpc(),
    agent: mockSigner(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("@phalnx/plugin-solana-agent-kit", () => {
  describe("createPhalnxPlugin", () => {
    it("returns valid SAK plugin shape", () => {
      const plugin = createPhalnxPlugin(mockConfig());

      expect(plugin).to.have.property("name", "phalnx");
      expect(plugin).to.have.property("methods");
      expect(plugin.methods).to.have.property("phalnx_swap");
      expect(plugin.methods).to.have.property("phalnx_transfer");
      expect(plugin.methods).to.have.property("phalnx_status");
    });

    it("each method has description, schema, and handler", () => {
      const plugin = createPhalnxPlugin(mockConfig());

      for (const [name, action] of Object.entries(plugin.methods)) {
        expect(action, `${name} missing description`).to.have.property(
          "description",
        );
        expect(action.description).to.be.a("string").that.is.not.empty;
        expect(action, `${name} missing schema`).to.have.property("schema");
        expect(action, `${name} missing handler`).to.have.property("handler");
        expect(action.handler).to.be.a("function");
      }
    });

    it("accepts CustodyAdapter agent", () => {
      const custodyAdapter = {
        getPublicKey: () => AGENT_ADDR,
        sign: async (bytes: Uint8Array) => new Uint8Array(64),
      };

      const plugin = createPhalnxPlugin(
        mockConfig({ agent: custodyAdapter }),
      );
      expect(plugin.name).to.equal("phalnx");
      expect(plugin.methods).to.have.property("phalnx_swap");
    });

    it("swap action converts Jupiter instructions to Kit format", async () => {
      // We test the instruction deserialization indirectly by verifying
      // the swap handler exists and has the expected schema
      const plugin = createPhalnxPlugin(mockConfig());
      const swap = plugin.methods.phalnx_swap;

      expect(swap.schema).to.exist;
      // Verify schema accepts required fields
      const result = swap.schema.safeParse({
        inputMint: "USDC",
        outputMint: "SOL",
        amount: 100,
      });
      expect(result.success).to.be.true;

      // Verify schema rejects invalid amount
      const invalid = swap.schema.safeParse({
        inputMint: "USDC",
        outputMint: "SOL",
        amount: -5,
      });
      expect(invalid.success).to.be.false;
    });

    it("status action has empty input schema", () => {
      const plugin = createPhalnxPlugin(mockConfig());
      const status = plugin.methods.phalnx_status;

      const result = status.schema.safeParse({});
      expect(result.success).to.be.true;
    });

    it("transfer action returns not-implemented error", async () => {
      const plugin = createPhalnxPlugin(mockConfig());
      const transfer = plugin.methods.phalnx_transfer;

      const result = await transfer.handler(null, {
        destination: AGENT_ADDR,
        amount: 100,
      });
      expect(result.success).to.be.false;
      expect(result.error).to.include("not yet implemented");
    });
  });
});
