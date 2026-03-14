import { expect } from "chai";
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { getAddressEncoder } from "@solana/kit";
import {
  getRolling24hUsd,
  getAgentRolling24hUsd,
  getProtocolSpend,
  bytesToAddress,
  resolveVaultState,
} from "../src/state-resolver.js";
import type {
  EffectiveBudget,
  ProtocolBudget,
} from "../src/state-resolver.js";
import type { SpendTracker } from "../src/generated/accounts/spendTracker.js";
import type { AgentContributionEntry } from "../src/generated/types/agentContributionEntry.js";
import type { EpochBucket } from "../src/generated/types/epochBucket.js";
import type { ProtocolSpendCounter } from "../src/generated/types/protocolSpendCounter.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

const EPOCH_DURATION = 600n;
const OVERLAY_EPOCH_DURATION = 3600n;

// Valid Solana addresses (well-known programs, 32-byte base58)
const AGENT_A = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const PROTOCOL_A = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

const encoder = getAddressEncoder();

function addressToBytes(addr: Address): ReadonlyUint8Array {
  return encoder.encode(addr);
}

function zeroBytes(len: number): ReadonlyUint8Array {
  return new Uint8Array(len);
}

function makeBucket(epochId: bigint, usdAmount: bigint): EpochBucket {
  return { epochId, usdAmount };
}

function emptyBuckets(count: number): EpochBucket[] {
  return Array.from({ length: count }, () => makeBucket(0n, 0n));
}

function makeTracker(
  overrides: Partial<{
    buckets: EpochBucket[];
    protocolCounters: ProtocolSpendCounter[];
    lastWriteEpoch: bigint;
  }> = {},
): SpendTracker {
  return {
    discriminator: new Uint8Array(8),
    vault: "Vault111111111111111111111111111111111111111" as Address,
    buckets: overrides.buckets ?? emptyBuckets(144),
    protocolCounters:
      overrides.protocolCounters ?? emptyProtocolCounters(10),
    lastWriteEpoch: overrides.lastWriteEpoch ?? 0n,
    bump: 255,
    padding: zeroBytes(7),
  };
}

function emptyProtocolCounters(count: number): ProtocolSpendCounter[] {
  return Array.from({ length: count }, () => ({
    protocol: zeroBytes(32),
    windowStart: 0n,
    windowSpend: 0n,
  }));
}

function makeContributionEntry(
  overrides: Partial<{
    agent: ReadonlyUint8Array;
    lastWriteEpoch: bigint;
    contributions: bigint[];
  }> = {},
): AgentContributionEntry {
  return {
    agent: overrides.agent ?? zeroBytes(32),
    lastWriteEpoch: overrides.lastWriteEpoch ?? 0n,
    contributions: overrides.contributions ?? Array(24).fill(0n),
  };
}

// ─── getRolling24hUsd ────────────────────────────────────────────────────────

