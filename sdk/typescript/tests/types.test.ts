import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { PHALNX_PROGRAM_ID } from "../src/index";
import {
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  MAX_DEVELOPER_FEE_RATE,
  PROTOCOL_TREASURY,
  isSpendingAction,
  getPositionEffect,
  hasPermission,
  FULL_PERMISSIONS,
  MAX_AGENTS_PER_VAULT,
  MAX_ESCROW_DURATION,
  SWAP_ONLY,
  PERPS_ONLY,
  TRANSFER_ONLY,
  ESCROW_ONLY,
} from "../src/types";
import type { ActionType } from "../src/types";

describe("Types — Constants", () => {
  it("PHALNX_PROGRAM_ID is a valid PublicKey", () => {
    expect(PHALNX_PROGRAM_ID).to.be.instanceOf(PublicKey);
    expect(PHALNX_PROGRAM_ID.toBase58()).to.equal(
      "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
    );
  });

  it("FEE_RATE_DENOMINATOR === 1_000_000", () => {
    expect(FEE_RATE_DENOMINATOR).to.equal(1_000_000);
  });

  it("PROTOCOL_FEE_RATE === 200", () => {
    expect(PROTOCOL_FEE_RATE).to.equal(200);
  });

  it("MAX_DEVELOPER_FEE_RATE === 500", () => {
    expect(MAX_DEVELOPER_FEE_RATE).to.equal(500);
  });

  it("PROTOCOL_TREASURY is a valid PublicKey", () => {
    expect(PROTOCOL_TREASURY).to.be.instanceOf(PublicKey);
    expect(PROTOCOL_TREASURY.toBase58()).to.equal(
      "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
    );
  });

  it("MAX_AGENTS_PER_VAULT === 10", () => {
    expect(MAX_AGENTS_PER_VAULT).to.equal(10);
  });

  it("FULL_PERMISSIONS covers 21 bits", () => {
    expect(FULL_PERMISSIONS).to.equal((1n << 21n) - 1n);
  });

  it("MAX_ESCROW_DURATION === 2_592_000 (30 days)", () => {
    expect(MAX_ESCROW_DURATION).to.equal(2_592_000);
  });
});

describe("Types — isSpendingAction", () => {
  const spendingActions: ActionType[] = [
    { swap: {} },
    { openPosition: {} },
    { increasePosition: {} },
    { deposit: {} },
    { transfer: {} },
    { addCollateral: {} },
    { placeLimitOrder: {} },
    { swapAndOpenPosition: {} },
    { createEscrow: {} },
  ];

  const nonSpendingActions: ActionType[] = [
    { closePosition: {} },
    { decreasePosition: {} },
    { withdraw: {} },
    { removeCollateral: {} },
    { placeTriggerOrder: {} },
    { editTriggerOrder: {} },
    { cancelTriggerOrder: {} },
    { editLimitOrder: {} },
    { cancelLimitOrder: {} },
    { closeAndSwapPosition: {} },
    { settleEscrow: {} },
    { refundEscrow: {} },
  ];

  for (const action of spendingActions) {
    const name = Object.keys(action)[0];
    it(`${name} is a spending action`, () => {
      expect(isSpendingAction(action)).to.be.true;
    });
  }

  for (const action of nonSpendingActions) {
    const name = Object.keys(action)[0];
    it(`${name} is NOT a spending action`, () => {
      expect(isSpendingAction(action)).to.be.false;
    });
  }

  it("covers all 21 ActionType variants (9 spending + 12 non-spending)", () => {
    expect(spendingActions.length).to.equal(9);
    expect(nonSpendingActions.length).to.equal(12);
    expect(spendingActions.length + nonSpendingActions.length).to.equal(21);
  });
});

