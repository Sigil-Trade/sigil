/**
 * Tests for SigilErrorCategory discriminated union and categorizeError().
 */

import { expect } from "chai";
import {
  toAgentError,
  categorizeError,
  type SigilErrorCategory,
  type AgentError,
} from "../src/agent-errors.js";

describe("SigilErrorCategory", () => {
  it("categorizes spending cap error as spending type", () => {
    // Error 6006 = SpendingCapExceeded → SPENDING_CAP (hex 0x1776)
    const err = toAgentError({ message: "custom program error: 0x1776" });
    const cat = categorizeError(err);
    expect(cat.type).to.equal("spending");
    if (cat.type === "spending") {
      expect(cat).to.have.property("remaining");
      expect(cat).to.have.property("cap");
    }
  });

  it("categorizes permission error as permission type", () => {
    // Error 6001 = UnauthorizedAgent → PERMISSION (hex 0x1771)
    const err = toAgentError({ message: "custom program error: 0x1771" });
    const cat = categorizeError(err);
    expect(cat.type).to.equal("permission");
    if (cat.type === "permission") {
      expect(cat).to.have.property("required");
    }
  });

  it("categorizes protocol error as protocol type", () => {
    // SDK error PROTOCOL_NOT_SUPPORTED → PROTOCOL_NOT_SUPPORTED category
    const err: AgentError = {
      code: "PROTOCOL_NOT_SUPPORTED",
      message: "Protocol is not supported",
      category: "PROTOCOL_NOT_SUPPORTED",
      retryable: false,
      recovery_actions: [],
      context: { protocol: "UnknownProtocol111111111111111111111111111" },
    };
    const cat = categorizeError(err);
    expect(cat.type).to.equal("protocol");
    if (cat.type === "protocol") {
      expect(cat.protocol).to.equal(
        "UnknownProtocol111111111111111111111111111",
      );
    }
  });

  it("categorizes vault status error as vault type", () => {
    // Error 6000 = VaultNotActive → RESOURCE_NOT_FOUND
    const err = toAgentError({ message: "custom program error: 0x1770" });
    const cat = categorizeError(err);
    expect(cat.type).to.equal("vault");
    if (cat.type === "vault") {
      expect(cat).to.have.property("status");
    }
  });

  it("categorizes network error as network type", () => {
    const err = toAgentError(new Error("fetch failed: ECONNREFUSED"));
    const cat = categorizeError(err);
    expect(cat.type).to.equal("network");
    if (cat.type === "network") {
      expect(cat).to.have.property("retryable");
      expect(cat.retryable).to.be.true;
    }
  });

  it("categorizeError returns a valid type for network errors", () => {
    const err = toAgentError(new Error("fetch failed: ECONNREFUSED"));
    const cat = categorizeError(err);
    expect(cat.type).to.equal("network");
    if (cat.type === "network") {
      expect(cat.retryable).to.be.true;
    }
  });

  it("categorizes rate limit error as network type", () => {
    const err = toAgentError(new Error("429 Too Many Requests"));
    const cat = categorizeError(err);
    expect(cat.type).to.equal("network");
    if (cat.type === "network") {
      expect(cat.retryable).to.be.true;
    }
  });

  it("categorizes unknown error as network type (fallback)", () => {
    const err = toAgentError(new Error("something completely unknown"));
    const cat = categorizeError(err);
    expect(cat.type).to.equal("network");
  });
});
