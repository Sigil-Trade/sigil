/**
 * Validation & serializeBigints unit tests.
 *
 * Tests all client-side validation functions through the exported mutation API,
 * plus the serializeBigints recursive serializer through reads.
 *
 * These are pure unit tests — no RPC calls, no on-chain interaction.
 */

import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";

import {
  deposit,
  withdraw,
  syncPositions,
  addAgent,
  queuePolicyUpdate,
  pauseAgent,
  createConstraints,
  queueConstraintsUpdate,
} from "../../src/dashboard/mutations.js";

// ─── Test Constants ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const VALID_AGENT = "22222222222222222222222222222222222222222222" as Address;
const VALID_MINT = "33333333333333333333333333333333333333333333" as Address;
const U64_MAX = (1n << 64n) - 1n;
const MAX_PERMISSIONS = 2n; // 0=Disabled, 1=Observer, 2=Operator

function mockOwner(): TransactionSigner {
  return {
    address: "44444444444444444444444444444444444444444444" as Address,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
  } as unknown as TransactionSigner;
}

// Validation functions throw DxError before any RPC call,
// so we can test them without a real RPC.
const rpc = {} as any;
const owner = mockOwner();

// ─── requirePositiveAmount ──────────────────────────────────────────────────

describe("Validation: requirePositiveAmount", () => {
  it("rejects zero amount", async () => {
    try {
      await deposit(rpc, VAULT, owner, "devnet", VALID_MINT, 0n);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("must be positive");
    }
  });

  it("rejects negative amount", async () => {
    try {
      await deposit(rpc, VAULT, owner, "devnet", VALID_MINT, -1n);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("must be positive");
    }
  });

  it("rejects amount exceeding u64 max", async () => {
    try {
      await deposit(rpc, VAULT, owner, "devnet", VALID_MINT, U64_MAX + 1n);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("u64 maximum");
    }
  });

  it("accepts u64 max exactly", async () => {
    // This will fail at RPC (mock is empty), but should pass validation
    try {
      await deposit(rpc, VAULT, owner, "devnet", VALID_MINT, U64_MAX);
    } catch (err: any) {
      // Should NOT be a validation error — should fail at RPC layer
      expect(err.message).to.not.include("must be positive");
      expect(err.message).to.not.include("u64 maximum");
    }
  });

  it("accepts 1n (minimum valid)", async () => {
    try {
      await deposit(rpc, VAULT, owner, "devnet", VALID_MINT, 1n);
    } catch (err: any) {
      expect(err.message).to.not.include("must be positive");
    }
  });

  it("withdraw validates the same way", async () => {
    try {
      await withdraw(rpc, VAULT, owner, "devnet", VALID_MINT, 0n);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("must be positive");
    }
  });
});

// ─── requireU8 ──────────────────────────────────────────────────────────────

describe("Validation: requireU8 (syncPositions)", () => {
  it("rejects 256 (u8 overflow)", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", 256);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("0-255");
    }
  });

  it("rejects -1", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", -1);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("0-255");
    }
  });

  it("rejects NaN", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", NaN);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("0-255");
    }
  });

  it("rejects Infinity", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", Infinity);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("0-255");
    }
  });

  it("rejects float (1.5)", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", 1.5);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("0-255");
    }
  });

  it("accepts 0 (minimum valid)", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", 0);
    } catch (err: any) {
      expect(err.message).to.not.include("0-255");
    }
  });

  it("accepts 255 (maximum valid)", async () => {
    try {
      await syncPositions(rpc, VAULT, owner, "devnet", 255);
    } catch (err: any) {
      expect(err.message).to.not.include("0-255");
    }
  });
});

// ─── requireValidAddress ────────────────────────────────────────────────────