describe("getRolling24hUsd", () => {
  it("returns 0 for all-zero tracker", () => {
    const tracker = makeTracker();
    expect(getRolling24hUsd(tracker, 1000000n)).to.equal(0n);
  });

  it("returns exact amount for single bucket fully inside window", () => {
    // now = epoch 200 * 600 = 120000
    // bucket at epoch 200 → bucketStart=120000, bucketEnd=120600
    // windowStart = 120000 - 86400 = 33600
    // Bucket fully inside window
    const nowUnix = 200n * EPOCH_DURATION;
    const buckets = emptyBuckets(144);
    const idx = Number(200n % 144n);
    buckets[idx] = makeBucket(200n, 500_000_000n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 200n });
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(500_000_000n);
  });

  it("returns 0 for bucket entirely outside window", () => {
    // now = epoch 400 * 600 = 240000
    // bucket at epoch 50 → bucketStart=30000, bucketEnd=30600
    // windowStart = 240000 - 86400 = 153600
    // bucketEnd (30600) <= windowStart (153600) → skipped
    const nowUnix = 400n * EPOCH_DURATION;
    const buckets = emptyBuckets(144);
    const idx = Number(50n % 144n);
    buckets[idx] = makeBucket(50n, 100_000_000n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 50n });
    // lastWriteEpoch 50, currentEpoch 400, diff > 144 → early exit
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(0n);
  });

  it("proportionally scales boundary bucket", () => {
    // Place bucket right at boundary edge:
    // now = 86700 (epoch 144.5 → 144)
    // windowStart = 86700 - 86400 = 300
    // bucket at epoch 0 → bucketStart=0, bucketEnd=600
    // overlap = 600 - 300 = 300 → 50% of 600
    // amount = 1_000_000 → scaled = (1_000_000 * 300) / 600 = 500_000
    const nowUnix = 86700n;
    const currentEpoch = nowUnix / EPOCH_DURATION; // 144
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(0n, 1_000_000n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: currentEpoch });
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(500_000n);
  });

  it("sums multiple buckets correctly", () => {
    const nowUnix = 200n * EPOCH_DURATION; // 120000
    const buckets = emptyBuckets(144);

    // Place 3 buckets all within window
    for (const epoch of [198n, 199n, 200n]) {
      const idx = Number(epoch % 144n);
      buckets[idx] = makeBucket(epoch, 100_000_000n);
    }

    const tracker = makeTracker({ buckets, lastWriteEpoch: 200n });
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(300_000_000n);
  });

  it("returns 0 when lastWriteEpoch is stale >144 epochs", () => {
    const nowUnix = 500n * EPOCH_DURATION;
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(100n, 999_000_000n);

    // lastWriteEpoch=100, currentEpoch=500, diff=400 > 144 → early exit
    const tracker = makeTracker({ buckets, lastWriteEpoch: 100n });
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(0n);
  });

  it("returns 0 when nowUnix <= 0", () => {
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(0n, 500_000_000n);
    const tracker = makeTracker({ buckets, lastWriteEpoch: 0n });
    expect(getRolling24hUsd(tracker, 0n)).to.equal(0n);
    expect(getRolling24hUsd(tracker, -1n)).to.equal(0n);
  });

  it("skips bucket when bucketEnd === windowStart (exact boundary)", () => {
    // now = 87000 (epoch 145)
    // windowStart = 87000 - 86400 = 600
    // bucket at epoch 0 → bucketStart=0, bucketEnd=600
    // bucketEnd (600) <= windowStart (600) → SKIPPED
    const nowUnix = 87000n;
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(0n, 1_000_000n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 145n });
    // epoch 0 bucket should be excluded because bucketEnd === windowStart
    // The only bucket with data is epoch 0 which is excluded
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(0n);
  });
});

// ─── getAgentRolling24hUsd ───────────────────────────────────────────────────

