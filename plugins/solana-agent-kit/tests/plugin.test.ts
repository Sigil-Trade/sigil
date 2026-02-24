import { expect } from "chai";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { WalletLike, ShieldedWallet } from "@agent-shield/sdk";
import { shieldWallet } from "@agent-shield/sdk";
import {
  createAgentShieldPlugin,
  createShieldedWallet,
  resolveWallet,
  status,
  statusSchema,
  updatePolicy,
  updatePolicySchema,
  pauseResume,
  pauseResumeSchema,
  transactionHistory,
  transactionHistorySchema,
  x402Fetch,
  x402FetchSchema,
} from "../src";

// --- Test Helpers ---

function createMockWallet(): WalletLike {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      return tx;
    },
  };
}

describe("SAK Plugin", () => {
  describe("createAgentShieldPlugin", () => {
    it("creates plugin with pre-created ShieldedWallet", () => {
      const wallet = shieldWallet(createMockWallet(), {
        maxSpend: "100 USDC/day",
      });
      const plugin = createAgentShieldPlugin({ wallet });

      expect(plugin.name).to.equal("agent-shield");
      expect(plugin.methods).to.have.property("shield_status");
      expect(plugin.methods).to.have.property("shield_update_policy");
      expect(plugin.methods).to.have.property("shield_pause_resume");
      expect(plugin.methods).to.have.property("shield_transaction_history");
    });

    it("creates plugin with rawWallet + policies (factory)", () => {
      const plugin = createAgentShieldPlugin({
        rawWallet: createMockWallet(),
        policies: { maxSpend: "500 USDC/day" },
      });

      expect(plugin.name).to.equal("agent-shield");
      expect(plugin.methods).to.have.property("shield_status");
      expect(plugin.methods).to.have.property("shield_transaction_history");
    });

    it("throws if neither wallet nor rawWallet provided", () => {
      expect(() => createAgentShieldPlugin({} as any)).to.throw(
        "config must provide either",
      );
    });

    it("has 6 methods", () => {
      const wallet = shieldWallet(createMockWallet());
      const plugin = createAgentShieldPlugin({ wallet });
      expect(Object.keys(plugin.methods)).to.have.length(6);
    });

    it("includes shield_x402_fetch method", () => {
      const wallet = shieldWallet(createMockWallet());
      const plugin = createAgentShieldPlugin({ wallet });
      expect(plugin.methods).to.have.property("shield_x402_fetch");
    });
  });

  describe("resolveWallet", () => {
    it("returns wallet directly if provided", () => {
      const wallet = shieldWallet(createMockWallet());
      const resolved = resolveWallet({ wallet });
      expect(resolved.wallet).to.equal(wallet);
    });

    it("creates ShieldedWallet from rawWallet", () => {
      const raw = createMockWallet();
      const resolved = resolveWallet({
        rawWallet: raw,
        policies: { maxSpend: "100 USDC/day" },
      });
      expect(resolved.wallet).to.have.property("isPaused");
      expect(resolved.wallet).to.have.property("innerWallet");
      expect(resolved.wallet.innerWallet).to.equal(raw);
    });

    it("throws without wallet or rawWallet", () => {
      expect(() => resolveWallet({} as any)).to.throw();
    });
  });

  describe("createShieldedWallet (factory)", () => {
    it("creates a ShieldedWallet from raw wallet", () => {
      const raw = createMockWallet();
      const wallet = createShieldedWallet({ wallet: raw });
      expect(wallet.publicKey.equals(raw.publicKey)).to.be.true;
      expect(wallet.isPaused).to.be.false;
    });

    it("wires event callbacks to logger", () => {
      const logs: string[] = [];
      const logger = {
        info: (...args: any[]) => logs.push(args.join(" ")),
        warn: (...args: any[]) => logs.push("WARN:" + args.join(" ")),
      };

      const wallet = createShieldedWallet({
        wallet: createMockWallet(),
        policies: { maxSpend: "100 USDC/day" },
        logger,
      });

      wallet.pause();
      expect(logs.some((l) => l.includes("paused"))).to.be.true;

      wallet.resume();
      expect(logs.some((l) => l.includes("resumed"))).to.be.true;

      wallet.updatePolicies({ maxSpend: "200 USDC/day" });
      expect(logs.some((l) => l.includes("updated"))).to.be.true;
    });

    it("applies policies correctly", () => {
      const wallet = createShieldedWallet({
        wallet: createMockWallet(),
        policies: { maxSpend: "500 USDC/day" },
      });

      const summary = wallet.getSpendingSummary();
      expect(summary.tokens.length).to.be.greaterThan(0);
    });
  });

  describe("shield_status tool", () => {
    it("returns formatted status string", async () => {
      const wallet = shieldWallet(createMockWallet(), {
        maxSpend: "100 USDC/day",
      });
      const config = { wallet };

      const result = await status(null, config, {});
      expect(result).to.include("AgentShield Status");
      expect(result).to.include("Spending Limits");
      expect(result).to.include("Rate Limit");
    });

    it("shows paused state", async () => {
      const wallet = shieldWallet(createMockWallet());
      wallet.pause();
      const result = await status(null, { wallet }, {});
      expect(result).to.include("Paused: true");
    });

    it("validates schema", () => {
      const parsed = statusSchema.safeParse({});
      expect(parsed.success).to.be.true;
    });
  });

  describe("shield_update_policy tool", () => {
    it("updates maxSpend", async () => {
      const wallet = shieldWallet(createMockWallet(), {
        maxSpend: "100 USDC/day",
      });
      const result = await updatePolicy(
        null,
        { wallet },
        {
          maxSpend: "500 USDC/day",
        },
      );
      expect(result).to.include("policies updated");
      expect(result).to.include("500 USDC/day");
    });

    it("updates blockUnknownPrograms", async () => {
      const wallet = shieldWallet(createMockWallet());
      const result = await updatePolicy(
        null,
        { wallet },
        {
          blockUnknownPrograms: false,
        },
      );
      expect(result).to.include("blockUnknownPrograms: false");
    });

    it("validates schema", () => {
      const parsed = updatePolicySchema.safeParse({
        maxSpend: "500 USDC/day",
      });
      expect(parsed.success).to.be.true;
    });
  });

  describe("shield_pause_resume tool", () => {
    it("pauses enforcement", async () => {
      const wallet = shieldWallet(createMockWallet());
      const result = await pauseResume(
        null,
        { wallet },
        {
          action: "pause",
        },
      );
      expect(result).to.include("paused");
      expect(wallet.isPaused).to.be.true;
    });

    it("resumes enforcement", async () => {
      const wallet = shieldWallet(createMockWallet());
      wallet.pause();
      const result = await pauseResume(
        null,
        { wallet },
        {
          action: "resume",
        },
      );
      expect(result).to.include("resumed");
      expect(wallet.isPaused).to.be.false;
    });

    it("validates schema", () => {
      const valid = pauseResumeSchema.safeParse({ action: "pause" });
      expect(valid.success).to.be.true;

      const invalid = pauseResumeSchema.safeParse({ action: "toggle" });
      expect(invalid.success).to.be.false;
    });
  });

  describe("shield_transaction_history tool", () => {
    it("returns formatted transaction history", async () => {
      const wallet = shieldWallet(createMockWallet(), {
        maxSpend: "100 USDC/day",
      });
      const result = await transactionHistory(null, { wallet }, {});
      expect(result).to.include("Transaction History");
      expect(result).to.include("Per-Token Usage");
      expect(result).to.include("Rate Limit");
    });

    it("shows enforcement state", async () => {
      const wallet = shieldWallet(createMockWallet());
      const result = await transactionHistory(null, { wallet }, {});
      expect(result).to.include("Enforcement: ACTIVE");
    });

    it("handles no spending limits", async () => {
      const wallet = shieldWallet(createMockWallet(), {
        maxSpend: [],
        blockUnknownPrograms: false,
      });
      const result = await transactionHistory(null, { wallet }, {});
      expect(result).to.include("No spending limits configured");
    });

    it("validates schema", () => {
      const parsed = transactionHistorySchema.safeParse({});
      expect(parsed.success).to.be.true;
    });
  });

  describe("shield_x402_fetch tool", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns non-402 responses directly", async () => {
      globalThis.fetch = (async () =>
        new Response('{"ok":true}', { status: 200 })) as any;

      const wallet = shieldWallet(createMockWallet());
      const result = await x402Fetch(
        null,
        { wallet },
        {
          url: "https://example.com/free",
        },
      );
      expect(result).to.include("Status: 200");
      expect(result).to.include("x402 Fetch Result");
    });

    it("returns 402 without payment header as-is", async () => {
      globalThis.fetch = (async () =>
        new Response("Payment Required", { status: 402 })) as any;

      const wallet = shieldWallet(createMockWallet());
      const result = await x402Fetch(
        null,
        { wallet },
        {
          url: "https://example.com/plain-402",
        },
      );
      expect(result).to.include("Status: 402");
    });

    it("validates schema", () => {
      const parsed = x402FetchSchema.safeParse({
        url: "https://example.com/api",
      });
      expect(parsed.success).to.be.true;
    });
  });

  describe("schema validation edge cases", () => {
    it("pauseResumeSchema rejects invalid action string", () => {
      const invalid = pauseResumeSchema.safeParse({ action: "invalid" });
      expect(invalid.success).to.be.false;
    });

    it("double-pause → idempotent (still paused)", async () => {
      const wallet = shieldWallet(createMockWallet());
      await pauseResume(null, { wallet }, { action: "pause" });
      expect(wallet.isPaused).to.be.true;

      // Pause again
      const result = await pauseResume(null, { wallet }, { action: "pause" });
      expect(wallet.isPaused).to.be.true;
      expect(result).to.include("paused");
    });
  });
});