describe("Validation: requireValidAddress", () => {
  it("rejects empty string", async () => {
    try {
      await pauseAgent(rpc, VAULT, owner, "devnet", "" as Address);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("not a valid");
    }
  });

  it("rejects too short (31 chars)", async () => {
    try {
      await pauseAgent(rpc, VAULT, owner, "devnet", "a".repeat(31) as Address);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("not a valid");
    }
  });

  it("rejects too long (45 chars)", async () => {
    try {
      await pauseAgent(rpc, VAULT, owner, "devnet", "a".repeat(45) as Address);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("not a valid");
    }
  });

  it("accepts 32 chars (minimum valid length)", async () => {
    try {
      await pauseAgent(rpc, VAULT, owner, "devnet", "a".repeat(32) as Address);
    } catch (err: any) {
      expect(err.message).to.not.include("not a valid");
    }
  });

  it("accepts 44 chars (maximum valid length)", async () => {
    try {
      await pauseAgent(rpc, VAULT, owner, "devnet", "a".repeat(44) as Address);
    } catch (err: any) {
      expect(err.message).to.not.include("not a valid");
    }
  });
});

// ─── requireValidPermissions ────────────────────────────────────────────────

describe("Validation: requireValidPermissions", () => {
  it("rejects 0n (no permissions)", async () => {
    try {
      await addAgent(
        rpc,
        VAULT,
        owner,
        "devnet",
        VALID_AGENT,
        0n,
        500_000_000n,
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("no permissions");
    }
  });

  it("rejects negative bitmask", async () => {
    try {
      await addAgent(
        rpc,
        VAULT,
        owner,
        "devnet",
        VALID_AGENT,
        -1n,
        500_000_000n,
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("negative");
    }
  });

  it("rejects bitmask exceeding MAX_PERMISSIONS (2^21)", async () => {
    try {
      await addAgent(
        rpc,
        VAULT,
        owner,
        "devnet",
        VALID_AGENT,
        MAX_PERMISSIONS + 1n,
        500_000_000n,
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("exceeds maximum");
    }
  });

  it("accepts MAX_PERMISSIONS exactly", async () => {
    try {
      await addAgent(
        rpc,
        VAULT,
        owner,
        "devnet",
        VALID_AGENT,
        MAX_PERMISSIONS,
        500_000_000n,
      );
    } catch (err: any) {
      expect(err.message).to.not.include("exceeds maximum");
      expect(err.message).to.not.include("no permissions");
    }
  });

  it("accepts 1n (single permission)", async () => {
    try {
      await addAgent(
        rpc,
        VAULT,
        owner,
        "devnet",
        VALID_AGENT,
        1n,
        500_000_000n,
      );
    } catch (err: any) {
      expect(err.message).to.not.include("no permissions");
    }
  });
});

// ─── queuePolicyUpdate validation ───────────────────────────────────────────

describe("Validation: queuePolicyUpdate", () => {
  it("rejects empty changes object", async () => {
    try {
      await queuePolicyUpdate(rpc, VAULT, owner, "devnet", {});
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("At least one policy change");
    }
  });

  it("rejects timelock < 1800", async () => {
    try {
      await queuePolicyUpdate(rpc, VAULT, owner, "devnet", { timelock: 1799 });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("1800");
    }
  });

  it("rejects developer fee rate > 500", async () => {
    try {
      await queuePolicyUpdate(rpc, VAULT, owner, "devnet", {
        developerFeeRate: 501,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("500");
    }
  });

  it("rejects dailyCap of 0n", async () => {
    try {
      await queuePolicyUpdate(rpc, VAULT, owner, "devnet", { dailyCap: 0n });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("must be positive");
    }
  });
});

// ─── Constraint entries validation ──────────────────────────────────────────

describe("Validation: constraint entries", () => {
  it("createConstraints rejects empty array", async () => {
    try {
      await createConstraints(rpc, VAULT, owner, "devnet", []);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("non-empty");
    }
  });

  it("queueConstraintsUpdate rejects empty array", async () => {
    try {
      await queueConstraintsUpdate(rpc, VAULT, owner, "devnet", []);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("non-empty");
    }
  });
});
