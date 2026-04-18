import { expect } from "chai";
import {
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  MAX_DEVELOPER_FEE_RATE,
  USD_DECIMALS,
  MAX_AGENTS_PER_VAULT,
  MAX_ESCROW_DURATION,
  MAX_SLIPPAGE_BPS,
  EPOCH_DURATION,
  NUM_EPOCHS,
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  PROTOCOL_MODE_DENYLIST,
  FULL_CAPABILITY,
  FULL_PERMISSIONS,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  isStablecoinMint,
  parseActionType,
  isSpendingAction,
  getPositionEffect,
  normalizeNetwork,
  validateNetwork,
} from "../src/types.js";
import type { Address } from "@solana/kit";

describe("types", () => {
  describe("Constants", () => {
    it("FEE_RATE_DENOMINATOR = 1_000_000", () => {
      expect(FEE_RATE_DENOMINATOR).to.equal(1_000_000);
    });

    it("PROTOCOL_FEE_RATE = 200", () => {
      expect(PROTOCOL_FEE_RATE).to.equal(200);
    });

    it("MAX_DEVELOPER_FEE_RATE = 500", () => {
      expect(MAX_DEVELOPER_FEE_RATE).to.equal(500);
    });

    it("USD_DECIMALS = 6", () => {
      expect(USD_DECIMALS).to.equal(6);
    });

    it("MAX_AGENTS_PER_VAULT = 10", () => {
      expect(MAX_AGENTS_PER_VAULT).to.equal(10);
    });

    it("MAX_ESCROW_DURATION = 2_592_000", () => {
      expect(MAX_ESCROW_DURATION).to.equal(2_592_000);
    });

    it("MAX_SLIPPAGE_BPS = 5000", () => {
      expect(MAX_SLIPPAGE_BPS).to.equal(5_000);
    });

    it("EPOCH_DURATION = 600", () => {
      expect(EPOCH_DURATION).to.equal(600);
    });

    it("NUM_EPOCHS = 144", () => {
      expect(NUM_EPOCHS).to.equal(144);
    });

    it("PROTOCOL_MODE_ALL = 0, ALLOWLIST = 1, DENYLIST = 2", () => {
      expect(PROTOCOL_MODE_ALL).to.equal(0);
      expect(PROTOCOL_MODE_ALLOWLIST).to.equal(1);
      expect(PROTOCOL_MODE_DENYLIST).to.equal(2);
    });
  });

  describe("FULL_CAPABILITY / FULL_PERMISSIONS", () => {
    it("FULL_CAPABILITY equals 2n", () => {
      expect(FULL_CAPABILITY).to.equal(2n);
    });

    it("FULL_PERMISSIONS is an alias for FULL_CAPABILITY", () => {
      expect(FULL_PERMISSIONS).to.equal(FULL_CAPABILITY);
    });

    it("FULL_CAPABILITY has bits 0 and 1 set", () => {
      expect(FULL_CAPABILITY & 1n).to.equal(0n); // bit 0 NOT set (2n = 10 binary)
      expect(FULL_CAPABILITY & 2n).to.equal(2n); // bit 1 set
    });
  });

  // Legacy preset bitmasks (SWAP_ONLY, PERPS_ONLY, TRANSFER_ONLY,
  // ESCROW_ONLY, PERPS_FULL) + their helpers (hasPermission,
  // permissionsToStrings, stringsToPermissions, PermissionBuilder,
  // ACTION_PERMISSION_MAP) were DELETED in the A11 cleanup — the test
  // blocks that covered them went with them. The v6 program uses a 2-bit
  // capability enum, not a bitmask. See `FULL_CAPABILITY` tests above.

  describe("isStablecoinMint", () => {
    it("devnet USDC returns true", () => {
      expect(isStablecoinMint(USDC_MINT_DEVNET, "devnet")).to.be.true;
    });

    it("devnet USDT returns true", () => {
      expect(isStablecoinMint(USDT_MINT_DEVNET, "devnet")).to.be.true;
    });

    it("mainnet USDC returns true", () => {
      expect(isStablecoinMint(USDC_MINT_MAINNET, "mainnet-beta")).to.be.true;
    });

    it("mainnet USDT returns true", () => {
      expect(isStablecoinMint(USDT_MINT_MAINNET, "mainnet-beta")).to.be.true;
    });

    it("SOL returns false", () => {
      expect(
        isStablecoinMint(
          "So11111111111111111111111111111111111111112" as Address,
          "mainnet-beta",
        ),
      ).to.be.false;
    });

    it("random address returns false", () => {
      expect(
        isStablecoinMint(
          "11111111111111111111111111111111" as Address,
          "devnet",
        ),
      ).to.be.false;
    });
  });

  // `hasPermission` + `permissionsToStrings` blocks deleted in A11 — the
  // underlying 21-bit bitmask was replaced by a 2-bit capability enum
  // (see docstrings in `src/types.ts`). The helpers no longer exist.

  describe("parseActionType", () => {
    it("{ swap: {} } returns 'swap'", () => {
      expect(parseActionType({ swap: {} })).to.equal("swap");
    });

    it("empty object returns undefined", () => {
      expect(parseActionType({})).to.be.undefined;
    });

    it("multi-key returns first key", () => {
      const result = parseActionType({ openPosition: {}, closePosition: {} });
      expect(result).to.be.a("string");
    });

    it("numeric enum 0 maps to 'swap' (A11 refactor — plain array instead of ACTION_PERMISSION_MAP)", () => {
      expect(parseActionType(0)).to.equal("swap");
    });

    it("numeric enum 7 maps to 'transfer'", () => {
      expect(parseActionType(7)).to.equal("transfer");
    });

    it("numeric enum 20 maps to 'refundEscrow' (last valid index)", () => {
      expect(parseActionType(20)).to.equal("refundEscrow");
    });

    it("numeric enum out of range returns undefined", () => {
      expect(parseActionType(21)).to.be.undefined;
      expect(parseActionType(-1)).to.be.undefined;
      expect(parseActionType(999)).to.be.undefined;
    });
  });

  describe("isSpendingAction", () => {
    it("swap is spending", () => {
      expect(isSpendingAction("swap")).to.be.true;
    });

    it("closePosition is non-spending", () => {
      expect(isSpendingAction("closePosition")).to.be.false;
    });

    it("all 9 spending types verified", () => {
      const spending = [
        "swap",
        "openPosition",
        "increasePosition",
        "deposit",
        "transfer",
        "addCollateral",
        "placeLimitOrder",
        "swapAndOpenPosition",
        "createEscrow",
      ];
      for (const s of spending) {
        expect(isSpendingAction(s), `${s} should be spending`).to.be.true;
      }
    });

    it("all 12 non-spending types verified", () => {
      const nonSpending = [
        "closePosition",
        "decreasePosition",
        "withdraw",
        "removeCollateral",
        "placeTriggerOrder",
        "editTriggerOrder",
        "cancelTriggerOrder",
        "editLimitOrder",
        "cancelLimitOrder",
        "closeAndSwapPosition",
        "settleEscrow",
        "refundEscrow",
      ];
      for (const ns of nonSpending) {
        expect(isSpendingAction(ns), `${ns} should be non-spending`).to.be
          .false;
      }
    });
  });

  describe("getPositionEffect", () => {
    it("openPosition returns increment", () => {
      expect(getPositionEffect("openPosition")).to.equal("increment");
    });

    it("closePosition returns decrement", () => {
      expect(getPositionEffect("closePosition")).to.equal("decrement");
    });

    it("swap returns none", () => {
      expect(getPositionEffect("swap")).to.equal("none");
    });

    it("swapAndOpenPosition returns increment", () => {
      expect(getPositionEffect("swapAndOpenPosition")).to.equal("increment");
    });

    it("closeAndSwapPosition returns decrement", () => {
      expect(getPositionEffect("closeAndSwapPosition")).to.equal("decrement");
    });
  });

  // `PermissionBuilder` block deleted in A11 — see block comment above
  // at the "Preset bitmasks" deletion for full rationale.

  describe("normalizeNetwork", () => {
    it("passes devnet through unchanged", () => {
      expect(normalizeNetwork("devnet")).to.equal("devnet");
    });

    it("normalizes mainnet to mainnet-beta", () => {
      expect(normalizeNetwork("mainnet")).to.equal("mainnet-beta");
    });

    it("passes mainnet-beta through unchanged", () => {
      expect(normalizeNetwork("mainnet-beta")).to.equal("mainnet-beta");
    });
  });

  describe("validateNetwork", () => {
    it("accepts mainnet as valid input", () => {
      expect(() => validateNetwork("mainnet")).not.to.throw();
    });

    it("rejects invalid network strings", () => {
      expect(() => validateNetwork("testnet")).to.throw(/Invalid network/);
    });
  });

  // `stringsToPermissions` block deleted in A11 — the helper encoded the
  // pre-v6 21-bit bitmask and had no v6 equivalent (capability is a 2-bit
  // enum, not a string list). See `parseActionType` above for the only
  // surviving ActionType-name helper.
});
