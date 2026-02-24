import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  agentShieldPlugin,
  getOrCreateShieldedWallet,
  getConfig,
  statusAction,
  updatePolicyAction,
  pauseResumeAction,
  transactionHistoryAction,
  shieldStatusProvider,
  spendTrackingProvider,
  policyCheckEvaluator,
  x402FetchAction,
} from "../src";

// --- Test Helpers ---

function createMockRuntime(overrides: Record<string, string> = {}) {
  const keypair = Keypair.generate();
  const settings: Record<string, string> = {
    SOLANA_WALLET_PRIVATE_KEY: JSON.stringify(Array.from(keypair.secretKey)),
    AGENT_SHIELD_MAX_SPEND: "500 USDC/day",
    AGENT_SHIELD_BLOCK_UNKNOWN: "true",
    ...overrides,
  };

  const logs: { level: string; args: any[] }[] = [];

  return {
    runtime: {
      getSetting: (key: string) => settings[key] || null,
      logger: {
        info: (...args: any[]) => logs.push({ level: "info", args }),
        warn: (...args: any[]) => logs.push({ level: "warn", args }),
        error: (...args: any[]) => logs.push({ level: "error", args }),
      },
    },
    logs,
    keypair,
  };
}

function captureCallback(): {
  responses: any[];
  callback: (response: any) => void;
} {
  const responses: any[] = [];
  return {
    responses,
    callback: (response: any) => responses.push(response),
  };
}

