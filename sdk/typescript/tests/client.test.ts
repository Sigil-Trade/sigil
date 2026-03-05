import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PhalnxClient } from "../src/index";

describe("Client — calculateFees", () => {
  it("calculates correct fees for amount=1_000_000, devRate=10", () => {
    const result = PhalnxClient.calculateFees(new BN(1_000_000), 10);
    // protocolFee = 1_000_000 * 200 / 1_000_000 = 200
    expect(result.protocolFee.toNumber()).to.equal(200);
    // developerFee = 1_000_000 * 10 / 1_000_000 = 10
    expect(result.developerFee.toNumber()).to.equal(10);
    // totalFee = 210
    expect(result.totalFee.toNumber()).to.equal(210);
  });

  it("returns all zeros for zero amount", () => {
    const result = PhalnxClient.calculateFees(new BN(0), 10);
    expect(result.protocolFee.toNumber()).to.equal(0);
    expect(result.developerFee.toNumber()).to.equal(0);
    expect(result.totalFee.toNumber()).to.equal(0);
  });

  it("calculates correct fee with MAX_DEVELOPER_FEE_RATE (500)", () => {
    const result = PhalnxClient.calculateFees(new BN(1_000_000), 500);
    // protocolFee = 200
    expect(result.protocolFee.toNumber()).to.equal(200);
    // developerFee = 1_000_000 * 500 / 1_000_000 = 500
    expect(result.developerFee.toNumber()).to.equal(500);
    expect(result.totalFee.toNumber()).to.equal(700);
  });

  it("returns zero dev fee with devRate=0", () => {
    const result = PhalnxClient.calculateFees(new BN(1_000_000), 0);
    expect(result.protocolFee.toNumber()).to.equal(200);
    expect(result.developerFee.toNumber()).to.equal(0);
    expect(result.totalFee.toNumber()).to.equal(200);
  });

  it("handles large amount (10^12) without overflow", () => {
    const largeAmount = new BN("1000000000000"); // 10^12
    const result = PhalnxClient.calculateFees(largeAmount, 10);
    // protocolFee = 10^12 * 200 / 10^6 = 200_000_000
    expect(result.protocolFee.toNumber()).to.equal(200_000_000);
    // developerFee = 10^12 * 10 / 10^6 = 10_000_000
    expect(result.developerFee.toNumber()).to.equal(10_000_000);
    expect(result.totalFee.toNumber()).to.equal(210_000_000);
  });

  it("calculates fees proportionally for different amounts", () => {
    const r1 = PhalnxClient.calculateFees(new BN(2_000_000), 20);
    const r2 = PhalnxClient.calculateFees(new BN(4_000_000), 20);
    // Double the amount should double the fees
    expect(r2.protocolFee.toNumber()).to.equal(r1.protocolFee.toNumber() * 2);
    expect(r2.developerFee.toNumber()).to.equal(r1.developerFee.toNumber() * 2);
  });

  it("totalFee equals protocolFee + developerFee", () => {
    const result = PhalnxClient.calculateFees(new BN(123_456_789), 25);
    expect(result.totalFee.eq(result.protocolFee.add(result.developerFee))).to
      .be.true;
  });

  it("fee rates are applied as BPS (basis points of basis points)", () => {
    // 200/1_000_000 = 0.02% = 2 BPS
    const amount = new BN(1_000_000_000); // 1B
    const result = PhalnxClient.calculateFees(amount, 20);
    // protocolFee = 1B * 200 / 1M = 200_000
    expect(result.protocolFee.toNumber()).to.equal(200_000);
    // developerFee = 1B * 20 / 1M = 20_000
    expect(result.developerFee.toNumber()).to.equal(20_000);
  });
});
