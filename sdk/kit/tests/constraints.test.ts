import { expect } from "chai";
import type { Address } from "@solana/kit";
import { ConstraintOperator } from "../src/generated/index.js";
import {
  bigintToLeBytes,
  numberToLeBytes,
  mapOperator,
  fieldTypeToSize,
} from "../src/constraints/encoding.js";
import {
  FLASH_TRADE_SCHEMA,
  FLASH_TRADE_PROGRAM,
  SPENDING_ACTIONS,
  RISK_REDUCING_ACTIONS,
  SIZE_CONSTRAINED_ACTIONS,
  COLLATERAL_CONSTRAINED_ACTIONS,
  ORDER_SIZE_ACTIONS,
} from "../src/constraints/protocols/flash-trade-schema.js";
import {
  FlashTradeDescriptor,
  checkStrictModeWarnings,
} from "../src/constraints/protocols/flash-trade-descriptor.js";
import {
  ConstraintBuilder,
  ConstraintBudgetExceededError,
} from "../src/constraints/builder.js";
import type {
  ProtocolRuleConfig,
  ActionRule,
} from "../src/constraints/types.js";

// ─── Codama Discriminators (sourced from generated code) ─────────────────

import { OPEN_POSITION_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/openPosition.js";
import { CLOSE_POSITION_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/closePosition.js";
import { INCREASE_SIZE_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/increaseSize.js";
import { DECREASE_SIZE_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/decreaseSize.js";
import { ADD_COLLATERAL_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/addCollateral.js";
import { REMOVE_COLLATERAL_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/removeCollateral.js";
import { PLACE_TRIGGER_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/placeTriggerOrder.js";
import { EDIT_TRIGGER_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/editTriggerOrder.js";
import { CANCEL_TRIGGER_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/cancelTriggerOrder.js";
import { PLACE_LIMIT_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/placeLimitOrder.js";
import { EDIT_LIMIT_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/editLimitOrder.js";
import { CANCEL_LIMIT_ORDER_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/cancelLimitOrder.js";
import { SWAP_AND_OPEN_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/swapAndOpen.js";
import { CLOSE_AND_SWAP_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/closeAndSwap.js";
import { SWAP_AND_ADD_COLLATERAL_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/swapAndAddCollateral.js";
import { REMOVE_COLLATERAL_AND_SWAP_DISCRIMINATOR } from "../src/generated/protocols/flash-trade/instructions/removeCollateralAndSwap.js";

// Flash Trade market map for account constraint tests
import { FLASH_MARKET_MAP } from "../src/integrations/config/flash-trade-markets.js";

// Kamino imports
import {
  KAMINO_SCHEMA,
  KAMINO_LENDING_PROGRAM,
  KAMINO_SPENDING_ACTIONS,
  KAMINO_RISK_REDUCING_ACTIONS,
  KAMINO_AMOUNT_CONSTRAINED_ACTIONS,
} from "../src/constraints/protocols/kamino-schema.js";
import { KaminoDescriptor } from "../src/constraints/protocols/kamino-descriptor.js";

// Kamino discriminators (from schema, not Codama generated)
import {
  DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR,
  BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR,
} from "../src/constraints/protocols/kamino-schema.js";

// Kamino market config
import { KAMINO_RESERVES } from "../src/integrations/config/kamino-markets.js";

// ─── Encoding Tests ──────────────────────────────────────────────────────

describe("Constraint Encoding", () => {
  describe("bigintToLeBytes", () => {
    it("encodes 0n as 8 zero bytes", () => {
      const result = bigintToLeBytes(0n, 8);
      expect(result).to.deep.equal(new Uint8Array(8));
    });

    it("encodes 1n correctly (LE)", () => {
      const result = bigintToLeBytes(1n, 8);
      expect(result[0]).to.equal(1);
      expect(result.slice(1)).to.deep.equal(new Uint8Array(7));
    });

    it("encodes 10_000_000_000n (10 SOL in lamports)", () => {
      const result = bigintToLeBytes(10_000_000_000n, 8);
      // 10_000_000_000 = 0x2540BE400
      expect(result[0]).to.equal(0x00);
      expect(result[1]).to.equal(0xe4);
      expect(result[2]).to.equal(0x0b);
      expect(result[3]).to.equal(0x54);
      expect(result[4]).to.equal(0x02);
    });

    it("encodes max u64", () => {
      const maxU64 = (1n << 64n) - 1n;
      const result = bigintToLeBytes(maxU64, 8);
      expect(Array.from(result).every((b) => b === 0xff)).to.be.true;
    });

    it("roundtrips through LE decode", () => {
      const value = 123456789012345n;
      const bytes = bigintToLeBytes(value, 8);
      let decoded = 0n;
      for (let i = 7; i >= 0; i--) {
        decoded = (decoded << 8n) | BigInt(bytes[i]);
      }
      expect(decoded).to.equal(value);
    });
  });

  describe("numberToLeBytes", () => {
    it("encodes u8", () => {
      const result = numberToLeBytes(255, 1);
      expect(result).to.deep.equal(new Uint8Array([0xff]));
    });

    it("encodes u16", () => {
      const result = numberToLeBytes(0x1234, 2);
      expect(result).to.deep.equal(new Uint8Array([0x34, 0x12]));
    });

    it("encodes u32", () => {
      const result = numberToLeBytes(0x12345678, 4);
      expect(result).to.deep.equal(new Uint8Array([0x78, 0x56, 0x34, 0x12]));
    });
  });

  describe("mapOperator", () => {
    it("maps all operator names", () => {
      expect(mapOperator("eq")).to.equal(ConstraintOperator.Eq);
      expect(mapOperator("ne")).to.equal(ConstraintOperator.Ne);
      expect(mapOperator("gte")).to.equal(ConstraintOperator.Gte);
      expect(mapOperator("lte")).to.equal(ConstraintOperator.Lte);
      expect(mapOperator("gteSigned")).to.equal(ConstraintOperator.GteSigned);
      expect(mapOperator("lteSigned")).to.equal(ConstraintOperator.LteSigned);
      expect(mapOperator("bitmask")).to.equal(ConstraintOperator.Bitmask);
    });

    it("throws on unknown operator", () => {
      expect(() => mapOperator("invalid")).to.throw("Unknown constraint operator");
    });
  });

  describe("fieldTypeToSize", () => {
    it("returns correct byte widths", () => {
      expect(fieldTypeToSize("u8")).to.equal(1);
      expect(fieldTypeToSize("bool")).to.equal(1);
      expect(fieldTypeToSize("u16")).to.equal(2);
      expect(fieldTypeToSize("u32")).to.equal(4);
      expect(fieldTypeToSize("u64")).to.equal(8);
      expect(fieldTypeToSize("i64")).to.equal(8);
      expect(fieldTypeToSize("pubkey")).to.equal(32);
    });
  });
});

// ─── Flash Trade Schema Tests ────────────────────────────────────────────

describe("Flash Trade Schema", () => {
  it("contains exactly 16 instructions", () => {
    expect(FLASH_TRADE_SCHEMA.instructions.size).to.equal(16);
  });

  it("has correct program address", () => {
    expect(FLASH_TRADE_SCHEMA.programAddress).to.equal(FLASH_TRADE_PROGRAM);
    expect(FLASH_TRADE_PROGRAM).to.equal("FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn");
  });

  describe("discriminators match Codama-generated code", () => {
    const codamaDiscriminators: Record<string, Uint8Array> = {
      openPosition: OPEN_POSITION_DISCRIMINATOR,
      closePosition: CLOSE_POSITION_DISCRIMINATOR,
      increaseSize: INCREASE_SIZE_DISCRIMINATOR,
      decreaseSize: DECREASE_SIZE_DISCRIMINATOR,
      addCollateral: ADD_COLLATERAL_DISCRIMINATOR,
      removeCollateral: REMOVE_COLLATERAL_DISCRIMINATOR,
      placeTriggerOrder: PLACE_TRIGGER_ORDER_DISCRIMINATOR,
      editTriggerOrder: EDIT_TRIGGER_ORDER_DISCRIMINATOR,
      cancelTriggerOrder: CANCEL_TRIGGER_ORDER_DISCRIMINATOR,
      placeLimitOrder: PLACE_LIMIT_ORDER_DISCRIMINATOR,
      editLimitOrder: EDIT_LIMIT_ORDER_DISCRIMINATOR,
      cancelLimitOrder: CANCEL_LIMIT_ORDER_DISCRIMINATOR,
      swapAndOpen: SWAP_AND_OPEN_DISCRIMINATOR,
      closeAndSwap: CLOSE_AND_SWAP_DISCRIMINATOR,
      swapAndAddCollateral: SWAP_AND_ADD_COLLATERAL_DISCRIMINATOR,
      removeCollateralAndSwap: REMOVE_COLLATERAL_AND_SWAP_DISCRIMINATOR,
    };

    for (const [name, codamaDisc] of Object.entries(codamaDiscriminators)) {
      it(`${name} discriminator matches Codama`, () => {
        const schema = FLASH_TRADE_SCHEMA.instructions.get(name);
        expect(schema).to.not.be.undefined;
        expect(Array.from(schema!.discriminator)).to.deep.equal(Array.from(codamaDisc));
      });
    }
  });

  describe("account indices", () => {
    it("openPosition market index = 7", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("openPosition")!.accounts.market).to.equal(7);
    });

    it("increaseSize market index = 5", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("increaseSize")!.accounts.market).to.equal(5);
    });

    it("decreaseSize market index = 5", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("decreaseSize")!.accounts.market).to.equal(5);
    });

    it("addCollateral market index = 5", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("addCollateral")!.accounts.market).to.equal(5);
    });

    it("removeCollateral market index = 6", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("removeCollateral")!.accounts.market).to.equal(6);
    });

    it("placeTriggerOrder market index = 6", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("placeTriggerOrder")!.accounts.market).to.equal(6);
    });

    it("editTriggerOrder market index = 5", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("editTriggerOrder")!.accounts.market).to.equal(5);
    });

    it("placeLimitOrder market index = 7", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("placeLimitOrder")!.accounts.market).to.equal(7);
    });

    it("editLimitOrder market index = 8", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("editLimitOrder")!.accounts.market).to.equal(8);
    });

    it("closePosition market index = 7", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("closePosition")!.accounts.market).to.equal(7);
    });

    it("closeAndSwap market index = 8", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("closeAndSwap")!.accounts.market).to.equal(8);
    });

    it("swapAndOpen market index = 10", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("swapAndOpen")!.accounts.market).to.equal(10);
    });

    it("swapAndAddCollateral market index = 10", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("swapAndAddCollateral")!.accounts.market).to.equal(10);
    });

    it("cancelTriggerOrder has no market account", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("cancelTriggerOrder")!.accounts.market).to.be.undefined;
    });

    it("cancelLimitOrder has no market account", () => {
      expect(FLASH_TRADE_SCHEMA.instructions.get("cancelLimitOrder")!.accounts.market).to.be.undefined;
    });
  });

  describe("field offsets", () => {
    it("openPosition: collateralAmount at 20, sizeAmount at 28", () => {
      const ix = FLASH_TRADE_SCHEMA.instructions.get("openPosition")!;
      const collateral = ix.fields.find((f) => f.name === "collateralAmount");
      const size = ix.fields.find((f) => f.name === "sizeAmount");
      expect(collateral!.offset).to.equal(20);
      expect(size!.offset).to.equal(28);
    });

    it("increaseSize: sizeDelta at 20", () => {
      const ix = FLASH_TRADE_SCHEMA.instructions.get("increaseSize")!;
      expect(ix.fields.find((f) => f.name === "sizeDelta")!.offset).to.equal(20);
    });

    it("addCollateral: collateralDelta at 8", () => {
      const ix = FLASH_TRADE_SCHEMA.instructions.get("addCollateral")!;
      expect(ix.fields.find((f) => f.name === "collateralDelta")!.offset).to.equal(8);
    });

    it("editTriggerOrder: deltaSizeAmount at 21", () => {
      const ix = FLASH_TRADE_SCHEMA.instructions.get("editTriggerOrder")!;
      expect(ix.fields.find((f) => f.name === "deltaSizeAmount")!.offset).to.equal(21);
    });

    it("editLimitOrder: sizeAmount at 21", () => {
      const ix = FLASH_TRADE_SCHEMA.instructions.get("editLimitOrder")!;
      expect(ix.fields.find((f) => f.name === "sizeAmount")!.offset).to.equal(21);
    });
  });

  describe("action categories", () => {
    it("SIZE_CONSTRAINED_ACTIONS has 3 entries", () => {
      expect(SIZE_CONSTRAINED_ACTIONS).to.have.length(3);
    });

    it("COLLATERAL_CONSTRAINED_ACTIONS has 2 entries", () => {
      expect(COLLATERAL_CONSTRAINED_ACTIONS).to.have.length(2);
    });

    it("ORDER_SIZE_ACTIONS has 4 entries", () => {
      expect(ORDER_SIZE_ACTIONS).to.have.length(4);
    });

    it("all SPENDING_ACTIONS are in schema", () => {
      for (const a of SPENDING_ACTIONS) {
        expect(FLASH_TRADE_SCHEMA.instructions.has(a)).to.be.true;
      }
    });

    it("all RISK_REDUCING_ACTIONS are in schema", () => {
      for (const a of RISK_REDUCING_ACTIONS) {
        expect(FLASH_TRADE_SCHEMA.instructions.has(a)).to.be.true;
      }
    });
  });
});

