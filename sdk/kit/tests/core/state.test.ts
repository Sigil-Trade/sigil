import { expect } from "chai";
import { ShieldState, type ShieldStorage } from "../../src/core/index.js";

/** Simple in-memory mock storage */
function createMockStorage(): ShieldStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem(key: string): string | null {
      return data[key] ?? null;
    },
    setItem(key: string, value: string): void {
      data[key] = value;
    },
  };
}

describe("ShieldState", () => {
  describe("constructor", () => {
    it("creates state with no storage (in-memory only)", () => {
      // Pass null explicitly to bypass auto-detection
      const state = new ShieldState(undefined);
      expect(state).to.be.instanceOf(ShieldState);
    });

    it("loads persisted data from mock storage", () => {
      const storage = createMockStorage();
      // Pre-populate storage with spend data
      storage.setItem(
        "sigil:spends",
        JSON.stringify([
          { mint: "USDC", amount: "1000000", timestamp: Date.now() },
        ]),
      );
      storage.setItem("sigil:txs", JSON.stringify([]));

      const state = new ShieldState(storage);
      const spend = state.getSpendInWindow("USDC", 86_400_000);
      expect(spend).to.equal(BigInt(1_000_000));
    });
  });

  describe("recordSpend + getSpendInWindow", () => {
    it("returns correct amount within window", () => {
      const state = new ShieldState(undefined);
      state.recordSpend("USDC", BigInt(500_000));
      const spend = state.getSpendInWindow("USDC", 86_400_000);
      expect(spend).to.equal(BigInt(500_000));
    });

    it("ignores entries outside window", () => {
      const storage = createMockStorage();
      // Create entries with old timestamps
      const oldTimestamp = Date.now() - 100_000_000; // ~27 hours ago
      storage.setItem(
        "sigil:spends",
        JSON.stringify([
          { mint: "USDC", amount: "1000000", timestamp: oldTimestamp },
        ]),
      );
      storage.setItem("sigil:txs", JSON.stringify([]));

      const state = new ShieldState(storage);
      const spend = state.getSpendInWindow("USDC", 86_400_000);
      expect(spend).to.equal(BigInt(0));
    });

    it("sums multiple entries for same mint", () => {
      const state = new ShieldState(undefined);
      state.recordSpend("USDC", BigInt(100_000));
      state.recordSpend("USDC", BigInt(200_000));
      state.recordSpend("USDC", BigInt(300_000));

      const spend = state.getSpendInWindow("USDC", 86_400_000);
      expect(spend).to.equal(BigInt(600_000));
    });

    it("ignores entries for a different mint", () => {
      const state = new ShieldState(undefined);
      state.recordSpend("USDC", BigInt(100_000));
      state.recordSpend("SOL", BigInt(999_999));

      const spend = state.getSpendInWindow("USDC", 86_400_000);
      expect(spend).to.equal(BigInt(100_000));
    });
  });

  describe("recordTransaction + getTransactionCountInWindow", () => {
    it("counts transactions correctly", () => {
      const state = new ShieldState(undefined);
      state.recordTransaction();
      state.recordTransaction();
      state.recordTransaction();

      const count = state.getTransactionCountInWindow(3_600_000);
      expect(count).to.equal(3);
    });

    it("ignores old entries", () => {
      const storage = createMockStorage();
      const oldTimestamp = Date.now() - 7_200_000; // 2 hours ago
      storage.setItem(
        "sigil:txs",
        JSON.stringify([{ timestamp: oldTimestamp }]),
      );
      storage.setItem("sigil:spends", JSON.stringify([]));

      const state = new ShieldState(storage);
      const count = state.getTransactionCountInWindow(3_600_000);
      expect(count).to.equal(0);
    });
  });

  describe("pruneExpired", () => {
    it("removes old entries and keeps recent ones", () => {
      const storage = createMockStorage();
      const now = Date.now();
      storage.setItem(
        "sigil:spends",
        JSON.stringify([
          { mint: "USDC", amount: "100", timestamp: now - 200_000 },
          { mint: "USDC", amount: "200", timestamp: now },
        ]),
      );
      storage.setItem(
        "sigil:txs",
        JSON.stringify([{ timestamp: now - 200_000 }, { timestamp: now }]),
      );

      const state = new ShieldState(storage);
      state.pruneExpired(100_000); // prune anything older than 100s

      // Only the recent entry should remain
      const spend = state.getSpendInWindow("USDC", 300_000);
      expect(spend).to.equal(BigInt(200));
      const count = state.getTransactionCountInWindow(300_000);
      expect(count).to.equal(1);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const state = new ShieldState(undefined);
      state.recordSpend("USDC", BigInt(100_000));
      state.recordTransaction();

      state.reset();

      expect(state.getSpendInWindow("USDC", 86_400_000)).to.equal(BigInt(0));
      expect(state.getTransactionCountInWindow(3_600_000)).to.equal(0);
    });
  });

  describe("persistence round-trip", () => {
    it("survives reconstruction with same storage", () => {
      const storage = createMockStorage();
      const state1 = new ShieldState(storage);
      state1.recordSpend("USDC", BigInt(250_000));
      state1.recordTransaction();

      // Create new state with same storage
      const state2 = new ShieldState(storage);
      expect(state2.getSpendInWindow("USDC", 86_400_000)).to.equal(
        BigInt(250_000),
      );
      expect(state2.getTransactionCountInWindow(3_600_000)).to.equal(1);
    });
  });

  describe("MAX_SPEND_ENTRIES trimming", () => {
    it("keeps only 5000 entries when more are added", () => {
      const storage = createMockStorage();
      const state = new ShieldState(storage);

      // Add 5001 entries
      for (let i = 0; i < 5001; i++) {
        state.recordSpend("USDC", BigInt(1));
      }

      // Verify via storage — should have exactly 5000 entries
      const persisted = JSON.parse(storage.data["sigil:spends"]) as unknown[];
      expect(persisted.length).to.equal(5000);
    });
  });

  describe("corrupt JSON recovery", () => {
    it("gracefully recovers from corrupt storage data", () => {
      const storage = createMockStorage();
      storage.setItem("sigil:spends", "not valid json {{{");
      storage.setItem("sigil:txs", "also broken");

      const state = new ShieldState(storage);
      // Should start with empty state, not throw
      expect(state.getSpendInWindow("USDC", 86_400_000)).to.equal(BigInt(0));
      expect(state.getTransactionCountInWindow(3_600_000)).to.equal(0);
    });
  });
});
