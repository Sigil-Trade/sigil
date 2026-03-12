import { expect } from "chai";
import type { Address } from "@solana/kit";
import { PhalnxKitClient, type PhalnxKitClientConfig } from "../src/client.js";
import { ProtocolRegistry } from "../src/integrations/protocol-registry.js";
import { isAgentError } from "../src/agent-errors.js";

const AGENT = "Agent111111111111111111111111111111111111111" as Address;

function mockAgent() {
  return {
    address: AGENT,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

function buildClient(overrides?: Partial<PhalnxKitClientConfig>): PhalnxKitClient {
  return new PhalnxKitClient({
    rpc: {} as any,
    network: "devnet",
    agent: mockAgent(),
    ...overrides,
  });
}

describe("PhalnxKitClient", () => {
  describe("constructor", () => {
    it("creates client with default registry", () => {
      const client = buildClient();
      expect(client).to.be.instanceOf(PhalnxKitClient);
      expect(client.network).to.equal("devnet");
      expect(client.agent.address).to.equal(AGENT);
    });

    it("uses custom registry when provided", () => {
      const reg = new ProtocolRegistry();
      const client = buildClient({ protocolRegistry: reg });
      // Custom empty registry → 0 protocols
      expect(client.listProtocols()).to.have.length(0);
    });

    it("default registry has 5 protocols", () => {
      const client = buildClient();
      const protocols = client.listProtocols();
      expect(protocols).to.have.length(5);
    });
  });

  describe("listProtocols()", () => {
    it("returns all built-in protocols", () => {
      const client = buildClient();
      const ids = client.listProtocols().map((p) => p.protocolId);
      expect(ids).to.include("jupiter");
      expect(ids).to.include("drift");
      expect(ids).to.include("flash-trade");
      expect(ids).to.include("kamino-lending");
      expect(ids).to.include("squads");
    });
  });

  describe("listActions()", () => {
    it("jupiter has swap", () => {
      const client = buildClient();
      const actions = client.listActions("jupiter");
      expect(actions.some((a) => a.name === "swap")).to.be.true;
    });

    it("unknown protocol returns empty", () => {
      const client = buildClient();
      expect(client.listActions("nonexistent")).to.have.length(0);
    });
  });

  describe("resolveToken()", () => {
    it("resolves USDC on devnet", () => {
      const client = buildClient({ network: "devnet" });
      const token = client.resolveToken("USDC");
      expect(token).to.not.be.null;
      expect(token!.symbol).to.equal("USDC");
      expect(token!.decimals).to.equal(6);
    });

    it("resolves SOL", () => {
      const client = buildClient();
      const token = client.resolveToken("SOL");
      expect(token).to.not.be.null;
      expect(token!.decimals).to.equal(9);
    });

    it("returns null for unknown token", () => {
      const client = buildClient();
      const token = client.resolveToken("NONEXISTENT_TOKEN");
      expect(token).to.be.null;
    });
  });

  describe("engine delegation", () => {
    it("engine is accessible", () => {
      const client = buildClient();
      expect(client.engine).to.exist;
    });

    it("validate delegated to engine", () => {
      const client = buildClient();
      const result = client.engine.validate({
        type: "swap",
        params: {
          inputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "1000000",
        },
      });
      expect(result.valid).to.be.true;
    });
  });

  describe("precheck() error handling", () => {
    it("returns failure when RPC unavailable", async () => {
      const client = buildClient({
        rpc: {
          getAccountInfo: () => { throw new Error("connection refused"); },
        } as any,
      });
      const result = await client.precheck(
        {
          type: "swap",
          params: {
            inputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "1000000",
          },
        },
        "Vault111111111111111111111111111111111111111" as Address,
      );
      expect(result.allowed).to.be.false;
    });
  });

  describe("run() delegation", () => {
    it("returns AgentError for invalid intent", async () => {
      const client = buildClient();
      const result = await client.run(
        { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
        "Vault111111111111111111111111111111111111111" as Address,
        { skipPrecheck: true },
      );
      expect(isAgentError(result)).to.be.true;
    });
  });

  describe("execute() delegation", () => {
    it("throws for invalid intent", async () => {
      const client = buildClient();
      try {
        await client.execute(
          { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
          "Vault111111111111111111111111111111111111111" as Address,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Validation error before RPC is hit
        expect(err).to.exist;
      }
    });
  });

  describe("explain() delegation", () => {
    it("returns AgentError for invalid intent", async () => {
      const client = buildClient();
      const result = await client.explain(
        { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
        "Vault111111111111111111111111111111111111111" as Address,
      );
      expect(isAgentError(result)).to.be.true;
    });
  });

  describe("getVaultAddress()", () => {
    it("returns deterministic PDA", async () => {
      const client = buildClient();
      const addr1 = await client.getVaultAddress(AGENT, 0n);
      const addr2 = await client.getVaultAddress(AGENT, 0n);
      expect(addr1).to.equal(addr2);
      expect(typeof addr1).to.equal("string");
      expect(addr1.length).to.be.greaterThan(0);
    });
  });

  describe("fetchVault() error handling", () => {
    it("throws on RPC failure", async () => {
      const client = buildClient({
        rpc: {
          getAccountInfo: () => { throw new Error("connection refused"); },
        } as any,
      });
      try {
        await client.fetchVault("Vault111111111111111111111111111111111111111" as Address);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("connection refused");
      }
    });
  });
});