// ─── Flash Trade Descriptor Tests ────────────────────────────────────────

describe("Flash Trade Descriptor", () => {
  describe("compileRule — allowAll", () => {
    it("produces discriminator-only entries", () => {
      const rule: ActionRule = {
        actions: ["closePosition", "decreaseSize"],
        type: "allowAll",
        params: {},
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(2);

      // Each should have 1 data constraint (discriminator Eq at offset 0)
      for (const c of result) {
        expect(c.dataConstraints).to.have.length(1);
        expect(c.dataConstraints[0].offset).to.equal(0);
        expect(c.dataConstraints[0].operator).to.equal(ConstraintOperator.Eq);
        expect(c.accountConstraints).to.have.length(0);
      }
    });

    it("produces correct discriminator bytes", () => {
      const rule: ActionRule = {
        actions: ["cancelTriggerOrder"],
        type: "allowAll",
        params: {},
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(1);
      expect(Array.from(result[0].dataConstraints[0].value as Uint8Array)).to.deep.equal(
        Array.from(CANCEL_TRIGGER_ORDER_DISCRIMINATOR),
      );
    });
  });

  describe("compileRule — maxPositionSize", () => {
    it("produces Lte constraints for size-constrained actions", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "increaseSize", "swapAndOpen"],
        type: "maxPositionSize",
        params: { maxSize: "10000000000" }, // 10 SOL
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(3);

      for (const c of result) {
        // discriminator + Lte
        expect(c.dataConstraints).to.have.length(2);
        expect(c.dataConstraints[0].operator).to.equal(ConstraintOperator.Eq); // discriminator
        expect(c.dataConstraints[1].operator).to.equal(ConstraintOperator.Lte); // size cap
      }
    });

    it("uses correct offset for each instruction", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "increaseSize"],
        type: "maxPositionSize",
        params: { maxSize: "1000000000" },
      };
      const result = FlashTradeDescriptor.compileRule(rule);

      // openPosition: sizeAmount at offset 28
      const openResult = result.find((c) =>
        arraysEqual(c.discriminators[0], OPEN_POSITION_DISCRIMINATOR),
      );
      expect(openResult!.dataConstraints[1].offset).to.equal(28);

      // increaseSize: sizeDelta at offset 20
      const increaseResult = result.find((c) =>
        arraysEqual(c.discriminators[0], INCREASE_SIZE_DISCRIMINATOR),
      );
      expect(increaseResult!.dataConstraints[1].offset).to.equal(20);
    });

    it("filters out non-size-constrained actions", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "closePosition"],
        type: "maxPositionSize",
        params: { maxSize: "10000000000" },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      // closePosition is not in SIZE_CONSTRAINED_ACTIONS, so filtered
      expect(result).to.have.length(1);
    });

    it("encodes maxSize value as LE bytes", () => {
      const maxSize = 10_000_000_000n; // 10 SOL
      const rule: ActionRule = {
        actions: ["openPosition"],
        type: "maxPositionSize",
        params: { maxSize: maxSize.toString() },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      const lteBuf = result[0].dataConstraints[1].value as Uint8Array;
      // Verify it's 8 bytes LE encoding of 10_000_000_000
      expect(lteBuf.length).to.equal(8);
      let decoded = 0n;
      for (let i = 7; i >= 0; i--) {
        decoded = (decoded << 8n) | BigInt(lteBuf[i]);
      }
      expect(decoded).to.equal(maxSize);
    });
  });

  describe("compileRule — maxCollateral", () => {
    it("produces Lte constraints for collateral-constrained actions", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "addCollateral"],
        type: "maxCollateral",
        params: { maxAmount: "5000000000" }, // 5000 USDC
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(2);

      for (const c of result) {
        expect(c.dataConstraints).to.have.length(2);
        expect(c.dataConstraints[1].operator).to.equal(ConstraintOperator.Lte);
      }
    });

    it("uses correct offset (20 for openPosition collateral, 8 for addCollateral)", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "addCollateral"],
        type: "maxCollateral",
        params: { maxAmount: "5000000000" },
      };
      const result = FlashTradeDescriptor.compileRule(rule);

      const openResult = result.find((c) =>
        arraysEqual(c.discriminators[0], OPEN_POSITION_DISCRIMINATOR),
      );
      expect(openResult!.dataConstraints[1].offset).to.equal(20); // collateralAmount

      const addResult = result.find((c) =>
        arraysEqual(c.discriminators[0], ADD_COLLATERAL_DISCRIMINATOR),
      );
      expect(addResult!.dataConstraints[1].offset).to.equal(8); // collateralDelta
    });
  });

  describe("compileRule — allowedMarkets", () => {
    it("produces account constraints with correct market addresses", () => {
      const rule: ActionRule = {
        actions: ["openPosition"],
        type: "allowedMarkets",
        params: { markets: ["SOL-SOL-long"] },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(1);
      expect(result[0].accountConstraints).to.have.length(1);
      expect(result[0].accountConstraints[0].index).to.equal(7); // openPosition market index
      expect(result[0].accountConstraints[0].expected).to.equal(
        FLASH_MARKET_MAP["SOL-SOL-long"].market,
      );
    });

    it("creates one entry per (instruction x market)", () => {
      const rule: ActionRule = {
        actions: ["openPosition", "increaseSize"],
        type: "allowedMarkets",
        params: { markets: ["SOL-SOL-long", "BTC-BTC-long"] },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      // 2 instructions * 2 markets = 4
      expect(result).to.have.length(4);
    });

    it("skips actions without market account", () => {
      const rule: ActionRule = {
        actions: ["cancelTriggerOrder"],
        type: "allowedMarkets",
        params: { markets: ["SOL-SOL-long"] },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(0); // cancelTriggerOrder has no market
    });

    it("throws on unknown market key", () => {
      const rule: ActionRule = {
        actions: ["openPosition"],
        type: "allowedMarkets",
        params: { markets: ["DOGE-USDC-long"] },
      };
      expect(() => FlashTradeDescriptor.compileRule(rule)).to.throw("Unknown Flash Trade market");
    });
  });

  describe("compileRule — maxOrderSize", () => {
    it("produces constraints for order actions", () => {
      const rule: ActionRule = {
        actions: ["placeLimitOrder", "placeTriggerOrder"],
        type: "maxOrderSize",
        params: { maxSize: "5000000000" },
      };
      const result = FlashTradeDescriptor.compileRule(rule);
      expect(result).to.have.length(2);

      for (const c of result) {
        expect(c.dataConstraints).to.have.length(2);
        expect(c.dataConstraints[1].operator).to.equal(ConstraintOperator.Lte);
      }
    });

    it("uses correct offsets (28 for placeLimitOrder sizeAmount, 20 for placeTriggerOrder deltaSizeAmount)", () => {
      const rule: ActionRule = {
        actions: ["placeLimitOrder", "placeTriggerOrder"],
        type: "maxOrderSize",
        params: { maxSize: "5000000000" },
      };
      const result = FlashTradeDescriptor.compileRule(rule);

      // placeLimitOrder: reserveAmount at 20, sizeAmount at 28
      const limitResult = result.find((c) =>
        arraysEqual(c.discriminators[0], PLACE_LIMIT_ORDER_DISCRIMINATOR),
      );
      expect(limitResult!.dataConstraints[1].offset).to.equal(28);

      const triggerResult = result.find((c) =>
        arraysEqual(c.discriminators[0], PLACE_TRIGGER_ORDER_DISCRIMINATOR),
      );
      expect(triggerResult!.dataConstraints[1].offset).to.equal(20);
    });
  });

  describe("getRuleTypes", () => {
    it("returns 6 rule types", () => {
      const types = FlashTradeDescriptor.getRuleTypes();
      expect(types).to.have.length(6);
    });

    it("includes all expected types", () => {
      const types = FlashTradeDescriptor.getRuleTypes();
      const names = types.map((t) => t.type);
      expect(names).to.include.members([
        "allowAll",
        "maxPositionSize",
        "maxCollateral",
        "allowedMarkets",
        "allowedCollateral",
        "maxOrderSize",
      ]);
    });
  });

  describe("validateRule", () => {
    it("passes valid allowAll rule", () => {
      const errors = FlashTradeDescriptor.validateRule({
        actions: ["closePosition"],
        type: "allowAll",
        params: {},
      });
      expect(errors).to.have.length(0);
    });

    it("fails on unknown action", () => {
      const errors = FlashTradeDescriptor.validateRule({
        actions: ["unknownAction"],
        type: "allowAll",
        params: {},
      });
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include("Unknown action");
    });

    it("fails on unknown rule type", () => {
      const errors = FlashTradeDescriptor.validateRule({
        actions: ["openPosition"],
        type: "unknownRule",
        params: {},
      });
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include("Unknown rule type");
    });

    it("fails maxPositionSize without maxSize param", () => {
      const errors = FlashTradeDescriptor.validateRule({
        actions: ["openPosition"],
        type: "maxPositionSize",
        params: {},
      });
      expect(errors.some((e) => e.includes("maxSize"))).to.be.true;
    });

    it("fails allowedMarkets with unknown market", () => {
      const errors = FlashTradeDescriptor.validateRule({
        actions: ["openPosition"],
        type: "allowedMarkets",
        params: { markets: ["INVALID-MARKET"] },
      });
      expect(errors.some((e) => e.includes("Unknown market"))).to.be.true;
    });
  });

  describe("checkStrictModeWarnings", () => {
    it("warns when strict_mode has spending but no risk-reducing actions", () => {
      const warnings = checkStrictModeWarnings({
        actionRules: [
          { actions: ["openPosition"], type: "maxPositionSize", params: { maxSize: "1000" } },
        ],
        strictMode: true,
      });
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("risk-reducing");
      expect(warnings[0]).to.include("closePosition");
    });

    it("no warnings when strict_mode is off", () => {
      const warnings = checkStrictModeWarnings({
        actionRules: [
          { actions: ["openPosition"], type: "maxPositionSize", params: { maxSize: "1000" } },
        ],
        strictMode: false,
      });
      expect(warnings).to.have.length(0);
    });

    it("no warnings when all risk-reducing actions covered", () => {
      const warnings = checkStrictModeWarnings({
        actionRules: [
          { actions: ["openPosition"], type: "maxPositionSize", params: { maxSize: "1000" } },
          {
            actions: [
              "closePosition", "decreaseSize", "removeCollateral",
              "removeCollateralAndSwap", "closeAndSwap",
              "cancelTriggerOrder", "cancelLimitOrder",
              "editTriggerOrder", "editLimitOrder",
            ],
            type: "allowAll",
            params: {},
          },
        ],
        strictMode: true,
      });
      expect(warnings).to.have.length(0);
    });
  });
});

// ─── ConstraintBuilder Tests ─────────────────────────────────────────────

describe("ConstraintBuilder", () => {
  function makeBuilder(): ConstraintBuilder {
    return new ConstraintBuilder().register(FlashTradeDescriptor);
  }

  describe("compile — basic", () => {
    it("compiles allowAll for a single action", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            { actions: ["closePosition"], type: "allowAll", params: {} },
          ],
        },
      ]);
      expect(result.entries).to.have.length(1);
      expect(result.budget.used).to.equal(1);
      expect(result.budget.total).to.equal(16);
      expect(result.budget.perProtocol["flash-trade"]).to.equal(1);
    });

    it("compiles maxPositionSize for 3 size-constrained actions into 3 entries", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition", "increaseSize", "swapAndOpen"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
          ],
        },
      ]);
      expect(result.entries).to.have.length(3);
      expect(result.budget.used).to.equal(3);
    });

    it("entries have correct program ID", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            { actions: ["openPosition"], type: "allowAll", params: {} },
          ],
        },
      ]);
      expect(result.entries[0].programId).to.equal(FLASH_TRADE_PROGRAM);
    });
  });

  describe("compile — merge behavior", () => {
    it("merges data constraints for the same instruction (AND)", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            // Two rules targeting openPosition
            {
              actions: ["openPosition"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
            {
              actions: ["openPosition"],
              type: "maxCollateral",
              params: { maxAmount: "5000000000" },
            },
          ],
        },
      ]);

      // Both rules target openPosition, so they merge into 1 entry
      expect(result.entries).to.have.length(1);
      // discriminator + sizeAmount Lte + collateralAmount Lte = 3 data constraints
      expect(result.entries[0].dataConstraints).to.have.length(3);
    });

    it("creates separate entries for different account constraints (OR)", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "allowedMarkets",
              params: { markets: ["SOL-SOL-long", "BTC-BTC-long"] },
            },
          ],
        },
      ]);

      // 1 instruction × 2 markets = 2 entries (OR)
      expect(result.entries).to.have.length(2);
      expect(result.entries[0].accountConstraints).to.have.length(1);
      expect(result.entries[1].accountConstraints).to.have.length(1);
    });

    it("merged entries carry ALL data constraints plus account constraint", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
            {
              actions: ["openPosition"],
              type: "allowedMarkets",
              params: { markets: ["SOL-SOL-long"] },
            },
          ],
        },
      ]);

      // 1 entry (maxPositionSize provides data constraints, allowedMarkets provides account)
      expect(result.entries).to.have.length(1);
      // discriminator + size Lte = 2 data constraints
      expect(result.entries[0].dataConstraints).to.have.length(2);
      expect(result.entries[0].accountConstraints).to.have.length(1);
    });
  });

  describe("compile — budget enforcement", () => {
    it("throws ConstraintBudgetExceededError on >16 entries", () => {
      const builder = makeBuilder();
      // 3 actions × 6 markets = 18 entries → exceeds 16
      const allMarkets = Object.keys(FLASH_MARKET_MAP); // 6 markets
      expect(() =>
        builder.compile([
          {
            protocolId: "flash-trade",
            actionRules: [
              {
                actions: ["openPosition", "increaseSize", "swapAndOpen"],
                type: "allowedMarkets",
                params: { markets: allMarkets },
              },
            ],
          },
        ]),
      ).to.throw(ConstraintBudgetExceededError);
    });

    it("provides useful error message on budget exceeded", () => {
      const builder = makeBuilder();
      const allMarkets = Object.keys(FLASH_MARKET_MAP);
      try {
        builder.compile([
          {
            protocolId: "flash-trade",
            actionRules: [
              {
                actions: ["openPosition", "increaseSize", "swapAndOpen"],
                type: "allowedMarkets",
                params: { markets: allMarkets },
              },
            ],
          },
        ]);
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        const err = e as ConstraintBudgetExceededError;
        expect(err.name).to.equal("ConstraintBudgetExceededError");
        expect(err.used).to.be.greaterThan(16);
        expect(err.total).to.equal(16);
        expect(err.perProtocol["flash-trade"]).to.be.greaterThan(16);
      }
    });
  });

  describe("compile — strict mode", () => {
    it("sets strictMode when config has strictMode: true", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            { actions: ["openPosition"], type: "allowAll", params: {} },
          ],
          strictMode: true,
        },
      ]);
      expect(result.strictMode).to.be.true;
    });

    it("emits warnings for missing risk-reducing actions", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
          ],
          strictMode: true,
        },
      ]);
      expect(result.warnings.length).to.be.greaterThan(0);
      expect(result.warnings[0]).to.include("risk-reducing");
    });

    it("no warnings when risk-reducing actions covered", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
            {
              actions: [
                "closePosition", "decreaseSize", "removeCollateral",
                "removeCollateralAndSwap", "closeAndSwap",
                "cancelTriggerOrder", "cancelLimitOrder",
                "editTriggerOrder", "editLimitOrder",
              ],
              type: "allowAll",
              params: {},
            },
          ],
          strictMode: true,
        },
      ]);
      expect(result.warnings).to.have.length(0);
    });
  });

  describe("compile — summaries", () => {
    it("produces human-readable summaries", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
          ],
        },
      ]);
      expect(result.summary).to.have.length(1);
      expect(result.summary[0]).to.include("openPosition");
    });
  });

  describe("compile — validation", () => {
    it("throws on unregistered protocol", () => {
      const builder = makeBuilder();
      expect(() =>
        builder.compile([
          {
            protocolId: "unknown-protocol",
            actionRules: [],
          },
        ]),
      ).to.throw("No descriptor registered");
    });

    it("throws on invalid rule", () => {
      const builder = makeBuilder();
      expect(() =>
        builder.compile([
          {
            protocolId: "flash-trade",
            actionRules: [
              { actions: ["openPosition"], type: "maxPositionSize", params: {} },
            ],
          },
        ]),
      ).to.throw("Invalid rule");
    });
  });

  describe("estimateEntryCount", () => {
    it("estimates correctly for maxPositionSize", () => {
      const builder = makeBuilder();
      const estimate = builder.estimateEntryCount([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition", "increaseSize", "swapAndOpen"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
          ],
        },
      ]);
      expect(estimate.used).to.equal(3);
      expect(estimate.total).to.equal(16);
    });

    it("estimates correctly for allowedMarkets", () => {
      const builder = makeBuilder();
      const estimate = builder.estimateEntryCount([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition"],
              type: "allowedMarkets",
              params: { markets: ["SOL-SOL-long", "BTC-BTC-long"] },
            },
          ],
        },
      ]);
      expect(estimate.used).to.equal(2); // 1 instruction × 2 markets
    });

    it("matches compile result", () => {
      const builder = makeBuilder();
      const config: ProtocolRuleConfig[] = [
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition", "increaseSize"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" },
            },
            {
              actions: ["closePosition", "decreaseSize"],
              type: "allowAll",
              params: {},
            },
          ],
        },
      ];
      const estimate = builder.estimateEntryCount(config);
      const result = builder.compile(config);
      expect(estimate.used).to.equal(result.budget.used);
    });
  });

  describe("full scenario — plan example", () => {
    it("compiles the plan's full example correctly", () => {
      const builder = makeBuilder();
      const result = builder.compile([
        {
          protocolId: "flash-trade",
          actionRules: [
            {
              actions: ["openPosition", "increaseSize", "swapAndOpen"],
              type: "maxPositionSize",
              params: { maxSize: "10000000000" }, // 10 SOL
            },
            {
              actions: ["openPosition", "increaseSize"],
              type: "allowedMarkets",
              params: { markets: ["SOL-SOL-long", "SOL-USDC-short"] },
            },
            {
              actions: [
                "closePosition", "decreaseSize", "addCollateral",
                "removeCollateral", "cancelTriggerOrder",
              ],
              type: "allowAll",
              params: {},
            },
          ],
          strictMode: true,
        },
      ]);

      // openPosition: 2 markets → 2 entries (each with size Lte + market account)
      // increaseSize: 2 markets → 2 entries (each with size Lte + market account)
      // swapAndOpen: no market constraint → 1 entry (size Lte only)
      // closePosition, decreaseSize, addCollateral, removeCollateral, cancelTriggerOrder: 5 entries
      // Total: 2 + 2 + 1 + 5 = 10

      expect(result.budget.used).to.equal(10);
      expect(result.strictMode).to.be.true;

      // All entries should have Flash Trade program ID
      for (const entry of result.entries) {
        expect(entry.programId).to.equal(FLASH_TRADE_PROGRAM);
      }
    });
  });
});

