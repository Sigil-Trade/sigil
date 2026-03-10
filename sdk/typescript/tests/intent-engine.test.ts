import { expect } from "chai";
import { IntentEngine } from "../src/intent-engine";
import type { PhalnxClient } from "../src/client";
import type {
  IntentAction,
  PrecheckResult,
  ExecuteResult,
} from "../src/intents";
import { isAgentError, type AgentError } from "../src/agent-errors";
import { PublicKey } from "@solana/web3.js";

// Mock PhalnxClient with minimal interface
function createMockClient(overrides?: {
  precheck?: (
    intent: IntentAction,
    vault: PublicKey,
  ) => Promise<PrecheckResult>;
  execute?: (
    intent: IntentAction,
    vault: PublicKey,
    options?: unknown,
  ) => Promise<ExecuteResult>;
}): PhalnxClient {
  const mockPrecheck: PrecheckResult = {
    allowed: true,
    details: {
      permission: { passed: true, requiredBit: "0", agentHas: true },
      protocol: { passed: true, inAllowlist: true },
    },
    summary: "All checks passed",
    riskFlags: [],
  };

  const mockExecuteResult: ExecuteResult = {
    signature: "mock-sig-123",
    intent: {
      type: "swap",
      params: { inputMint: "USDC", outputMint: "SOL", amount: "100" },
    },
    summary: "Swapped 100 USDC → SOL",
  };

  return {
    precheck: overrides?.precheck ?? (async () => mockPrecheck),
    execute: overrides?.execute ?? (async () => mockExecuteResult),
    _protocolRegistry: {
      listAll: () => [],
      getByProtocolId: () => undefined,
    },
  } as unknown as PhalnxClient;
}

const MOCK_VAULT = new PublicKey("11111111111111111111111111111111");

describe("IntentEngine", () => {
  describe("validate", () => {
    it("returns valid for well-formed intent", () => {
      const engine = new IntentEngine(createMockClient());
      const result = engine.validate({
        type: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "100",
        },
      });
      expect(result.valid).to.be.true;
      expect(result.errors).to.have.length(0);
    });

    it("returns errors for invalid intent", () => {
      const engine = new IntentEngine(createMockClient());
      const result = engine.validate({
        type: "swap",
        params: {
          inputMint: "invalid",
          outputMint: "",
          amount: "-50",
        },
      });
      expect(result.valid).to.be.false;
      expect(result.errors.length).to.be.greaterThan(0);
    });
  });

  describe("run", () => {
    it("returns ExecuteResult on success", async () => {
      const engine = new IntentEngine(createMockClient());
      const result = await engine.run(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
      );

      expect(isAgentError(result)).to.be.false;
      const execResult = result as ExecuteResult;
      expect(execResult.signature).to.equal("mock-sig-123");
    });

    it("returns AgentError on validation failure", async () => {
      const engine = new IntentEngine(createMockClient());
      const result = await engine.run(
        {
          type: "swap",
          params: {
            inputMint: "invalid",
            outputMint: "",
            amount: "-50",
          },
        },
        MOCK_VAULT,
      );

      expect(isAgentError(result)).to.be.true;
      const err = result as AgentError;
      expect(err.category).to.equal("INPUT_VALIDATION");
    });

    it("returns AgentError on precheck failure", async () => {
      const client = createMockClient({
        precheck: async () => ({
          allowed: false,
          reason: "Daily cap exceeded",
          details: {
            permission: { passed: true, requiredBit: "0", agentHas: true },
            protocol: { passed: true, inAllowlist: true },
            spendingCap: {
              passed: false,
              spent24h: 900,
              cap: 1000,
              remaining: 100,
            },
          },
          summary: "Spending cap check failed",
          riskFlags: ["cap_near_limit"],
        }),
      });

      const engine = new IntentEngine(client);
      const result = await engine.run(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
      );

      expect(isAgentError(result)).to.be.true;
    });

    it("returns AgentError on execute failure", async () => {
      const client = createMockClient({
        execute: async () => {
          throw new Error("custom program error: 0x1776"); // 6006 DailyCapExceeded
        },
      });

      const engine = new IntentEngine(client);
      const result = await engine.run(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
      );

      expect(isAgentError(result)).to.be.true;
      const err = result as AgentError;
      expect(err.code).to.equal("6006");
      expect(err.category).to.equal("SPENDING_CAP");
    });

    it("skips precheck when skipPrecheck=true", async () => {
      let precheckCalled = false;
      const client = createMockClient({
        precheck: async () => {
          precheckCalled = true;
          return {
            allowed: false,
            details: {
              permission: { passed: false, requiredBit: "0", agentHas: false },
              protocol: { passed: true, inAllowlist: true },
            },
            summary: "Permission denied",
            riskFlags: [],
          };
        },
      });

      const engine = new IntentEngine(client);
      const result = await engine.run(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
        { skipPrecheck: true },
      );

      expect(precheckCalled).to.be.false;
      expect(isAgentError(result)).to.be.false;
    });
  });

  describe("precheck", () => {
    it("delegates to client.precheck", async () => {
      const engine = new IntentEngine(createMockClient());
      const result = await engine.precheck(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
      );
      expect(result.allowed).to.be.true;
    });
  });

  describe("explain", () => {
    it("returns ExplainResult on success", async () => {
      const engine = new IntentEngine(createMockClient());
      const result = await engine.explain(
        {
          type: "swap",
          params: {
            inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            outputMint: "So11111111111111111111111111111111111111112",
            amount: "100",
          },
        },
        MOCK_VAULT,
      );

      if (isAgentError(result)) {
        expect.fail("Expected ExplainResult, got AgentError");
      }
      expect(result.actionType).to.equal("swap");
      expect(result.isSpending).to.be.true;
      expect(result.precheck.allowed).to.be.true;
      expect(result.summary).to.be.a("string");
    });

    it("returns AgentError on validation failure", async () => {
      const engine = new IntentEngine(createMockClient());
      const result = await engine.explain(
        {
          type: "swap",
          params: {
            inputMint: "invalid",
            outputMint: "",
            amount: "-50",
          },
        },
        MOCK_VAULT,
      );

      expect(isAgentError(result)).to.be.true;
    });
  });

  describe("listProtocols", () => {
    it("returns empty array when no protocols registered", () => {
      const engine = new IntentEngine(createMockClient());
      const protocols = engine.listProtocols();
      expect(protocols).to.be.an("array");
      expect(protocols).to.have.length(0);
    });
  });

  describe("listActions", () => {
    it("returns empty array for unknown protocol", () => {
      const engine = new IntentEngine(createMockClient());
      const actions = engine.listActions("unknown-protocol");
      expect(actions).to.be.an("array");
      expect(actions).to.have.length(0);
    });
  });
});