describe("ElizaOS Plugin", () => {
  describe("plugin definition", () => {
    it("has correct name and description", () => {
      expect(agentShieldPlugin.name).to.equal("agent-shield");
      expect(agentShieldPlugin.description).to.include("guardrails");
    });

    it("has 6 actions", () => {
      expect(agentShieldPlugin.actions).to.have.length(6);
    });

    it("has 2 providers", () => {
      expect(agentShieldPlugin.providers).to.have.length(2);
    });

    it("has 1 evaluator", () => {
      expect(agentShieldPlugin.evaluators).to.have.length(1);
    });

    it("includes all actions", () => {
      const names = agentShieldPlugin.actions.map((a: any) => a.name);
      expect(names).to.include("SHIELD_STATUS");
      expect(names).to.include("SHIELD_UPDATE_POLICY");
      expect(names).to.include("SHIELD_PAUSE_RESUME");
      expect(names).to.include("SHIELD_TRANSACTION_HISTORY");
      expect(names).to.include("SHIELD_X402_FETCH");
    });
  });

  describe("getConfig", () => {
    it("reads config from runtime settings", () => {
      const { runtime } = createMockRuntime();
      const config = getConfig(runtime);

      expect(config.maxSpend).to.equal("500 USDC/day");
      expect(config.blockUnknown).to.be.true;
      expect(config.walletPrivateKey).to.be.a("string");
    });

    it("throws if wallet private key is missing and no custody provider", () => {
      const runtime = {
        getSetting: () => null,
      };
      expect(() => getConfig(runtime)).to.throw();
    });

    it("defaults blockUnknown to true", () => {
      const { runtime } = createMockRuntime({
        AGENT_SHIELD_BLOCK_UNKNOWN: "",
      });
      const config = getConfig(runtime);
      expect(config.blockUnknown).to.be.true;
    });

    it("sets blockUnknown to false when 'false'", () => {
      const { runtime } = createMockRuntime({
        AGENT_SHIELD_BLOCK_UNKNOWN: "false",
      });
      const config = getConfig(runtime);
      expect(config.blockUnknown).to.be.false;
    });
  });

  describe("getOrCreateShieldedWallet", () => {
    it("creates a shielded wallet from runtime settings", async () => {
      const { runtime } = createMockRuntime();
      const { wallet, publicKey } = await getOrCreateShieldedWallet(runtime);

      expect(wallet).to.have.property("isPaused");
      expect(wallet).to.have.property("signTransaction");
      expect(wallet).to.have.property("getSpendingSummary");
      expect(publicKey).to.exist;
    });

    it("caches wallet per runtime instance", async () => {
      const { runtime } = createMockRuntime();
      const result1 = await getOrCreateShieldedWallet(runtime);
      const result2 = await getOrCreateShieldedWallet(runtime);
      expect(result1.wallet).to.equal(result2.wallet);
    });

    it("creates different wallets for different runtimes", async () => {
      const { runtime: rt1 } = createMockRuntime();
      const { runtime: rt2 } = createMockRuntime();
      const w1 = await getOrCreateShieldedWallet(rt1);
      const w2 = await getOrCreateShieldedWallet(rt2);
      expect(w1.wallet).to.not.equal(w2.wallet);
    });
  });

  describe("SHIELD_STATUS action", () => {
    it("validates with shield keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "Show shield status" } };
      const valid = await statusAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("rejects messages without keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "hello world" } };
      const valid = await statusAction.validate(runtime, message);
      expect(valid).to.be.false;
    });

    it("returns formatted status", async () => {
      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      await statusAction.handler(runtime, {}, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("AgentShield Status");
      expect(responses[0].text).to.include("Enforcement:");
    });
  });

  describe("SHIELD_UPDATE_POLICY action", () => {
    it("validates with policy keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "update policy limit" } };
      const valid = await updatePolicyAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("updates maxSpend", async () => {
      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      const message = {
        content: {
          text: "set budget to 1000 USDC/day",
          maxSpend: "1000 USDC/day",
        },
      };
      await updatePolicyAction.handler(runtime, message, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("policies updated");
      expect(responses[0].text).to.include("1000 USDC/day");
    });

    it("returns error when no changes specified", async () => {
      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      const message = { content: { text: "update policy" } };
      await updatePolicyAction.handler(runtime, message, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].error).to.be.true;
    });
  });

  describe("SHIELD_PAUSE_RESUME action", () => {
    it("validates with pause keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "pause shield enforcement" } };
      const valid = await pauseResumeAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("validates with resume keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "resume shield enforcement" } };
      const valid = await pauseResumeAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("rejects unrelated messages", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "what is the weather" } };
      const valid = await pauseResumeAction.validate(runtime, message);
      expect(valid).to.be.false;
    });

    it("pauses enforcement", async () => {
      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      const message = { content: { text: "pause shield" } };
      await pauseResumeAction.handler(runtime, message, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("paused");

      const { wallet } = await getOrCreateShieldedWallet(runtime);
      expect(wallet.isPaused).to.be.true;
    });

    it("resumes enforcement", async () => {
      const { runtime } = createMockRuntime();
      const { wallet } = await getOrCreateShieldedWallet(runtime);
      wallet.pause();

      const { responses, callback } = captureCallback();
      const message = { content: { text: "resume shield enforcement" } };
      await pauseResumeAction.handler(runtime, message, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("resumed");
      expect(wallet.isPaused).to.be.false;
    });
  });

  describe("SHIELD_TRANSACTION_HISTORY action", () => {
    it("validates with history keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "show transaction history" } };
      const valid = await transactionHistoryAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("returns formatted transaction history", async () => {
      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      await transactionHistoryAction.handler(runtime, {}, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("Transaction History");
      expect(responses[0].text).to.include("Per-Token Usage");
      expect(responses[0].text).to.include("Rate Limit");
    });
  });

  describe("SHIELD_X402_FETCH action", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("validates with x402 keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = {
        content: { text: "x402 fetch https://api.example.com/data" },
      };
      const valid = await x402FetchAction.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("rejects messages without x402 keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = { content: { text: "check the weather today" } };
      const valid = await x402FetchAction.validate(runtime, message);
      expect(valid).to.be.false;
    });

    it("returns error when no URL provided", async () => {
      globalThis.fetch = (async () =>
        new Response('{"ok":true}', { status: 200 })) as any;

      const { runtime } = createMockRuntime();
      const { responses, callback } = captureCallback();
      const message = { content: { text: "x402 fetch some api" } };
      await x402FetchAction.handler(runtime, message, null, null, callback);

      expect(responses).to.have.length(1);
      expect(responses[0].text).to.include("URL");
    });
  });

  describe("providers", () => {
    it("shieldStatusProvider returns status text", async () => {
      const { runtime } = createMockRuntime();
      const result = await shieldStatusProvider.get(runtime, {}, {});
      expect(result).to.have.property("text");
      expect(result.text).to.include("AgentShield");
    });

    it("spendTrackingProvider returns tracking data", async () => {
      const { runtime } = createMockRuntime();
      const result = await spendTrackingProvider.get(runtime, {}, {});
      expect(result).to.have.property("text");
    });
  });

  describe("evaluator", () => {
    it("policyCheckEvaluator has correct name", () => {
      expect(policyCheckEvaluator.name).to.equal("AGENT_SHIELD_POLICY_CHECK");
    });

    it("validates on shield keywords", async () => {
      const { runtime } = createMockRuntime();
      const message = {
        content: { text: "agentshield transaction completed" },
      };
      const valid = await policyCheckEvaluator.validate(runtime, message);
      expect(valid).to.be.true;
    });

    it("warns at exactly 80% cap usage", async () => {
      const { runtime } = createMockRuntime({
        AGENT_SHIELD_MAX_SPEND: "100 USDC/day",
      });
      const { wallet } = await getOrCreateShieldedWallet(runtime);

      // Manually record 80% spending via the state
      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      wallet.shieldState.recordSpend(usdcMint, BigInt(80_000_000)); // 80 USDC of 100 cap

      const result = await policyCheckEvaluator.handler(runtime, {});
      expect(result).to.not.be.null;
      expect(result!.text).to.include("WARNING");
      expect(result!.text).to.include("80%");
    });

    it("does not warn at 79% cap usage", async () => {
      const { runtime } = createMockRuntime({
        AGENT_SHIELD_MAX_SPEND: "100 USDC/day",
      });
      const { wallet } = await getOrCreateShieldedWallet(runtime);

      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      wallet.shieldState.recordSpend(usdcMint, BigInt(79_000_000)); // 79 USDC of 100 cap

      const result = await policyCheckEvaluator.handler(runtime, {});
      expect(result).to.be.null;
    });
  });

  describe("event callback wiring", () => {
    it("logs events via runtime logger", async () => {
      const { runtime, logs } = createMockRuntime();
      const { wallet } = await getOrCreateShieldedWallet(runtime);

      wallet.pause();
      const pauseLog = logs.find(
        (l) =>
          l.level === "info" &&
          l.args.some((a: any) => String(a).includes("paused")),
      );
      expect(pauseLog).to.exist;

      wallet.resume();
      const resumeLog = logs.find(
        (l) =>
          l.level === "info" &&
          l.args.some((a: any) => String(a).includes("resumed")),
      );
      expect(resumeLog).to.exist;

      wallet.updatePolicies({ maxSpend: "200 USDC/day" });
      const updateLog = logs.find(
        (l) =>
          l.level === "info" &&
          l.args.some((a: any) => String(a).includes("updated")),
      );
      expect(updateLog).to.exist;
    });
  });
});