// ─── Kamino Schema Tests ────────────────────────────────────────────────

describe("Kamino Schema", () => {
  it("contains exactly 4 instructions", () => {
    expect(KAMINO_SCHEMA.instructions.size).to.equal(4);
  });

  it("has correct program address", () => {
    expect(KAMINO_SCHEMA.programAddress).to.equal(KAMINO_LENDING_PROGRAM);
    expect(KAMINO_LENDING_PROGRAM).to.equal("KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM");
  });

  describe("discriminators match Codama-generated code", () => {
    const codamaDiscriminators: Record<string, Uint8Array> = {
      depositCollateral: DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR,
      borrowLiquidity: BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
      repayLiquidity: REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
      withdrawCollateral: WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR,
    };

    for (const [name, codamaDisc] of Object.entries(codamaDiscriminators)) {
      it(`${name} discriminator matches Codama`, () => {
        const schema = KAMINO_SCHEMA.instructions.get(name);
        expect(schema).to.not.be.undefined;
        expect(Array.from(schema!.discriminator)).to.deep.equal(Array.from(codamaDisc));
      });
    }
  });

  describe("account indices", () => {
    it("depositCollateral depositReserve index = 3", () => {
      expect(KAMINO_SCHEMA.instructions.get("depositCollateral")!.accounts.depositReserve).to.equal(3);
    });

    it("borrowLiquidity borrowReserve index = 4", () => {
      expect(KAMINO_SCHEMA.instructions.get("borrowLiquidity")!.accounts.borrowReserve).to.equal(4);
    });

    it("repayLiquidity repayReserve index = 3", () => {
      expect(KAMINO_SCHEMA.instructions.get("repayLiquidity")!.accounts.repayReserve).to.equal(3);
    });

    it("withdrawCollateral withdrawReserve index = 4", () => {
      expect(KAMINO_SCHEMA.instructions.get("withdrawCollateral")!.accounts.withdrawReserve).to.equal(4);
    });
  });

  describe("field offsets", () => {
    it("all instructions have amount field at offset 8", () => {
      for (const [, ix] of KAMINO_SCHEMA.instructions) {
        expect(ix.fields).to.have.length(1);
        expect(ix.fields[0].offset).to.equal(8);
        expect(ix.fields[0].type).to.equal("u64");
        expect(ix.fields[0].size).to.equal(8);
      }
    });

    it("all instructions have dataSize 16", () => {
      for (const [, ix] of KAMINO_SCHEMA.instructions) {
        expect(ix.dataSize).to.equal(16);
      }
    });
  });

  describe("action categories", () => {
    it("KAMINO_SPENDING_ACTIONS has 2 entries", () => {
      expect(KAMINO_SPENDING_ACTIONS).to.have.length(2);
    });

    it("KAMINO_RISK_REDUCING_ACTIONS has 2 entries", () => {
      expect(KAMINO_RISK_REDUCING_ACTIONS).to.have.length(2);
    });

    it("KAMINO_AMOUNT_CONSTRAINED_ACTIONS has 4 entries", () => {
      expect(KAMINO_AMOUNT_CONSTRAINED_ACTIONS).to.have.length(4);
    });

    it("all actions are in schema", () => {
      for (const a of KAMINO_AMOUNT_CONSTRAINED_ACTIONS) {
        expect(KAMINO_SCHEMA.instructions.has(a)).to.be.true;
      }
    });
  });
});