describe("getAgentRolling24hUsd", () => {
  it("returns 0 for all-zero entry", () => {
    const entry = makeContributionEntry();
    expect(getAgentRolling24hUsd(entry, 100000n)).to.equal(0n);
  });

  it("returns contribution for single epoch inside window", () => {
    // now = 50 * 3600 = 180000
    // lastWriteEpoch = 50
    // contributions[50 % 24 = 2] = 200_000_000
    // bucketStart = 50 * 3600 = 180000
    // windowStart = 180000 - 86400 = 93600
    // bucketStart >= windowStart → fully inside
    const epoch = 50n;
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[Number(epoch % 24n)] = 200_000_000n;

    const entry = makeContributionEntry({
      agent: addressToBytes(AGENT_A),
      lastWriteEpoch: epoch,
      contributions,
    });

    const nowUnix = epoch * OVERLAY_EPOCH_DURATION;
    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(200_000_000n);
  });

  it("returns 0 when lastWriteEpoch > 24h ago", () => {
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[0] = 100_000_000n;

    const entry = makeContributionEntry({
      lastWriteEpoch: 10n,
      contributions,
    });

    // currentEpoch = 100000 / 3600 ≈ 27, diff = 27 - 10 = 17 (not > 24)
    // Use a time where diff > 24:
    // currentEpoch = 35, diff = 35 - 10 = 25 > 24
    const nowUnix = 35n * OVERLAY_EPOCH_DURATION;
    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(0n);
  });

  it("proportionally scales boundary contribution", () => {
    // We need the boundary epoch to be reachable by backward iteration (k < 24).
    // lastWriteEpoch = 30, data at epoch 7
    // now = 30.5 * 3600 = 109800
    // windowStart = 109800 - 86400 = 23400
    // k = 23 → epochForK = 30 - 23 = 7
    // bucketStart = 7 * 3600 = 25200, bucketEnd = 28800
    // bucketStart (25200) >= windowStart (23400) → fully inside, no boundary
    //
    // For boundary: epochForK = 6 → k=24, but k < 24 won't reach.
    // Use smaller epoch gap. lastWriteEpoch = 10, data at epoch 10
    // now = 10 * 3600 + 1800 = 37800 (epoch 10, halfway)
    // windowStart = 37800 - 86400 = -48600 (negative, no boundary possible)
    //
    // For boundary to occur, window must cut through a bucket.
    // Use higher timestamps. lastWriteEpoch = 50, data at epoch 27 (k=23).
    // now = 50.5 * 3600 = 181800
    // windowStart = 181800 - 86400 = 95400
    // k=23 → epochForK = 50 - 23 = 27
    // bucketStart = 27 * 3600 = 97200, bucketEnd = 100800
    // bucketStart (97200) >= windowStart (95400) → fully inside
    //
    // For boundary: epochForK = 26 → k=24, unreachable.
    //
    // The backward iteration only covers 24 buckets, which IS 24h.
    // Boundary only happens when now is fractional within the first epoch.
    // lastWriteEpoch = 50, now = 50 * 3600 + 1800 = 181800
    // Earliest reachable: epochForK = 50 - 23 = 27
    // bucketStart = 97200, windowStart = 95400 → fully inside
    //
    // The boundary happens when the k=23 epoch straddles windowStart.
    // For that: bucketStart(epochForK) < windowStart < bucketEnd(epochForK)
    // epochForK = lastWriteEpoch - 23
    // bucketStart = (lastWriteEpoch - 23) * 3600
    // windowStart = now - 86400
    // Need: (lastWriteEpoch - 23) * 3600 < now - 86400 < (lastWriteEpoch - 22) * 3600
    // With lastWriteEpoch = L, now = L * 3600 + offset:
    // (L-23)*3600 < L*3600 + offset - 86400 < (L-22)*3600
    // L*3600 - 82800 < L*3600 + offset - 86400 < L*3600 - 79200
    // -82800 < offset - 86400 < -79200
    // 3600 < offset < 7200
    // offset in (3600, 7200) → e.g. offset = 5400 (1.5 hours into epoch)
    const lastWrite = 50n;
    const offset = 5400n; // 1.5 hours
    const nowUnix = lastWrite * 3600n + offset;
    // windowStart = 50*3600 + 5400 - 86400 = 180000 + 5400 - 86400 = 99000
    // k=23 → epochForK = 50 - 23 = 27
    // bucketStart = 27 * 3600 = 97200
    // bucketEnd = 100800
    // 97200 < 99000 < 100800 → BOUNDARY!
    // overlap = 100800 - 99000 = 1800
    // scaled = (1_000_000 * 1800) / 3600 = 500_000
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[Number(27n % 24n)] = 1_000_000n; // epoch 27, idx 3

    const entry = makeContributionEntry({
      lastWriteEpoch: lastWrite,
      contributions,
    });

    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(500_000n);
  });

  it("sums multiple hours correctly (backward iteration)", () => {
    // lastWriteEpoch = 50, place data at epochs 48, 49, 50
    const lastWrite = 50n;
    const contributions = Array(24).fill(0n) as bigint[];
    for (const e of [48n, 49n, 50n]) {
      contributions[Number(e % 24n)] = 100_000_000n;
    }

    const entry = makeContributionEntry({
      lastWriteEpoch: lastWrite,
      contributions,
    });

    const nowUnix = lastWrite * OVERLAY_EPOCH_DURATION;
    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(300_000_000n);
  });

  it("skips future epoch", () => {
    // lastWriteEpoch = 50, now is actually at epoch 48
    // k=0 → epochForK=50, but 50 > currentEpoch(48) → skip
    // k=1 → epochForK=49, skip
    // k=2 → epochForK=48, include
    const lastWrite = 50n;
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[Number(50n % 24n)] = 999_000_000n; // future
    contributions[Number(48n % 24n)] = 100_000_000n; // current

    const entry = makeContributionEntry({
      lastWriteEpoch: lastWrite,
      contributions,
    });

    const nowUnix = 48n * OVERLAY_EPOCH_DURATION;
    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(100_000_000n);
  });

  it("breaks when epochForK < 0", () => {
    // lastWriteEpoch = 2, k=3 → epochForK = 2-3 = -1 → break
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[0] = 50_000_000n;
    contributions[1] = 60_000_000n;
    contributions[2] = 70_000_000n;

    const entry = makeContributionEntry({
      lastWriteEpoch: 2n,
      contributions,
    });

    // now at epoch 2, all 3 epochs are within window
    const nowUnix = 2n * OVERLAY_EPOCH_DURATION;
    expect(getAgentRolling24hUsd(entry, nowUnix)).to.equal(180_000_000n);
  });
});

