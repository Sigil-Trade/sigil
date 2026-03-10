import { expect } from "chai";
import {
  toAgentError,
  agentErrorFromCode,
  isAgentError,
  getAllOnChainErrorCodes,
  getAllSdkErrorCodes,
  type AgentError,
  type ErrorCategory,
} from "../src/agent-errors";

describe("agent-errors", () => {
  describe("toAgentError", () => {
    it("converts on-chain error with code property", () => {
      const result = toAgentError({ code: 6006 });
      expect(result.code).to.equal("6006");
      expect(result.category).to.equal("SPENDING_CAP");
      expect(result.retryable).to.be.true;
      expect(result.retry_after_ms).to.equal(3_600_000);
      expect(result.recovery_actions.length).to.be.greaterThan(0);
      expect(result.context).to.have.property("error_name", "DailyCapExceeded");
    });

    it("converts Anchor-format error", () => {
      const result = toAgentError({
        error: { errorCode: { number: 6047 } },
      });
      expect(result.code).to.equal("6047");
      expect(result.category).to.equal("PERMISSION");
      expect(result.retryable).to.be.false;
      expect(result.context).to.have.property(
        "error_name",
        "InsufficientPermissions",
      );
    });

    it("converts hex error from log message", () => {
      const result = toAgentError({
        message: "custom program error: 0x1776", // 6006
      });
      expect(result.code).to.equal("6006");
      expect(result.category).to.equal("SPENDING_CAP");
    });

    it("passes through existing AgentError", () => {
      const original: AgentError = {
        code: "TEST",
        message: "test error",
        category: "FATAL",
        retryable: false,
        recovery_actions: [],
        context: { foo: "bar" },
      };
      const result = toAgentError(original);
      expect(result).to.equal(original);
    });

    it("merges extra context", () => {
      const result = toAgentError({ code: 6000 }, { vault: "abc123" });
      expect(result.context).to.have.property("vault", "abc123");
      expect(result.context).to.have.property("error_name", "VaultNotActive");
    });

    it("handles null/undefined gracefully", () => {
      const result = toAgentError(null);
      expect(result.code).to.equal("UNKNOWN");
      expect(result.category).to.equal("FATAL");
    });

    it("handles string errors", () => {
      const result = toAgentError("something went wrong");
      expect(result.code).to.equal("UNKNOWN");
      expect(result.message).to.equal("something went wrong");
    });

    it("detects network errors from message", () => {
      const result = toAgentError(new Error("fetch failed: ECONNREFUSED"));
      expect(result.code).to.equal("NETWORK_ERROR");
      expect(result.category).to.equal("TRANSIENT");
      expect(result.retryable).to.be.true;
    });

    it("detects rate limit errors", () => {
      const result = toAgentError(new Error("429 Too Many Requests"));
      expect(result.code).to.equal("RATE_LIMITED");
      expect(result.category).to.equal("RATE_LIMIT");
      expect(result.retryable).to.be.true;
      expect(result.retry_after_ms).to.equal(10_000);
    });

    it("detects blockhash expired errors", () => {
      const result = toAgentError(new Error("blockhash not found"));
      expect(result.code).to.equal("BLOCKHASH_EXPIRED");
      expect(result.category).to.equal("TRANSIENT");
      expect(result.retryable).to.be.true;
    });

    it("detects simulation errors", () => {
      const result = toAgentError(new Error("Transaction simulation failed"));
      expect(result.code).to.equal("SIMULATION_FAILED");
      expect(result.retryable).to.be.true;
    });

    it("detects precheck errors", () => {
      const result = toAgentError(new Error("Precheck failed: spendingCap"));
      expect(result.code).to.equal("PRECHECK_FAILED");
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.retryable).to.be.false;
    });

    it("handles unknown on-chain codes gracefully", () => {
      const result = toAgentError({ code: 6999 });
      expect(result.code).to.equal("UNKNOWN");
      expect(result.category).to.equal("FATAL");
    });
  });

  describe("agentErrorFromCode", () => {
    it("resolves on-chain code", () => {
      const result = agentErrorFromCode("6047");
      expect(result.category).to.equal("PERMISSION");
      expect(result.recovery_actions.length).to.be.greaterThan(0);
    });

    it("resolves SDK code", () => {
      const result = agentErrorFromCode("NETWORK_ERROR");
      expect(result.category).to.equal("TRANSIENT");
      expect(result.retryable).to.be.true;
    });

    it("handles unknown code", () => {
      const result = agentErrorFromCode("DOES_NOT_EXIST");
      expect(result.code).to.equal("DOES_NOT_EXIST");
      expect(result.category).to.equal("FATAL");
    });

    it("passes context through", () => {
      const result = agentErrorFromCode("6006", { amount: "100" });
      expect(result.context).to.have.property("amount", "100");
    });
  });

  describe("isAgentError", () => {
    it("returns true for valid AgentError", () => {
      const err: AgentError = {
        code: "6006",
        message: "test",
        category: "SPENDING_CAP",
        retryable: true,
        recovery_actions: [],
        context: {},
      };
      expect(isAgentError(err)).to.be.true;
    });

    it("returns false for null", () => {
      expect(isAgentError(null)).to.be.false;
    });

    it("returns false for plain object missing fields", () => {
      expect(isAgentError({ code: "6006" })).to.be.false;
    });

    it("returns false for Error instance", () => {
      expect(isAgentError(new Error("test"))).to.be.false;
    });
  });

  describe("error code coverage", () => {
    it("maps all 71 on-chain error codes (6000-6070)", () => {
      const codes = getAllOnChainErrorCodes();
      expect(codes).to.have.length(71);
      expect(codes[0]).to.equal(6000);
      expect(codes[codes.length - 1]).to.equal(6070);

      // Verify continuous range
      for (let i = 0; i < codes.length; i++) {
        expect(codes[i]).to.equal(6000 + i);
      }
    });

    it("every on-chain code has valid category", () => {
      const validCategories: ErrorCategory[] = [
        "INPUT_VALIDATION",
        "TRANSIENT",
        "RATE_LIMIT",
        "PERMISSION",
        "RESOURCE_NOT_FOUND",
        "SPENDING_CAP",
        "POLICY_VIOLATION",
        "FATAL",
      ];

      for (let code = 6000; code <= 6070; code++) {
        const err = agentErrorFromCode(String(code));
        expect(validCategories).to.include(
          err.category,
          `Code ${code} has invalid category: ${err.category}`,
        );
      }
    });

    it("every on-chain code has a non-empty message", () => {
      for (let code = 6000; code <= 6070; code++) {
        const err = agentErrorFromCode(String(code));
        expect(err.message.length).to.be.greaterThan(
          0,
          `Code ${code} has empty message`,
        );
      }
    });

    it("every on-chain code has recovery_actions array", () => {
      for (let code = 6000; code <= 6070; code++) {
        const err = agentErrorFromCode(String(code));
        expect(Array.isArray(err.recovery_actions)).to.be.true;
        expect(err.recovery_actions.length).to.be.greaterThan(
          0,
          `Code ${code} has no recovery actions`,
        );
      }
    });

    it("has SDK error codes", () => {
      const codes = getAllSdkErrorCodes();
      expect(codes).to.include("NETWORK_ERROR");
      expect(codes).to.include("RATE_LIMITED");
      expect(codes).to.include("SIMULATION_FAILED");
      expect(codes).to.include("BLOCKHASH_EXPIRED");
      expect(codes).to.include("PRECHECK_FAILED");
      expect(codes).to.include("ADAPTER_VERIFICATION_FAILED");
      expect(codes).to.include("INTENT_VALIDATION_FAILED");
      expect(codes).to.include("RPC_ERROR");
    });
  });

  describe("category semantics", () => {
    it("SPENDING_CAP errors are retryable", () => {
      const capCodes = [6006, 6063, 6069];
      for (const code of capCodes) {
        const err = agentErrorFromCode(String(code));
        expect(err.category).to.equal("SPENDING_CAP");
        expect(err.retryable).to.be.true;
        expect(err.retry_after_ms).to.be.greaterThan(0);
      }
    });

    it("PERMISSION errors are not retryable", () => {
      const permCodes = [6001, 6002, 6010, 6047];
      for (const code of permCodes) {
        const err = agentErrorFromCode(String(code));
        expect(err.category).to.equal("PERMISSION");
        expect(err.retryable).to.be.false;
      }
    });

    it("FATAL errors are not retryable", () => {
      const fatalCodes = [6017, 6024, 6034, 6035, 6041, 6064, 6065, 6066];
      for (const code of fatalCodes) {
        const err = agentErrorFromCode(String(code));
        expect(err.category).to.equal("FATAL");
        expect(err.retryable).to.be.false;
      }
    });

    it("TRANSIENT SDK errors are retryable", () => {
      const transientCodes = [
        "NETWORK_ERROR",
        "RPC_ERROR",
        "SIMULATION_FAILED",
        "BLOCKHASH_EXPIRED",
      ];
      for (const code of transientCodes) {
        const err = agentErrorFromCode(code);
        expect(err.category).to.equal("TRANSIENT");
        expect(err.retryable).to.be.true;
      }
    });
  });

  describe("recovery actions", () => {
    it("DailyCapExceeded has reduce_amount, check_spending, and wait actions", () => {
      const err = agentErrorFromCode("6006");
      const actions = err.recovery_actions.map((a) => a.action);
      expect(actions).to.include("reduce_amount");
      expect(actions).to.include("check_spending");
      expect(actions).to.include("wait");
    });

    it("InsufficientPermissions has check_permissions action with tool reference", () => {
      const err = agentErrorFromCode("6047");
      const checkAction = err.recovery_actions.find(
        (a) => a.action === "check_permissions",
      );
      expect(checkAction).to.not.be.undefined;
      expect(checkAction!.tool).to.equal("phalnx_check_vault");
    });

    it("recovery actions have non-empty descriptions", () => {
      for (let code = 6000; code <= 6070; code++) {
        const err = agentErrorFromCode(String(code));
        for (const action of err.recovery_actions) {
          expect(action.action.length).to.be.greaterThan(
            0,
            `Code ${code}: empty action name`,
          );
          expect(action.description.length).to.be.greaterThan(
            0,
            `Code ${code}: empty description for ${action.action}`,
          );
        }
      }
    });
  });
});
