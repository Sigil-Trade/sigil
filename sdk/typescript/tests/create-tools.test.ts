import { expect } from "chai";
import {
  createPhalnxTools,
  type PhalnxTool,
  type PluginName,
} from "../src/create-tools";
import { Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";

// Minimal wallet mock
function mockWallet() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: unknown) => tx,
    signAllTransactions: async (txs: unknown[]) => txs,
  };
}

// Use a dummy RPC URL (tools won't actually connect in these tests)
const RPC_URL = "https://api.devnet.solana.com";

describe("createPhalnxTools", () => {
  describe("default plugins", () => {
    it("returns defi tools by default", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      expect(tools).to.be.an("array");
      expect(tools.length).to.be.greaterThan(0);

      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_swap");
      expect(names).to.include("phalnx_transfer");
      expect(names).to.include("phalnx_deposit");
      expect(names).to.include("phalnx_withdraw");
      expect(names).to.include("phalnx_open_position");
      expect(names).to.include("phalnx_close_position");
    });

    it("does not include vault/escrow/policy/market tools by default", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      const names = tools.map((t) => t.name);
      expect(names).to.not.include("phalnx_check_vault");
      expect(names).to.not.include("phalnx_create_escrow");
      expect(names).to.not.include("phalnx_check_spending");
      expect(names).to.not.include("phalnx_get_prices");
    });
  });

  describe("plugin scoping", () => {
    it("loads vault tools", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["vault"],
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_check_vault");
      expect(names).to.not.include("phalnx_swap");
    });

    it("loads escrow tools", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["escrow"],
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_create_escrow");
      expect(names).to.include("phalnx_settle_escrow");
      expect(names).to.include("phalnx_refund_escrow");
    });

    it("loads policy tools", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["policy"],
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_check_spending");
    });

    it("loads market tools", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["market"],
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_get_prices");
      expect(names).to.include("phalnx_search_tokens");
    });

    it("loads multiple plugins", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["defi", "vault", "market"],
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_swap");
      expect(names).to.include("phalnx_check_vault");
      expect(names).to.include("phalnx_get_prices");
    });

    it("loads all plugins", () => {
      const allPlugins: PluginName[] = [
        "defi",
        "vault",
        "escrow",
        "policy",
        "market",
      ];
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: allPlugins,
      });
      expect(tools.length).to.be.greaterThanOrEqual(12);
    });
  });

  describe("permission scoping", () => {
    it("filters out disabled tools", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: ["defi"],
        permissions: {
          phalnx_swap: true,
          phalnx_transfer: false,
          phalnx_deposit: false,
        },
      });
      const names = tools.map((t) => t.name);
      expect(names).to.include("phalnx_swap");
      expect(names).to.not.include("phalnx_transfer");
      expect(names).to.not.include("phalnx_deposit");
    });

    it("enables all tools by default", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      expect(tools.length).to.be.greaterThan(0);
    });
  });

  describe("tool structure", () => {
    it("every tool has name, description, parameters, execute", () => {
      const allPlugins: PluginName[] = [
        "defi",
        "vault",
        "escrow",
        "policy",
        "market",
      ];
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        plugins: allPlugins,
      });

      for (const tool of tools) {
        expect(tool.name).to.be.a("string").with.length.greaterThan(0);
        expect(tool.name).to.match(/^phalnx_/);
        expect(tool.description).to.be.a("string").with.length.greaterThan(20);
        expect(tool.parameters).to.be.an("object");
        expect(tool.execute).to.be.a("function");
      }
    });

    it("parameters are Zod schemas", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      for (const tool of tools) {
        // Verify it's a ZodObject by checking for .shape
        expect(tool.parameters).to.have.property("shape");
        expect(tool.parameters).to.have.property("parse");
      }
    });

    it("swap tool schema validates correct input", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      const swapTool = tools.find((t) => t.name === "phalnx_swap");
      expect(swapTool).to.not.be.undefined;

      const parsed = swapTool!.parameters.parse({
        vault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputMint: "USDC",
        outputMint: "SOL",
        amount: "100",
        slippageBps: 50,
      });
      expect(parsed.vault).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
    });

    it("swap tool schema rejects invalid vault address", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      const swapTool = tools.find((t) => t.name === "phalnx_swap");

      expect(() =>
        swapTool!.parameters.parse({
          vault: "invalid",
          inputMint: "USDC",
          outputMint: "SOL",
          amount: "100",
        }),
      ).to.throw();
    });

    it("swap tool schema provides defaults for optional fields", () => {
      const tools = createPhalnxTools(mockWallet(), RPC_URL);
      const swapTool = tools.find((t) => t.name === "phalnx_swap");

      const parsed = swapTool!.parameters.parse({
        vault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputMint: "USDC",
        outputMint: "SOL",
        amount: "100",
      });
      expect(parsed.slippageBps).to.equal(50);
    });
  });

  describe("programId override", () => {
    it("accepts custom programId for devnet", () => {
      const customProgramId = Keypair.generate().publicKey;
      const tools = createPhalnxTools(mockWallet(), RPC_URL, {
        programId: customProgramId,
      });
      expect(tools.length).to.be.greaterThan(0);
    });
  });
});
