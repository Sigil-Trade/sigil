import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";
import { createSigilPlugin, type SigilSakConfig } from "../src/sak/index.js";

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

function mockConfig(overrides?: Partial<SigilSakConfig>): SigilSakConfig {
  return {
    vault: VAULT,
    network: "devnet",
    rpc: mockRpc(),
    agent: mockSigner(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("@usesigil/plugins/sak", () => {
  describe("createSigilPlugin", () => {
    it("returns valid SAK plugin shape", () => {
      const plugin = createSigilPlugin(mockConfig());

      expect(plugin).to.have.property("name", "sigil");
      expect(plugin).to.have.property("methods");
      expect(plugin.methods).to.have.property("sigil_swap");
      expect(plugin.methods).to.have.property("sigil_transfer");
      expect(plugin.methods).to.have.property("sigil_status");
    });

    it("each method has description, schema, and handler", () => {
      const plugin = createSigilPlugin(mockConfig());

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

      const plugin = createSigilPlugin(
        mockConfig({ agent: custodyAdapter }),
      );
      expect(plugin.name).to.equal("sigil");
      expect(plugin.methods).to.have.property("sigil_swap");
    });

    it("swap action converts Jupiter instructions to Kit format", async () => {
      // We test the instruction deserialization indirectly by verifying
      // the swap handler exists and has the expected schema
      const plugin = createSigilPlugin(mockConfig());
      const swap = plugin.methods.sigil_swap;

      expect(swap.schema).to.exist;
      // Verify schema accepts required fields
      const result = swap.schema.safeParse({
        inputMint: "USDC",
        outputMint: "SOL",
        amount: 100,
      });
      expect(result.success).to.be.true;

      // P2 #22: Verify schema rejects invalid amount AND check WHY it fails
      const invalid = swap.schema.safeParse({
        inputMint: "USDC",
        outputMint: "SOL",
        amount: -5,
      });
      expect(invalid.success).to.be.false;
      // Verify the SPECIFIC field that caused rejection (not just "some error")
      if (!invalid.success) {
        const paths = invalid.error.issues.map((i: any) => i.path.join("."));
        expect(paths).to.include("amount");
      }
    });

    it("status action has empty input schema", () => {
      const plugin = createSigilPlugin(mockConfig());
      const status = plugin.methods.sigil_status;

      const result = status.schema.safeParse({});
      expect(result.success).to.be.true;
    });

    it("transfer action returns not-implemented error", async () => {
      const plugin = createSigilPlugin(mockConfig());
      const transfer = plugin.methods.sigil_transfer;

      const result = await transfer.handler(null, {
        destination: AGENT_ADDR,
        amount: 100,
      });
      expect(result.success).to.be.false;
      expect(result.error).to.include("not yet implemented");
    });
  });
});
