/**
 * Tests for event-analytics.ts — activity feed, event categorization, descriptions.
 */

import { expect } from "chai";
import {
  categorizeEvent,
  describeEvent,
  buildActivityItem,
} from "../src/event-analytics.js";
import type { DecodedPhalnxEvent } from "../src/events.js";

// ─── categorizeEvent ─────────────────────────────────────────────────────────

describe("categorizeEvent", () => {
  it("categorizes ActionAuthorized as trade", () => {
    expect(categorizeEvent("ActionAuthorized")).to.equal("trade");
  });

  it("categorizes FundsDeposited as deposit", () => {
    expect(categorizeEvent("FundsDeposited")).to.equal("deposit");
  });

  it("categorizes VaultFrozen as security", () => {
    expect(categorizeEvent("VaultFrozen")).to.equal("security");
  });

  it("categorizes PolicyUpdated as policy", () => {
    expect(categorizeEvent("PolicyUpdated")).to.equal("policy");
  });

  it("categorizes EscrowCreated as escrow", () => {
    expect(categorizeEvent("EscrowCreated")).to.equal("escrow");
  });

  it("categorizes FeesCollected as fee", () => {
    expect(categorizeEvent("FeesCollected")).to.equal("fee");
  });

  it("defaults unknown events to trade", () => {
    expect(categorizeEvent("SomeNewEvent")).to.equal("trade");
  });

  it("categorizes known events into expected categories", () => {
    // Spot-check specific events against their actual categories
    // (tests the mapping logic, not just that a string is returned)
    expect(categorizeEvent("ActionAuthorized")).to.equal("trade");
    expect(categorizeEvent("SessionFinalized")).to.equal("trade");
    expect(categorizeEvent("FundsDeposited")).to.equal("deposit");
    expect(categorizeEvent("FundsWithdrawn")).to.equal("withdrawal");
    expect(categorizeEvent("PolicyUpdated")).to.equal("policy");
    expect(categorizeEvent("VaultCreated")).to.equal("security");
    expect(categorizeEvent("VaultFrozen")).to.equal("security");
    expect(categorizeEvent("EscrowCreated")).to.equal("escrow");
    expect(categorizeEvent("FeesCollected")).to.equal("fee");
    expect(categorizeEvent("AgentRegistered")).to.equal("agent");
  });
});

// ─── describeEvent ───────────────────────────────────────────────────────────

describe("describeEvent", () => {
  it("describes FundsDeposited with amount", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "FundsDeposited",
      data: new Uint8Array(0),
      fields: {
        vault: "vault123",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 500_000_000n,
        timestamp: 1700000000n,
      },
    };
    const desc = describeEvent(decoded, "mainnet-beta");
    expect(desc).to.include("deposited");
    expect(desc).to.include("500");
  });

  it("describes VaultFrozen", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "VaultFrozen",
      data: new Uint8Array(0),
      fields: { vault: "v", owner: "o", agentsPreserved: 2, timestamp: 0n },
    };
    expect(describeEvent(decoded)).to.equal("Vault paused — all agent activity stopped");
  });

  it("handles null fields gracefully", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "ActionAuthorized",
      data: new Uint8Array(0),
      fields: null,
    };
    expect(describeEvent(decoded)).to.include("details unavailable");
  });

  it("describes expired session differently from failed", () => {
    const expired: DecodedPhalnxEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: { vault: "v", agent: "a123456789abcdef", success: false, isExpired: true, timestamp: 0n },
    };
    expect(describeEvent(expired)).to.include("expired");

    const failed: DecodedPhalnxEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: { vault: "v", agent: "a123456789abcdef", success: false, isExpired: false, timestamp: 0n },
    };
    expect(describeEvent(failed)).to.include("failed");
  });

  it("describes unknown event with name", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "FutureEvent" as any,
      data: new Uint8Array(0),
      fields: {},
    };
    expect(describeEvent(decoded)).to.equal("FutureEvent event");
  });
});

// ─── buildActivityItem ───────────────────────────────────────────────────────

describe("buildActivityItem", () => {
  it("builds complete activity item from FundsDeposited", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "FundsDeposited",
      data: new Uint8Array(0),
      fields: {
        vault: "vault123",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 500_000_000n,
        timestamp: 1700000000n,
      },
    };

    const item = buildActivityItem(decoded, "tx123abc", 1700000000, "mainnet-beta");
    expect(item.category).to.equal("deposit");
    expect(item.amount).to.equal(500_000_000n);
    expect(item.success).to.equal(true);
    expect(item.txSignature).to.equal("tx123abc");
    expect(item.description).to.include("deposited");
  });

  it("handles ActionAuthorized with Codama enum actionType", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "ActionAuthorized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "agent123456789abc",
        actionType: { __kind: "Swap" },
        tokenMint: "mint123",
        amount: 100_000_000n,
        usdAmount: 100_000_000n,
        protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        rollingSpendUsdAfter: 0n,
        dailyCapUsd: 1_000_000_000n,
        delegated: true,
        timestamp: 1700000000n,
      },
    };

    const item = buildActivityItem(decoded, "tx456", 1700000000);
    expect(item.actionType).to.equal("Swap");
    expect(item.protocolName).to.equal("Jupiter");
    expect(item.category).to.equal("trade");
  });

  it("handles SessionFinalized with u8 actionType", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "agent123456789abc",
        success: true,
        isExpired: false,
        timestamp: 1700000000n,
        actualSpendUsd: 50_000_000n,
        balanceAfterUsd: 950_000_000n,
        actionType: 0, // u8 for Swap
      },
    };

    const item = buildActivityItem(decoded, "tx789", 1700000000);
    expect(item.category).to.equal("trade");
    expect(item.success).to.equal(true);
  });

  it("defaults success to true for non-session events", () => {
    const decoded: DecodedPhalnxEvent = {
      name: "VaultCreated",
      data: new Uint8Array(0),
      fields: { vault: "v", owner: "o", vaultId: 1n, timestamp: 0n },
    };
    const item = buildActivityItem(decoded, "tx", 0);
    expect(item.success).to.equal(true);
  });
});
