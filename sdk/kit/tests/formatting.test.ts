/**
 * Tests for formatting.ts — display formatting functions.
 *
 * SDK default: full precision (6 decimals for USD, full token decimals).
 * UI truncates by passing explicit decimal count.
 */

import { expect } from "chai";
import {
  formatUsd,
  formatUsdCompact,
  formatUsdSigned,
  formatPercent,
  formatPercentSigned,
  formatDuration,
  formatRelativeTime,
  formatTimeUntil,
  formatAddress,
  formatTokenAmount,
  formatTokenAmountCompact,
} from "../src/formatting.js";

// ─── USD Formatting ──────────────────────────────────────────────────────────

describe("formatUsd", () => {
  it("formats basic USD amount at full precision (default)", () => {
    expect(formatUsd(500_000_000n)).to.equal("$500.000000");
  });

  it("formats with thousands separator at full precision", () => {
    expect(formatUsd(1_234_567_890n)).to.equal("$1,234.567890");
  });

  it("formats zero at full precision", () => {
    expect(formatUsd(0n)).to.equal("$0.000000");
  });

  it("formats negative amount at full precision", () => {
    expect(formatUsd(-500_000_000n)).to.equal("-$500.000000");
  });

  it("formats sub-dollar amount showing micro-dollars", () => {
    expect(formatUsd(500_000n)).to.equal("$0.500000");
  });

  it("formats sub-cent amount preserving precision", () => {
    expect(formatUsd(100n)).to.equal("$0.000100");
  });

  it("formats 1 micro-dollar (smallest unit)", () => {
    expect(formatUsd(1n)).to.equal("$0.000001");
  });

  it("formats with explicit 2 decimals for UI display", () => {
    expect(formatUsd(500_000_000n, 2)).to.equal("$500.00");
    expect(formatUsd(1_234_567_890n, 2)).to.equal("$1,234.57");
  });

  it("formats with 0 decimals for KPI cards", () => {
    expect(formatUsd(1_234_567_890n, 0)).to.equal("$1,235");
  });

  it("formats large amount (u64 range)", () => {
    const result = formatUsd(18_000_000_000_000_000_000n);
    expect(result).to.include("18,000,000,000,000");
  });
});

describe("formatUsdCompact", () => {
  it("formats thousands", () => {
    expect(formatUsdCompact(1_200_000_000n)).to.equal("$1.2K");
  });

  it("formats millions", () => {
    expect(formatUsdCompact(3_500_000_000_000n)).to.equal("$3.5M");
  });

  it("formats small amounts without compact", () => {
    const result = formatUsdCompact(500_000_000n);
    expect(result).to.match(/^\$500/);
  });
});

describe("formatUsdSigned", () => {
  it("formats positive with plus sign at full precision", () => {
    expect(formatUsdSigned(234_560_000n)).to.equal("+$234.560000");
  });

  it("formats negative with minus sign at full precision", () => {
    expect(formatUsdSigned(-89_120_000n)).to.equal("-$89.120000");
  });

  it("formats zero without sign", () => {
    expect(formatUsdSigned(0n)).to.equal("$0.000000");
  });

  it("formats with explicit 2 decimals for UI display", () => {
    expect(formatUsdSigned(234_560_000n, 2)).to.equal("+$234.56");
    expect(formatUsdSigned(-89_120_000n, 2)).to.equal("-$89.12");
    expect(formatUsdSigned(0n, 2)).to.equal("$0.00");
  });
});

// ─── Percentage Formatting ───────────────────────────────────────────────────

describe("formatPercent", () => {
  it("formats basic percentage", () => {
    expect(formatPercent(24.7)).to.equal("24.7%");
  });

  it("formats zero", () => {
    expect(formatPercent(0)).to.equal("0.0%");
  });

  it("formats 100%", () => {
    expect(formatPercent(100)).to.equal("100.0%");
  });
});

describe("formatPercentSigned", () => {
  it("formats positive with plus", () => {
    expect(formatPercentSigned(24.7)).to.equal("+24.7%");
  });

  it("formats negative with minus", () => {
    expect(formatPercentSigned(-5.2)).to.equal("-5.2%");
  });

  it("formats near-zero as 0.0%", () => {
    expect(formatPercentSigned(0.01)).to.equal("0.0%");
    expect(formatPercentSigned(-0.01)).to.equal("0.0%");
  });

  it("scales threshold with decimals=2", () => {
    // 0.04 is below 0.05 (1-decimal threshold) but above 0.005 (2-decimal threshold)
    expect(formatPercentSigned(0.04, 2)).to.equal("+0.04%");
    expect(formatPercentSigned(-0.04, 2)).to.equal("-0.04%");
    // 0.004 is below 2-decimal threshold
    expect(formatPercentSigned(0.004, 2)).to.equal("0.00%");
  });
});

