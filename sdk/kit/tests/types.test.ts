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
  FULL_PERMISSIONS,
  SWAP_ONLY,
  PERPS_ONLY,
  TRANSFER_ONLY,
  ESCROW_ONLY,
  PERPS_FULL,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  isStablecoinMint,
  hasPermission,
  permissionsToStrings,
  parseActionType,
  isSpendingAction,
  getPositionEffect,
  PermissionBuilder,
  ACTION_PERMISSION_MAP,
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

  describe("FULL_PERMISSIONS", () => {
    it("equals (1n << 21n) - 1n", () => {
      expect(FULL_PERMISSIONS).to.equal((1n << 21n) - 1n);
    });

    it("has all 21 bits set", () => {
      for (let i = 0; i < 21; i++) {
        expect(FULL_PERMISSIONS & (1n << BigInt(i))).to.not.equal(0n);
      }
    });

    it("permissionsToStrings returns 21 strings", () => {
      const strings = permissionsToStrings(FULL_PERMISSIONS);
      expect(strings).to.have.length(21);
    });
  });

  describe("Preset bitmasks", () => {
    it("SWAP_ONLY has only bit 0", () => {
      expect(SWAP_ONLY).to.equal(1n << 0n);
      expect(permissionsToStrings(SWAP_ONLY)).to.deep.equal(["swap"]);
    });

    it("PERPS_ONLY has bits 1-4", () => {
      expect(PERPS_ONLY).to.equal(
        (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n),
      );
    });

    it("TRANSFER_ONLY has bit 7", () => {
      expect(TRANSFER_ONLY).to.equal(1n << 7n);
      expect(permissionsToStrings(TRANSFER_ONLY)).to.deep.equal(["transfer"]);
    });

    it("ESCROW_ONLY has bits 18-20", () => {
      expect(ESCROW_ONLY).to.equal(
        (1n << 18n) | (1n << 19n) | (1n << 20n),
      );
      const names = permissionsToStrings(ESCROW_ONLY);
      expect(names).to.include("createEscrow");
      expect(names).to.include("settleEscrow");
      expect(names).to.include("refundEscrow");
    });

    it("PERPS_FULL covers positions, collateral, triggers, limits", () => {
      const names = permissionsToStrings(PERPS_FULL);
      expect(names).to.include("openPosition");
      expect(names).to.include("closePosition");
      expect(names).to.include("addCollateral");
      expect(names).to.include("placeTriggerOrder");
      expect(names).to.include("placeLimitOrder");
      expect(names.length).to.be.greaterThan(10);
    });
  });

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

  describe("hasPermission", () => {
    it("single bit set returns true", () => {
      expect(hasPermission(SWAP_ONLY, "swap")).to.be.true;
    });

    it("all bits set returns true for any type", () => {
      expect(hasPermission(FULL_PERMISSIONS, "transfer")).to.be.true;
      expect(hasPermission(FULL_PERMISSIONS, "createEscrow")).to.be.true;
    });

    it("no bits set returns false", () => {
      expect(hasPermission(0n, "swap")).to.be.false;
    });

    it("unknown action type returns false", () => {
      expect(hasPermission(FULL_PERMISSIONS, "unknownAction")).to.be.false;
    });

    it("each of 21 action types is correctly mapped", () => {
      for (const [name, bit] of Object.entries(ACTION_PERMISSION_MAP)) {
        expect(hasPermission(bit, name)).to.be.true;
        expect(hasPermission(0n, name)).to.be.false;
      }
    });
  });

  describe("permissionsToStrings", () => {
    it("FULL_PERMISSIONS returns 21 strings", () => {
      expect(permissionsToStrings(FULL_PERMISSIONS)).to.have.length(21);
    });

    it("0n returns empty array", () => {
      expect(permissionsToStrings(0n)).to.deep.equal([]);
    });

    it("single bit returns single string", () => {
      expect(permissionsToStrings(1n << 7n)).to.deep.equal(["transfer"]);
    });
  });

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

  describe("PermissionBuilder", () => {
    it(".add('swap').build() = bit 0", () => {
      const perms = new PermissionBuilder().add("swap").build();
      expect(perms).to.equal(1n << 0n);
    });

    it("chained adds combine bits", () => {
      const perms = new PermissionBuilder()
        .add("swap")
        .add("transfer")
        .build();
      expect(perms).to.equal((1n << 0n) | (1n << 7n));
    });

    it(".remove() unsets bit", () => {
      const perms = new PermissionBuilder()
        .add("swap")
        .add("transfer")
        .remove("swap")
        .build();
      expect(hasPermission(perms, "swap")).to.be.false;
      expect(hasPermission(perms, "transfer")).to.be.true;
    });

    it("unknown action type silently ignored", () => {
      const perms = new PermissionBuilder()
        .add("nonexistent")
        .build();
      expect(perms).to.equal(0n);
    });
  });
});