describe("Types — getPositionEffect", () => {
  it("openPosition → increment", () => {
    expect(getPositionEffect({ openPosition: {} })).to.equal("increment");
  });

  it("swapAndOpenPosition → increment", () => {
    expect(getPositionEffect({ swapAndOpenPosition: {} })).to.equal(
      "increment",
    );
  });

  it("placeLimitOrder → increment", () => {
    expect(getPositionEffect({ placeLimitOrder: {} })).to.equal("increment");
  });

  it("closePosition → decrement", () => {
    expect(getPositionEffect({ closePosition: {} })).to.equal("decrement");
  });

  it("closeAndSwapPosition → decrement", () => {
    expect(getPositionEffect({ closeAndSwapPosition: {} })).to.equal(
      "decrement",
    );
  });

  it("cancelLimitOrder → decrement", () => {
    expect(getPositionEffect({ cancelLimitOrder: {} })).to.equal("decrement");
  });

  it("swap → none", () => {
    expect(getPositionEffect({ swap: {} })).to.equal("none");
  });

  it("transfer → none", () => {
    expect(getPositionEffect({ transfer: {} })).to.equal("none");
  });

  it("createEscrow → none", () => {
    expect(getPositionEffect({ createEscrow: {} })).to.equal("none");
  });

  it("settleEscrow → none", () => {
    expect(getPositionEffect({ settleEscrow: {} })).to.equal("none");
  });

  it("refundEscrow → none", () => {
    expect(getPositionEffect({ refundEscrow: {} })).to.equal("none");
  });
});

describe("Types — hasPermission", () => {
  it("FULL_PERMISSIONS grants all action types", () => {
    const allActions = [
      "swap",
      "openPosition",
      "closePosition",
      "increasePosition",
      "decreasePosition",
      "deposit",
      "withdraw",
      "transfer",
      "addCollateral",
      "removeCollateral",
      "placeTriggerOrder",
      "editTriggerOrder",
      "cancelTriggerOrder",
      "placeLimitOrder",
      "editLimitOrder",
      "cancelLimitOrder",
      "swapAndOpenPosition",
      "closeAndSwapPosition",
      "createEscrow",
      "settleEscrow",
      "refundEscrow",
    ];
    for (const action of allActions) {
      expect(hasPermission(FULL_PERMISSIONS, action)).to.be.true;
    }
  });

  it("SWAP_ONLY grants only swap", () => {
    expect(hasPermission(SWAP_ONLY, "swap")).to.be.true;
    expect(hasPermission(SWAP_ONLY, "transfer")).to.be.false;
    expect(hasPermission(SWAP_ONLY, "openPosition")).to.be.false;
  });

  it("PERPS_ONLY grants position actions", () => {
    expect(hasPermission(PERPS_ONLY, "openPosition")).to.be.true;
    expect(hasPermission(PERPS_ONLY, "closePosition")).to.be.true;
    expect(hasPermission(PERPS_ONLY, "increasePosition")).to.be.true;
    expect(hasPermission(PERPS_ONLY, "decreasePosition")).to.be.true;
    expect(hasPermission(PERPS_ONLY, "swap")).to.be.false;
  });

  it("TRANSFER_ONLY grants only transfer", () => {
    expect(hasPermission(TRANSFER_ONLY, "transfer")).to.be.true;
    expect(hasPermission(TRANSFER_ONLY, "swap")).to.be.false;
  });

  it("ESCROW_ONLY grants escrow actions", () => {
    expect(hasPermission(ESCROW_ONLY, "createEscrow")).to.be.true;
    expect(hasPermission(ESCROW_ONLY, "settleEscrow")).to.be.true;
    expect(hasPermission(ESCROW_ONLY, "refundEscrow")).to.be.true;
    expect(hasPermission(ESCROW_ONLY, "swap")).to.be.false;
  });

  it("returns false for unknown action type", () => {
    expect(hasPermission(FULL_PERMISSIONS, "unknownAction")).to.be.false;
  });

  it("zero permissions grants nothing", () => {
    expect(hasPermission(0n, "swap")).to.be.false;
    expect(hasPermission(0n, "transfer")).to.be.false;
    expect(hasPermission(0n, "createEscrow")).to.be.false;
  });
});
