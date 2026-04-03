/**
 * Tests for protocol-analytics.ts — per-protocol breakdown.
 */

import { expect } from "chai";
import { getProtocolBreakdown } from "../src/protocol-analytics.js";
import type { Address } from "@solana/kit";

function mockStateWithProtocols(
  protocols: Array<{ protocol: string; spent: bigint; cap: bigint }>,
  globalSpent = 0n,
) {
  const total = protocols.reduce((s, p) => s + p.spent, 0n);
  return {
    protocolBudgets: protocols.map((p) => ({
      protocol: p.protocol as Address,
      spent24h: p.spent,
      cap: p.cap,
      remaining: p.cap > p.spent ? p.cap - p.spent : 0n,
    })),
    globalBudget: {
      spent24h: globalSpent > 0n ? globalSpent : total,
      cap: 1_000_000_000n,
      remaining: 1_000_000_000n - (globalSpent > 0n ? globalSpent : total),
    },
  } as any;
}

describe("getProtocolBreakdown", () => {
  it("computes utilization for known protocol", () => {
    const state = mockStateWithProtocols([
      {
        protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        spent: 400_000_000n,
        cap: 500_000_000n,
      },
    ]);
    const result = getProtocolBreakdown(state);
    expect(result).to.have.length(1);
    expect(result[0].protocolName).to.equal("Jupiter");
    expect(result[0].utilization).to.equal(80);
    expect(result[0].percentOfTotalSpend).to.equal(100);
  });

  it("computes share-of-total across multiple protocols", () => {
    const state = mockStateWithProtocols([
      {
        protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        spent: 300_000_000n,
        cap: 500_000_000n,
      },
      {
        protocol: "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn",
        spent: 100_000_000n,
        cap: 500_000_000n,
      },
    ]);
    const result = getProtocolBreakdown(state);
    expect(result).to.have.length(2);
    // Jupiter: 300/400 = 75%
    expect(result[0].percentOfTotalSpend).to.equal(75);
    // Flash Trade: 100/400 = 25%
    expect(result[1].percentOfTotalSpend).to.equal(25);
  });

  it("handles zero cap (no per-protocol limit)", () => {
    const state = mockStateWithProtocols([
      {
        protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        spent: 100_000_000n,
        cap: 0n,
      },
    ]);
    const result = getProtocolBreakdown(state);
    expect(result[0].cap).to.be.null;
    expect(result[0].utilization).to.equal(0);
  });

  it("returns empty for no protocol budgets", () => {
    const state = mockStateWithProtocols([]);
    expect(getProtocolBreakdown(state)).to.deep.equal([]);
  });

  it("handles zero total spend", () => {
    const state = mockStateWithProtocols(
      [
        {
          protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
          spent: 0n,
          cap: 500_000_000n,
        },
      ],
      0n,
    );
    const result = getProtocolBreakdown(state);
    expect(result[0].percentOfTotalSpend).to.equal(0);
  });
});