// ─── getProtocolSpend ────────────────────────────────────────────────────────

describe("getProtocolSpend", () => {
  it("returns 0 when no matching protocol", () => {
    const tracker = makeTracker();
    expect(getProtocolSpend(tracker, PROTOCOL_A, 100000n)).to.equal(0n);
  });

  it("returns windowSpend when protocol matches within window", () => {
    const counters = emptyProtocolCounters(10);
    counters[0] = {
      protocol: addressToBytes(PROTOCOL_A),
      windowStart: 100n, // epoch
      windowSpend: 500_000_000n,
    };

    // currentEpoch = 150000 / 600 = 250, diff = 250 - 100 = 150 >= 144 → expired
    // Use closer time: currentEpoch = 200, diff = 200 - 100 = 100 < 144
    const nowUnix = 200n * EPOCH_DURATION;
    const tracker = makeTracker({ protocolCounters: counters });
    expect(getProtocolSpend(tracker, PROTOCOL_A, nowUnix)).to.equal(
      500_000_000n,
    );
  });

  it("returns 0 when window expired", () => {
    const counters = emptyProtocolCounters(10);
    counters[0] = {
      protocol: addressToBytes(PROTOCOL_A),
      windowStart: 100n,
      windowSpend: 500_000_000n,
    };

    // currentEpoch = 300, diff = 300 - 100 = 200 >= 144 → expired
    const nowUnix = 300n * EPOCH_DURATION;
    const tracker = makeTracker({ protocolCounters: counters });
    expect(getProtocolSpend(tracker, PROTOCOL_A, nowUnix)).to.equal(0n);
  });

  it("correctly handles byte comparison (Address <-> ReadonlyUint8Array)", () => {
    const counters = emptyProtocolCounters(10);
    counters[3] = {
      protocol: addressToBytes(PROTOCOL_A),
      windowStart: 200n,
      windowSpend: 123_456_789n,
    };

    const nowUnix = 250n * EPOCH_DURATION;
    const tracker = makeTracker({ protocolCounters: counters });
    expect(getProtocolSpend(tracker, PROTOCOL_A, nowUnix)).to.equal(
      123_456_789n,
    );
  });

  it("returns 0 for zero protocol bytes (empty slot)", () => {
    const tracker = makeTracker();
    // All counters have zero protocol bytes — should never match a real address
    expect(getProtocolSpend(tracker, PROTOCOL_A, 100000n)).to.equal(0n);
  });
});

// ─── bytesToAddress ──────────────────────────────────────────────────────────