// ─── Time Formatting ─────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats days and hours", () => {
    expect(formatDuration(90000)).to.equal("1d 1h");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(8100)).to.equal("2h 15m");
  });

  it("formats minutes only", () => {
    expect(formatDuration(2700)).to.equal("45m");
  });

  it("formats sub-minute as < 1m", () => {
    expect(formatDuration(30)).to.equal("< 1m");
  });

  it("formats zero as < 1m", () => {
    expect(formatDuration(0)).to.equal("< 1m");
  });

  it("clamps negative to 0m", () => {
    expect(formatDuration(-10)).to.equal("0m");
  });

  it("formats days without hours", () => {
    expect(formatDuration(86400)).to.equal("1d");
  });

  it("formats hours without minutes", () => {
    expect(formatDuration(3600)).to.equal("1h");
  });
});

describe("formatRelativeTime", () => {
  it("formats recent time as just now", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now)).to.equal("just now");
  });

  it("formats minutes ago", () => {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    expect(formatRelativeTime(fiveMinAgo)).to.equal("5m ago");
  });

  it("formats hours ago", () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    expect(formatRelativeTime(twoHoursAgo)).to.equal("2h ago");
  });

  it("formats days ago", () => {
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 259200;
    expect(formatRelativeTime(threeDaysAgo)).to.equal("3d ago");
  });
});

describe("formatTimeUntil", () => {
  it("formats future time", () => {
    const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600;
    expect(formatTimeUntil(oneHourFromNow)).to.equal("in 1h");
  });

  it("formats past time as expired", () => {
    const pastTime = Math.floor(Date.now() / 1000) - 100;
    expect(formatTimeUntil(pastTime)).to.equal("expired");
  });
});

// ─── Address Formatting ──────────────────────────────────────────────────────

describe("formatAddress", () => {
  it("truncates long address", () => {
    const addr = "7Kp3YMBFCNxzaKMhSQx3fvZPQ2mN";
    const result = formatAddress(addr);
    expect(result).to.equal("7Kp3...Q2mN");
  });

  it("returns short address unchanged", () => {
    expect(formatAddress("abc")).to.equal("abc");
  });

  it("truncates with custom char count", () => {
    const addr = "7Kp3YMBFCNxzaKMhSQx3fvZPQ2mN";
    expect(formatAddress(addr, 6)).to.equal("7Kp3YM...ZPQ2mN");
  });
});

// ─── Token Amount Formatting ─────────────────────────────────────────────────

describe("formatTokenAmount", () => {
  it("formats USDC at full precision (6 decimals)", () => {
    expect(formatTokenAmount(1_234_560_000n, 6, "USDC")).to.equal(
      "1,234.560000 USDC",
    );
  });

  it("formats zero at full precision", () => {
    expect(formatTokenAmount(0n, 6, "USDC")).to.equal("0.000000 USDC");
  });

  it("formats SOL at full precision (9 decimals)", () => {
    expect(formatTokenAmount(123_456_789n, 9, "SOL")).to.equal(
      "0.123456789 SOL",
    );
  });

  it("formats 1 lamport (smallest SOL unit)", () => {
    expect(formatTokenAmount(1n, 9, "SOL")).to.equal("0.000000001 SOL");
  });

  it("formats with explicit truncation for UI (2 decimals)", () => {
    expect(formatTokenAmount(1_234_560_000n, 6, "USDC", 2)).to.equal(
      "1,234.56 USDC",
    );
  });

  it("formats with explicit truncation for UI (4 decimals)", () => {
    expect(formatTokenAmount(123_456_789n, 9, "SOL", 4)).to.equal("0.1234 SOL");
  });
});

describe("formatTokenAmountCompact", () => {
  it("formats compact", () => {
    expect(formatTokenAmountCompact(1_200_000_000n, 6, "USDC")).to.equal(
      "1.2K USDC",
    );
  });

  it("formats millions", () => {
    expect(formatTokenAmountCompact(3_500_000_000_000n, 6, "USDC")).to.equal(
      "3.5M USDC",
    );
  });
});