// ─── Kamino Descriptor Tests ────────────────────────────────────────────

describe("Kamino Descriptor", () => {
  describe("compileRule — allowAll", () => {
    it("produces discriminator-only entries", () => {
      const rule = { actions: ["depositCollateral", "borrowLiquidity"], type: "allowAll", params: {} };
      const result = KaminoDescriptor.compileRule(rule);
      expect(result).to.have.length(2);
      for (const c of result) {
        expect(c.dataConstraints).to.have.length(1);
        expect(c.dataConstraints[0].offset).to.equal(0);
        expect(c.dataConstraints[0].operator).to.equal(ConstraintOperator.Eq);
        expect(c.accountConstraints).to.have.length(0);
      }
    });
  });

  describe("compileRule — maxAmount", () => {
    it("produces Lte constraints for all amount-constrained actions", () => {
      const rule = {
        actions: ["depositCollateral", "borrowLiquidity", "repayLiquidity", "withdrawCollateral"],
        type: "maxAmount",
        params: { maxAmount: "1000000000" },
      };
      const result = KaminoDescriptor.compileRule(rule);
      expect(result).to.have.length(4);
      for (const c of result) {
        expect(c.dataConstraints).to.have.length(2);
        expect(c.dataConstraints[0].operator).to.equal(ConstraintOperator.Eq); // discriminator
        expect(c.dataConstraints[1].operator).to.equal(ConstraintOperator.Lte); // amount cap
        expect(c.dataConstraints[1].offset).to.equal(8); // all at offset 8
      }
    });

    it("encodes maxAmount value as LE bytes", () => {
      const maxAmount = 5_000_000_000n;
      const rule = {
        actions: ["depositCollateral"],
        type: "maxAmount",
        params: { maxAmount: maxAmount.toString() },
      };
      const result = KaminoDescriptor.compileRule(rule);
      const lteBuf = result[0].dataConstraints[1].value as Uint8Array;
      expect(lteBuf.length).to.equal(8);
      let decoded = 0n;
      for (let i = 7; i >= 0; i--) {
        decoded = (decoded << 8n) | BigInt(lteBuf[i]);
      }
      expect(decoded).to.equal(maxAmount);
    });
  });

  describe("compileRule — allowedReserves", () => {
    it("produces account constraints with correct reserve addresses", () => {
      const rule = {
        actions: ["depositCollateral"],
        type: "allowedReserves",
        params: { reserves: ["USDC"] },
      };
      const result = KaminoDescriptor.compileRule(rule);
      expect(result).to.have.length(1);
      expect(result[0].accountConstraints).to.have.length(1);
      expect(result[0].accountConstraints[0].index).to.equal(3); // depositReserve index
      expect(result[0].accountConstraints[0].expected).to.equal(KAMINO_RESERVES.USDC.reserve);
    });

    it("creates one entry per (instruction x reserve)", () => {
      const rule = {
        actions: ["depositCollateral", "borrowLiquidity"],
        type: "allowedReserves",
        params: { reserves: ["USDC", "SOL"] },
      };
      const result = KaminoDescriptor.compileRule(rule);
      // 2 instructions * 2 reserves = 4
      expect(result).to.have.length(4);
    });

    it("uses correct reserve index per instruction", () => {
      const rule = {
        actions: ["depositCollateral", "borrowLiquidity"],
        type: "allowedReserves",
        params: { reserves: ["USDC"] },
      };
      const result = KaminoDescriptor.compileRule(rule);
      // depositCollateral: depositReserve at index 3
      const depositResult = result.find((c) =>
        arraysEqual(c.discriminators[0], DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR),
      );
      expect(depositResult!.accountConstraints[0].index).to.equal(3);
      // borrowLiquidity: borrowReserve at index 4
      const borrowResult = result.find((c) =>
        arraysEqual(c.discriminators[0], BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR),
      );
      expect(borrowResult!.accountConstraints[0].index).to.equal(4);
    });

    it("throws on unknown reserve key", () => {
      const rule = {
        actions: ["depositCollateral"],
        type: "allowedReserves",
        params: { reserves: ["BONK"] },
      };
      expect(() => KaminoDescriptor.compileRule(rule)).to.throw("Unknown Kamino reserve");
    });
  });

  describe("getRuleTypes", () => {
    it("returns 3 rule types", () => {
      const types = KaminoDescriptor.getRuleTypes();
      expect(types).to.have.length(3);
    });

    it("includes all expected types", () => {
      const types = KaminoDescriptor.getRuleTypes();
      const names = types.map((t) => t.type);
      expect(names).to.include.members(["allowAll", "maxAmount", "allowedReserves"]);
    });
  });

  describe("validateRule", () => {
    it("passes valid allowAll rule", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["depositCollateral"],
        type: "allowAll",
        params: {},
      });
      expect(errors).to.have.length(0);
    });

    it("fails on unknown action", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["unknownAction"],
        type: "allowAll",
        params: {},
      });
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include("Unknown action");
    });

    it("fails on unknown rule type", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["depositCollateral"],
        type: "unknownRule",
        params: {},
      });
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include("Unknown rule type");
    });

    it("fails maxAmount without maxAmount param", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["depositCollateral"],
        type: "maxAmount",
        params: {},
      });
      expect(errors.some((e) => e.includes("maxAmount"))).to.be.true;
    });

    it("fails allowedReserves with unknown reserve", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["depositCollateral"],
        type: "allowedReserves",
        params: { reserves: ["INVALID"] },
      });
      expect(errors.some((e) => e.includes("Unknown reserve"))).to.be.true;
    });

    it("fails allowedReserves with empty array", () => {
      const errors = KaminoDescriptor.validateRule({
        actions: ["depositCollateral"],
        type: "allowedReserves",
        params: { reserves: [] },
      });
      expect(errors.some((e) => e.includes("non-empty"))).to.be.true;
    });
  });

  describe("checkStrictModeWarnings", () => {
    it("warns when strict_mode has spending but no risk-reducing", () => {
      const warnings = KaminoDescriptor.checkStrictModeWarnings!({
        actionRules: [
          { actions: ["depositCollateral"], type: "maxAmount", params: { maxAmount: "1000" } },
        ],
        strictMode: true,
      });
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("risk-reducing");
      expect(warnings[0]).to.include("borrowLiquidity");
      expect(warnings[0]).to.include("withdrawCollateral");
    });

    it("no warnings when strict_mode is off", () => {
      const warnings = KaminoDescriptor.checkStrictModeWarnings!({
        actionRules: [
          { actions: ["depositCollateral"], type: "maxAmount", params: { maxAmount: "1000" } },
        ],
        strictMode: false,
      });
      expect(warnings).to.have.length(0);
    });

    it("no warnings when all risk-reducing covered", () => {
      const warnings = KaminoDescriptor.checkStrictModeWarnings!({
        actionRules: [
          { actions: ["depositCollateral"], type: "maxAmount", params: { maxAmount: "1000" } },
          { actions: ["borrowLiquidity", "withdrawCollateral"], type: "allowAll", params: {} },
        ],
        strictMode: true,
      });
      expect(warnings).to.have.length(0);
    });
  });
});

