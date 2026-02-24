import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { AGENT_SHIELD_PROGRAM_ID } from "../src/index";
import {
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  MAX_DEVELOPER_FEE_RATE,
  PROTOCOL_TREASURY,
} from "../src/types";

describe("Types — Constants", () => {
  it("AGENT_SHIELD_PROGRAM_ID is a valid PublicKey", () => {
    expect(AGENT_SHIELD_PROGRAM_ID).to.be.instanceOf(PublicKey);
    expect(AGENT_SHIELD_PROGRAM_ID.toBase58()).to.equal(
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
});
