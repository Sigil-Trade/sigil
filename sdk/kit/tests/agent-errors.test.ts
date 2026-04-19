import { expect } from "chai";
import {
  ON_CHAIN_ERROR_MAP,
  toAgentError,
  toSigilAgentError,
  SigilSdkError,
  protocolEscalationError,
  parseOnChainErrorCode,
  isAgentError,
  getAllOnChainErrorCodes,
  getAllSdkErrorCodes,
} from "../src/agent-errors.js";
import type { AgentError } from "../src/agent-errors.js";
import * as generatedErrors from "../src/generated/errors/sigil.js";

describe("agent-errors", () => {
  // ─── On-chain error map completeness ──────────────────────────────────────

  describe("ON_CHAIN_ERROR_MAP completeness", () => {
    it("maps all 85 error codes (6000-6084)", () => {
      const codes = getAllOnChainErrorCodes();
      expect(codes).to.have.lengthOf(85);
      expect(codes[0]).to.equal(6000);
      expect(codes[codes.length - 1]).to.equal(6084);
    });

    it("every code from 6000-6084 is present with no gaps", () => {
      for (let code = 6000; code <= 6084; code++) {
        const entry = ON_CHAIN_ERROR_MAP[code];
        expect(entry, `Missing error code ${code}`).to.exist;
        expect(entry.name).to.be.a("string").and.not.be.empty;
        expect(entry.message).to.be.a("string").and.not.be.empty;
        expect(entry.category).to.be.a("string");
        expect(entry.retryable).to.be.a("boolean");
        expect(entry.recovery_actions).to.be.an("array").and.not.be.empty;
      }
    });

    // Drift guard — catches the failure mode that required this PR.
    // ON_CHAIN_ERROR_MAP is hand-maintained; generated/errors/sigil.ts is
    // authoritative. If Rust adds a new error, the generated constants
    // update but this map stays stale until manually synced. This test
    // fails the moment those counts diverge, forcing the sync.
    it("matches the count of SIGIL_ERROR__* constants in generated code", () => {
      const generatedCodeCount = Object.keys(generatedErrors).filter(
        (k) =>
          k.startsWith("SIGIL_ERROR__") &&
          typeof (generatedErrors as Record<string, unknown>)[k] === "number",
      ).length;
      const handMaintainedCount = getAllOnChainErrorCodes().length;
      expect(handMaintainedCount).to.equal(
        generatedCodeCount,
        `ON_CHAIN_ERROR_MAP has ${handMaintainedCount} entries but generated code has ${generatedCodeCount} SIGIL_ERROR__* numeric constants — sync required`,
      );
    });

    // Drift guard — ensures the highest numeric code in ON_CHAIN_ERROR_MAP
    // matches the highest in generated. Catches the specific drift mode
    // where Rust adds errors at the end of the enum but the hand map's
    // upper-bound range check was not updated.
    it("upper-bound code matches highest generated SIGIL_ERROR__* code", () => {
      const generatedCodes = Object.entries(generatedErrors)
        .filter(
          ([k, v]) => k.startsWith("SIGIL_ERROR__") && typeof v === "number",
        )
        .map(([, v]) => v as number);
      const maxGenerated = Math.max(...generatedCodes);
      const codes = getAllOnChainErrorCodes();
      expect(codes[codes.length - 1]).to.equal(
        maxGenerated,
        `ON_CHAIN_ERROR_MAP max is ${codes[codes.length - 1]} but generated max is ${maxGenerated}`,
      );
    });
  });

  // ─── parseOnChainErrorCode ────────────────────────────────────────────────

  describe("parseOnChainErrorCode", () => {
    it("parses numeric code 6000 (VaultNotActive)", () => {
      const err = parseOnChainErrorCode(6000);
      expect(err).to.not.be.null;
      expect(err!.code).to.equal("6000");
      expect(err!.category).to.equal("RESOURCE_NOT_FOUND");
      expect(err!.context.error_name).to.equal("VaultNotActive");
    });

    it("parses numeric code 6069 (UnauthorizedPostFinalizeInstruction)", () => {
      const err = parseOnChainErrorCode(6069);
      expect(err).to.not.be.null;
      expect(err!.code).to.equal("6069");
      expect(err!.category).to.equal("POLICY_VIOLATION");
      expect(err!.context.error_name).to.equal(
        "UnauthorizedPostFinalizeInstruction",
      );
    });

    it("parses hex string 0x1770 (= 6000)", () => {
      const err = parseOnChainErrorCode("0x1770");
      expect(err).to.not.be.null;
      expect(err!.code).to.equal("6000");
      expect(err!.context.error_name).to.equal("VaultNotActive");
    });

    it("parses hex string 0x17AD (= 6061 ProtocolCapExceeded)", () => {
      const err = parseOnChainErrorCode("0x17AD");
      expect(err).to.not.be.null;
      expect(err!.code).to.equal("6061");
      expect(err!.context.error_name).to.equal("ProtocolCapExceeded");
    });

    it("parses decimal string '6044'", () => {
      const err = parseOnChainErrorCode("6044");
      expect(err).to.not.be.null;
      expect(err!.code).to.equal("6044");
      expect(err!.category).to.equal("INPUT_VALIDATION");
    });

    it("returns null for unknown code 9999", () => {
      const err = parseOnChainErrorCode(9999);
      expect(err).to.be.null;
    });

    it("returns null for invalid string", () => {
      const err = parseOnChainErrorCode("not-a-number");
      expect(err).to.be.null;
    });

    it("retryable errors include retry_after_ms", () => {
      const dailyCap = parseOnChainErrorCode(6006);
      expect(dailyCap).to.not.be.null;
      expect(dailyCap!.retryable).to.be.true;
      expect(dailyCap!.retry_after_ms).to.equal(3_600_000);

      const timelockNotExpired = parseOnChainErrorCode(6026);
      expect(timelockNotExpired).to.not.be.null;
      expect(timelockNotExpired!.retryable).to.be.true;
      expect(timelockNotExpired!.retry_after_ms).to.equal(60_000);
    });

    it("non-retryable errors do not include retry_after_ms", () => {
      const overflow = parseOnChainErrorCode(6024);
      expect(overflow).to.not.be.null;
      expect(overflow!.retryable).to.be.false;
      expect(overflow!.retry_after_ms).to.be.undefined;
    });
  });

  // ─── toAgentError ─────────────────────────────────────────────────────────

  describe("toAgentError", () => {
    it("converts an Error with Anchor hex code in message", () => {
      const err = new Error("custom program error: 0x1771");
      const agent = toAgentError(err);
      expect(agent.code).to.equal("6001");
      expect(agent.category).to.equal("PERMISSION");
      expect(agent.context.error_name).to.equal("UnauthorizedAgent");
    });

    it("converts a plain string to UNKNOWN", () => {
      const agent = toAgentError("something broke");
      expect(agent.code).to.equal("UNKNOWN");
      expect(agent.message).to.equal("something broke");
      expect(agent.category).to.equal("FATAL");
      expect(agent.retryable).to.be.false;
    });

    it("passes through an existing AgentError", () => {
      const existing: AgentError = {
        code: "6010",
        message: "Session not authorized",
        category: "PERMISSION",
        retryable: false,
        recovery_actions: [],
        context: { test: true },
      };
      const result = toAgentError(existing);
      expect(result).to.equal(existing);
    });

    it("converts unknown value to UNKNOWN", () => {
      const agent = toAgentError(42);
      expect(agent.code).to.equal("UNKNOWN");
      expect(agent.category).to.equal("FATAL");
    });

    it("converts null to UNKNOWN", () => {
      const agent = toAgentError(null);
      expect(agent.code).to.equal("UNKNOWN");
      expect(agent.message).to.equal("An unknown error occurred");
    });

    it("converts object with code property in on-chain range", () => {
      const err = { code: 6024, message: "Overflow" };
      const agent = toAgentError(err);
      expect(agent.code).to.equal("6024");
      expect(agent.category).to.equal("FATAL");
      expect(agent.context.error_name).to.equal("Overflow");
    });

    it("merges extraContext", () => {
      const err = { code: 6005 };
      const agent = toAgentError(err, { vault: "abc123" });
      expect(agent.context.vault).to.equal("abc123");
      expect(agent.context.error_name).to.equal("TransactionTooLarge");
    });

    it("detects network errors from message patterns", () => {
      const err = new Error("ECONNREFUSED 127.0.0.1:8899");
      const agent = toAgentError(err);
      expect(agent.code).to.equal("NETWORK_ERROR");
      expect(agent.category).to.equal("TRANSIENT");
      expect(agent.retryable).to.be.true;
    });

    it("detects simulation errors from message patterns", () => {
      const err = new Error("SimulateTransaction failed");
      const agent = toAgentError(err);
      expect(agent.code).to.equal("SIMULATION_FAILED");
      expect(agent.retryable).to.be.true;
    });

    it("converts SDK numeric code 7003 (DRAIN_DETECTED)", () => {
      const err = { code: 7003, message: "Drain detected" };
      const agent = toAgentError(err);
      expect(agent.code).to.equal("DRAIN_DETECTED");
      expect(agent.category).to.equal("FATAL");
      expect(agent.retryable).to.be.false;
    });
  });

  // ─── SDK error codes ──────────────────────────────────────────────────────

  describe("SDK error codes (7000-7033)", () => {
    it("getAllSdkErrorCodes returns 34 entries", () => {
      const codes = getAllSdkErrorCodes();
      expect(codes).to.have.lengthOf(34);
      expect(codes[0].code).to.equal(7000);
      expect(codes[codes.length - 1].code).to.equal(7033);
    });

    it("all 34 SDK codes map to valid error names", () => {
      const codes = getAllSdkErrorCodes();
      const expectedNames = [
        "NETWORK_ERROR",
        "RPC_ERROR",
        "SIMULATION_FAILED",
        "DRAIN_DETECTED",
        "INTENT_VALIDATION_FAILED",
        "INTENT_EXPIRED",
        "PROTOCOL_NOT_SUPPORTED",
        "ADAPTER_VERIFICATION_FAILED",
        "PRECHECK_FAILED",
        "EXECUTION_FAILED",
        "TRANSACTION_TIMEOUT",
        "CONFIRMATION_TIMEOUT",
        "INSUFFICIENT_FUNDS",
        "SLIPPAGE_EXCEEDED",
        "TEE_VERIFICATION_FAILED",
        "SHIELD_DENIED",
        "SIMULATION_TIMEOUT",
        "BLOCKHASH_EXPIRED",
        "CODAMA_DECODE_FAILED",
        "CODAMA_VERSION_MISMATCH",
        "COMPAT_BRIDGE_FAILED",
        "INTENT_DRIFT_DETECTED",
        "VELOCITY_EXCEEDED",
        "AGENT_DEFENSE_TRIGGERED",
        "X402_PARSE_ERROR",
        "X402_PAYMENT_DENIED",
        "X402_UNSUPPORTED",
        "X402_DESTINATION_BLOCKED",
        "X402_REPLAY_DETECTED",
        "X402_AMOUNT_SUSPICIOUS",
        "X402_FACILITATOR_UNTRUSTED",
        "X402_CONNECTION_REQUIRED",
        "X402_SETTLEMENT_FAILED",
        "TX_SIZE_OVERFLOW",
      ];
      expect(codes.map((c) => c.name)).to.deep.equal(expectedNames);
    });

    it("7033 maps to TX_SIZE_OVERFLOW", () => {
      const err = toAgentError({ code: 7033, message: "TX too big" });
      expect(err.code).to.equal("TX_SIZE_OVERFLOW");
      expect(err.category).to.equal("INPUT_VALIDATION");
      expect(err.retryable).to.be.false;
    });

    it("7005 maps to INTENT_EXPIRED (not SIZE_OVERFLOW)", () => {
      const err = toAgentError({ code: 7005, message: "expired" });
      expect(err.code).to.equal("INTENT_EXPIRED");
      expect(err.category).to.equal("TRANSIENT");
    });

    it("SDK code 7014 (TEE_VERIFICATION_FAILED) is FATAL and not retryable", () => {
      const err = { code: 7014, message: "TEE failed" };
      const agent = toAgentError(err);
      expect(agent.code).to.equal("TEE_VERIFICATION_FAILED");
      expect(agent.category).to.equal("FATAL");
      expect(agent.retryable).to.be.false;
    });

    it("SDK code 7010 (TRANSACTION_TIMEOUT) is retryable", () => {
      const err = { code: 7010, message: "Timeout" };
      const agent = toAgentError(err);
      expect(agent.code).to.equal("TRANSACTION_TIMEOUT");
      expect(agent.category).to.equal("TRANSIENT");
      expect(agent.retryable).to.be.true;
      expect(agent.retry_after_ms).to.equal(5_000);
    });
  });

  // ─── protocolEscalationError ──────────────────────────────────────────────

  describe("protocolEscalationError", () => {
    it("creates escalation error with required actions", () => {
      const err = protocolEscalationError({
        message: "Protocol X not supported",
        requiredActions: ["Add protocol X to vault allowlist"],
      });
      expect(err.code).to.equal("PROTOCOL_ESCALATION");
      expect(err.category).to.equal("ESCALATION_REQUIRED");
      expect(err.retryable).to.be.false;
      expect(err.recovery_actions).to.have.lengthOf(2);
      expect(err.recovery_actions[0].action).to.equal("escalate_to_human");
      expect(err.recovery_actions[1].action).to.equal("required_vault_change");
    });

    it("includes alternatives as last recovery action", () => {
      const err = protocolEscalationError({
        message: "Protocol X not supported",
        requiredActions: ["Add protocol X"],
        alternatives: [{ name: "Jupiter" }, { name: "Raydium" }],
      });
      expect(err.recovery_actions).to.have.lengthOf(3);
      expect(err.recovery_actions[2].action).to.equal(
        "suggest_alternatives_secondary",
      );
    });

    it("omits alternatives recovery action when no alternatives provided", () => {
      const err = protocolEscalationError({
        message: "Unsupported",
        requiredActions: ["Fix it"],
      });
      expect(err.recovery_actions).to.have.lengthOf(2);
    });

    it("context includes anti-redirect instruction", () => {
      const err = protocolEscalationError({
        message: "test",
        requiredActions: [],
      });
      expect(err.context.IMPORTANT).to.be.a("string");
      expect(String(err.context.IMPORTANT)).to.include(
        "Do NOT silently switch",
      );
    });
  });

  // ─── isAgentError ─────────────────────────────────────────────────────────

  describe("isAgentError", () => {
    it("returns true for valid AgentError shape", () => {
      const valid: AgentError = {
        code: "6000",
        message: "test",
        category: "FATAL",
        retryable: false,
        recovery_actions: [],
        context: {},
      };
      expect(isAgentError(valid)).to.be.true;
    });

    it("returns false for null", () => {
      expect(isAgentError(null)).to.be.false;
    });

    it("returns false for plain object missing fields", () => {
      expect(isAgentError({ code: "6000" })).to.be.false;
    });

    it("returns false for primitives", () => {
      expect(isAgentError("string")).to.be.false;
      expect(isAgentError(42)).to.be.false;
      expect(isAgentError(undefined)).to.be.false;
    });
  });

  // ─── toSigilAgentError ────────────────────────────────────────────────────

  // ─── toSigilAgentError — tests all 11 SDK_ERROR_PATTERNS ──────────────────

  describe("toSigilAgentError", () => {
    // Pattern 1: Vault not active
    it("pattern 1: vault-not-active → RESOURCE_NOT_FOUND with recovery actions", () => {
      const result = toSigilAgentError(
        new Error("Vault is not active (status: Frozen)"),
      );
      expect(result.category).to.equal("RESOURCE_NOT_FOUND");
      expect(result.code).to.equal("SDK_RESOURCE_NOT_FOUND");
      expect(result.retryable).to.equal(false);
      expect(result.recovery_actions).to.have.length(2);
      expect(result.recovery_actions[0].action).to.equal("check_vault_status");
    });

    // Pattern 2: Agent not registered
    it("pattern 2: agent-not-registered → PERMISSION", () => {
      const result = toSigilAgentError(
        new Error("Agent abc123 is not registered in vault xyz"),
      );
      expect(result.category).to.equal("PERMISSION");
      expect(result.recovery_actions[0].action).to.equal("register_agent");
    });

    // Pattern 3: Agent paused
    it("pattern 3: agent-paused → PERMISSION", () => {
      const result = toSigilAgentError(
        new Error("Agent abc123 is paused in vault xyz"),
      );
      expect(result.category).to.equal("PERMISSION");
      expect(result.recovery_actions[0].action).to.equal("unpause_agent");
    });

    // Pattern 4: Lacks permission
    it("pattern 4: lacks-permission → PERMISSION", () => {
      const result = toSigilAgentError(
        new Error('Agent lacks permission for action "openPosition"'),
      );
      expect(result.category).to.equal("PERMISSION");
      expect(result.recovery_actions[0].action).to.equal("update_permissions");
    });

    // Pattern 5: Protocol not allowed
    it("pattern 5: protocol-not-allowed → PROTOCOL_NOT_SUPPORTED", () => {
      const result = toSigilAgentError(
        new Error("Protocol JUP6Lk is not allowed by vault policy"),
      );
      expect(result.category).to.equal("PROTOCOL_NOT_SUPPORTED");
      expect(result.recovery_actions[0].action).to.equal("add_protocol");
    });

    // Pattern 6: Transaction size
    it("pattern 6: tx-size-exceeds → INPUT_VALIDATION with ALT advice", () => {
      const result = toSigilAgentError(
        new Error("Transaction size 1500 bytes exceeds 1232 byte limit"),
      );
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.recovery_actions[0].action).to.equal("add_alts");
    });

    // Pattern 7: Position limit (retryable)
    it("pattern 7: position-limit → POLICY_VIOLATION, retryable with close_position", () => {
      const result = toSigilAgentError(
        new Error("Position limit reached: 5/5"),
      );
      expect(result.category).to.equal("POLICY_VIOLATION");
      expect(result.retryable).to.equal(true);
      expect(result.recovery_actions[0].action).to.equal("close_position");
    });

    // Pattern 8: Spending action amount
    it("pattern 8: spending-amount-zero → INPUT_VALIDATION", () => {
      const result = toSigilAgentError(
        new Error('Spending action "swap" requires amount > 0'),
      );
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.recovery_actions[0].action).to.equal("fix_amount");
    });

    // Pattern 9: Non-spending amount
    it("pattern 9: non-spending-amount → INPUT_VALIDATION", () => {
      const result = toSigilAgentError(
        new Error('Non-spending action "closePosition" requires amount === 0'),
      );
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.recovery_actions[0].action).to.equal("set_zero_amount");
    });

    // Pattern 10: No target protocol
    it("pattern 10: no-target-protocol → INPUT_VALIDATION", () => {
      const result = toSigilAgentError(
        new Error(
          "No target protocol: provide targetProtocol or include DeFi instructions",
        ),
      );
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.recovery_actions[0].action).to.equal("add_instructions");
    });

    // Pattern 11: Escrow action
    it("pattern 11: escrow-action → INPUT_VALIDATION", () => {
      const result = toSigilAgentError(
        new Error('Escrow action "createEscrow" uses standalone instructions'),
      );
      expect(result.category).to.equal("INPUT_VALIDATION");
      expect(result.recovery_actions[0].action).to.equal("use_escrow_api");
    });

    // SigilSdkError contract
    it("SigilSdkError has all 7 AgentError fields with correct values", () => {
      const result = toSigilAgentError(
        new Error("Position limit reached: 5/5"),
      );
      expect(result).to.be.instanceOf(Error);
      expect(result).to.be.instanceOf(SigilSdkError);
      expect(result.name).to.equal("SigilSdkError");
      expect(result.code).to.equal("SDK_POLICY_VIOLATION");
      expect(result.message).to.equal("Position limit reached: 5/5");
      expect(result.category).to.equal("POLICY_VIOLATION");
      expect(result.retryable).to.equal(true);
      expect(result.recovery_actions)
        .to.be.an("array")
        .with.length.greaterThan(0);
      expect(result.context).to.be.an("object");
    });

    // Fallback
    it("falls back to UNKNOWN/FATAL for unrecognized errors", () => {
      const result = toSigilAgentError(
        new Error("something completely unexpected"),
      );
      expect(result.code).to.equal("UNKNOWN");
      expect(result.category).to.equal("FATAL");
      expect(result.retryable).to.equal(false);
      expect(result.recovery_actions).to.have.length(0);
    });
  });
});