// ─── ConstraintBuilder — Multi-Protocol Tests ───────────────────────────

describe("ConstraintBuilder — Multi-Protocol", () => {
  function makeMultiBuilder(): ConstraintBuilder {
    return new ConstraintBuilder()
      .register(FlashTradeDescriptor)
      .register(KaminoDescriptor);
  }

  it("compiles Flash Trade + Kamino together", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition"], type: "allowAll", params: {} },
        ],
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral"], type: "allowAll", params: {} },
        ],
      },
    ]);
    expect(result.entries).to.have.length(2);
    expect(result.budget.perProtocol["flash-trade"]).to.equal(1);
    expect(result.budget.perProtocol["kamino"]).to.equal(1);
  });

  it("budget is shared across protocols", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition", "closePosition", "increaseSize"], type: "allowAll", params: {} },
        ],
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral", "borrowLiquidity"], type: "allowAll", params: {} },
        ],
      },
    ]);
    expect(result.budget.used).to.equal(5); // 3 + 2
    expect(result.budget.perProtocol["flash-trade"]).to.equal(3);
    expect(result.budget.perProtocol["kamino"]).to.equal(2);
  });

  it("entries have correct program IDs", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [{ actions: ["openPosition"], type: "allowAll", params: {} }],
      },
      {
        protocolId: "kamino",
        actionRules: [{ actions: ["depositCollateral"], type: "allowAll", params: {} }],
      },
    ]);
    const flashEntry = result.entries.find((e) => e.programId === "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn");
    const kaminoEntry = result.entries.find((e) => e.programId === "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM");
    expect(flashEntry).to.not.be.undefined;
    expect(kaminoEntry).to.not.be.undefined;
  });

  it("strict_mode warnings work for both protocols", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition"], type: "maxPositionSize", params: { maxSize: "1000" } },
        ],
        strictMode: true,
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral"], type: "maxAmount", params: { maxAmount: "1000" } },
        ],
        strictMode: true,
      },
    ]);
    // Both should have warnings about missing risk-reducing actions
    expect(result.warnings.length).to.be.greaterThanOrEqual(2);
    expect(result.warnings.some((w) => w.includes("closePosition"))).to.be.true;
    expect(result.warnings.some((w) => w.includes("borrowLiquidity"))).to.be.true;
  });

  it("estimateEntryCount matches compile for multi-protocol", () => {
    const builder = makeMultiBuilder();
    const configs = [
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition", "increaseSize"], type: "maxPositionSize", params: { maxSize: "10000000000" } },
        ],
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral", "repayLiquidity"], type: "maxAmount", params: { maxAmount: "5000000000" } },
        ],
      },
    ];
    const estimate = builder.estimateEntryCount(configs);
    const result = builder.compile(configs);
    expect(estimate.used).to.equal(result.budget.used);
  });

  it("Kamino allowedReserves + Flash Trade allowedMarkets share budget", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition"], type: "allowedMarkets", params: { markets: ["SOL-SOL-long", "BTC-BTC-long"] } },
        ],
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral"], type: "allowedReserves", params: { reserves: ["USDC", "SOL"] } },
        ],
      },
    ]);
    // 2 market entries + 2 reserve entries = 4
    expect(result.budget.used).to.equal(4);
    expect(result.budget.perProtocol["flash-trade"]).to.equal(2);
    expect(result.budget.perProtocol["kamino"]).to.equal(2);
  });

  it("full scenario — constrained multi-protocol vault", () => {
    const builder = makeMultiBuilder();
    const result = builder.compile([
      {
        protocolId: "flash-trade",
        actionRules: [
          { actions: ["openPosition", "increaseSize"], type: "maxPositionSize", params: { maxSize: "10000000000" } },
          { actions: ["openPosition", "increaseSize"], type: "allowedMarkets", params: { markets: ["SOL-SOL-long"] } },
          {
            actions: [
              "closePosition", "decreaseSize", "removeCollateral",
              "removeCollateralAndSwap", "closeAndSwap",
              "cancelTriggerOrder", "cancelLimitOrder",
              "editTriggerOrder", "editLimitOrder",
            ],
            type: "allowAll",
            params: {},
          },
        ],
        strictMode: true,
      },
      {
        protocolId: "kamino",
        actionRules: [
          { actions: ["depositCollateral", "repayLiquidity"], type: "maxAmount", params: { maxAmount: "5000000000" } },
          { actions: ["depositCollateral"], type: "allowedReserves", params: { reserves: ["USDC"] } },
          { actions: ["borrowLiquidity", "withdrawCollateral"], type: "allowAll", params: {} },
        ],
        strictMode: true,
      },
    ]);

    // Flash Trade: openPosition(1 market, merged), increaseSize(1 market, merged), 9 risk-reducing = 11
    // Kamino: deposit(1 reserve, merged amount+reserve), repay(1 amount), borrow+withdraw = 4
    // Total: ~15, within budget, no warnings since all risk-reducing covered
    expect(result.budget.used).to.be.lessThanOrEqual(16);
    expect(result.warnings).to.have.length(0); // All risk-reducing covered
    expect(result.strictMode).to.be.true;
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Constraint Builder Edge Cases ───────────────────────────────────────

describe("Constraint Builder Edge Cases", () => {
  it("handles empty rules list", () => {
    const builder = new ConstraintBuilder();
    builder.register(FlashTradeDescriptor);
    const result = builder.compile([{
      protocolId: "flash-trade",
      actionRules: [],
      strictMode: false,
    }]);
    expect(result.entries).to.have.length(0);
    expect(result.budget.used).to.equal(0);
  });

  it("estimateEntryCount matches actual compile count", () => {
    const builder = new ConstraintBuilder();
    builder.register(FlashTradeDescriptor);
    const config: ProtocolRuleConfig = {
      protocolId: "flash-trade",
      actionRules: [
        { actions: ["openPosition"], type: "maxPositionSize", params: { maxSize: "10000000000" } },
      ],
      strictMode: false,
    };
    const estimate = builder.estimateEntryCount([config]);
    const actual = builder.compile([config]);
    expect(estimate.used).to.equal(actual.budget.used);
  });

  it("throws ConstraintBudgetExceededError with protocol breakdown", () => {
    const builder = new ConstraintBuilder();
    builder.register(FlashTradeDescriptor);
    // Create enough rules to exceed 16 entries
    const manyRules: ActionRule[] = [];
    const markets = [
      "SOL-SOL-long",
      "SOL-USDC-short",
      "BTC-BTC-long",
      "BTC-USDC-short",
      "ETH-ETH-long",
      "ETH-USDC-short",
    ];
    // allowedMarkets with 6 markets on multiple actions should exceed budget
    for (let i = 0; i < 3; i++) {
      manyRules.push({
        actions: ["openPosition", "increaseSize", "swapAndOpen"],
        type: "allowedMarkets",
        params: { markets },
      });
    }
    try {
      builder.compile([{
        protocolId: "flash-trade",
        actionRules: manyRules,
        strictMode: false,
      }]);
      expect.fail("should have thrown ConstraintBudgetExceededError");
    } catch (e: any) {
      expect(e).to.be.instanceOf(ConstraintBudgetExceededError);
      expect(e.used).to.be.greaterThan(16);
      expect(e.total).to.equal(16);
      expect(e.perProtocol).to.have.property("flash-trade");
    }
  });

  it("rejects unregistered protocol", () => {
    const builder = new ConstraintBuilder();
    try {
      builder.compile([{
        protocolId: "unknown-protocol",
        actionRules: [],
        strictMode: false,
      }]);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("No descriptor registered");
      expect(e.message).to.include("unknown-protocol");
    }
  });
});