describe("bytesToAddress", () => {
  it("round-trips encode -> decode", () => {
    const addr = AGENT_A;
    const bytes = addressToBytes(addr);
    const result = bytesToAddress(bytes);
    expect(result).to.equal(addr);
  });

  it("round-trips for a different known address", () => {
    const addr = PROTOCOL_A;
    const bytes = addressToBytes(addr);
    const result = bytesToAddress(bytes);
    expect(result).to.equal(addr);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("getRolling24hUsd handles negative windowStart (nowUnix < 86400)", () => {
    // nowUnix = 1000, windowStart = 1000 - 86400 = -85400
    // Bucket at epoch 0: bucketStart=0, bucketEnd=600
    // bucketEnd (600) > windowStart (-85400) → not skipped
    // bucketStart (0) >= windowStart (-85400) → fully inside
    const nowUnix = 1000n;
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(0n, 500_000n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 1n });
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(500_000n);
  });

  it("getRolling24hUsd handles very large amounts near u64 max", () => {
    const u64Max = (1n << 64n) - 1n; // 18446744073709551615
    const nowUnix = 200n * EPOCH_DURATION;
    const buckets = emptyBuckets(144);
    const idx = Number(200n % 144n);
    buckets[idx] = makeBucket(200n, u64Max);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 200n });
    // BigInt handles this without overflow — returns exact amount
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(u64Max);
  });

  it("getRolling24hUsd truncation matches Rust for non-divisible amounts", () => {
    // amount = 1, overlap = 1, duration = 600 → (1 * 1) / 600 = 0 (truncated)
    const nowUnix = 86700n; // windowStart = 300
    const buckets = emptyBuckets(144);
    // epoch 0: bucketStart=0, bucketEnd=600, overlap=300
    buckets[0] = makeBucket(0n, 1n);

    const tracker = makeTracker({ buckets, lastWriteEpoch: 144n });
    // (1n * 300n) / 600n = 0n (truncated, same as Rust)
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(0n);
  });

  it("getAgentRolling24hUsd returns 0 for nowUnix = 0", () => {
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[0] = 100_000_000n;
    const entry = makeContributionEntry({
      lastWriteEpoch: 0n,
      contributions,
    });
    expect(getAgentRolling24hUsd(entry, 0n)).to.equal(0n);
  });

  it("getAgentRolling24hUsd returns 0 for negative nowUnix", () => {
    const contributions = Array(24).fill(0n) as bigint[];
    contributions[0] = 100_000_000n;
    const entry = makeContributionEntry({
      lastWriteEpoch: 0n,
      contributions,
    });
    expect(getAgentRolling24hUsd(entry, -100n)).to.equal(0n);
  });

  it("getProtocolSpend returns 0 for nowUnix = 0", () => {
    const counters = emptyProtocolCounters(10);
    counters[0] = {
      protocol: addressToBytes(PROTOCOL_A),
      windowStart: 0n,
      windowSpend: 999n,
    };
    const tracker = makeTracker({ protocolCounters: counters });
    expect(getProtocolSpend(tracker, PROTOCOL_A, 0n)).to.equal(0n);
  });

  it("getRolling24hUsd with multiple boundary buckets sums correctly", () => {
    // Place two buckets that both straddle the window boundary
    // nowUnix = 86700, windowStart = 300
    // epoch 0: bucketStart=0, bucketEnd=600, overlap=300 → 50%
    // epoch -1 is impossible, but same-window edge:
    // Actually there can only be ONE boundary bucket (the oldest partial one)
    // Let's just verify the sum of a boundary + full bucket
    const nowUnix = 86700n;
    const buckets = emptyBuckets(144);
    buckets[0] = makeBucket(0n, 1_000_000n); // boundary: 50%
    buckets[1] = makeBucket(1n, 2_000_000n); // fully inside

    const tracker = makeTracker({ buckets, lastWriteEpoch: 144n });
    // boundary: (1_000_000 * 300) / 600 = 500_000
    // full: 2_000_000
    // total: 2_500_000
    expect(getRolling24hUsd(tracker, nowUnix)).to.equal(2_500_000n);
  });
});

// ─── resolveVaultState ───────────────────────────────────────────────────────

describe("resolveVaultState", () => {
  const VAULT_ADDR =
    "11111111111111111111111111111111" as Address;

  it("throws when vault does not exist", async () => {
    const rpc = {
      getMultipleAccounts: () => ({
        send: async () => ({
          value: [null, null, null, null, null],
        }),
      }),
    } as any;

    try {
      await resolveVaultState(rpc, VAULT_ADDR, AGENT_A, 100000n);
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e).to.be.an("error");
    }
  });

  it("EffectiveBudget type is correctly exported", () => {
    const budget: EffectiveBudget = {
      spent24h: 0n,
      cap: 1000n,
      remaining: 1000n,
    };
    expect(budget.remaining).to.equal(1000n);
  });

  it("ProtocolBudget extends EffectiveBudget with protocol field", () => {
    const budget: ProtocolBudget = {
      spent24h: 0n,
      cap: 1000n,
      remaining: 1000n,
      protocol: PROTOCOL_A,
    };
    expect(budget.protocol).to.equal(PROTOCOL_A);
  });
});
