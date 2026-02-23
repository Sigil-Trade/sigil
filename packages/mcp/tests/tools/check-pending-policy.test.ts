import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { checkPendingPolicy } from "../../src/tools/check-pending-policy";
import {
  createMockClient,
  makePendingPolicyAccount,
  TEST_PROTOCOL,
} from "../helpers/mock-client";

describe("shield_check_pending_policy", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("shows no pending when null", async () => {
    const client = createMockClient();
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("**Pending:** No");
    expect(result).to.include("No pending policy update exists");
  });

  it("shows pending with queued changes", async () => {
    const client = createMockClient();
    (client as any).fetchPendingPolicy = async () =>
      makePendingPolicyAccount({
        dailySpendingCapUsd: new BN("5000000000"),
      });
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("**Pending:** Yes");
    expect(result).to.include("Daily Spending Cap");
    expect(result).to.include("5000000000");
  });

  it("shows 'Ready to apply' when timelock expired", async () => {
    const pastTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const client = createMockClient();
    (client as any).fetchPendingPolicy = async () =>
      makePendingPolicyAccount({
        executesAt: new BN(pastTs),
        dailySpendingCapUsd: new BN("1000000000"),
      });
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("Ready to apply");
  });

  it("shows time remaining when not expired", async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
    const client = createMockClient();
    (client as any).fetchPendingPolicy = async () =>
      makePendingPolicyAccount({
        executesAt: new BN(futureTs),
        dailySpendingCapUsd: new BN("1000000000"),
      });
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("h");
    expect(result).to.include("m");
    expect(result).not.to.include("Ready to apply");
  });

  it("renders all possible queued fields", async () => {
    const dest = Keypair.generate().publicKey;
    const client = createMockClient();
    (client as any).fetchPendingPolicy = async () =>
      makePendingPolicyAccount({
        dailySpendingCapUsd: new BN("5000000000"),
        maxTransactionAmountUsd: new BN("1000000000"),
        protocolMode: 1,
        protocols: [TEST_PROTOCOL],
        allowedDestinations: [dest],
        maxLeverageBps: 20000,
        canOpenPositions: true,
        maxConcurrentPositions: 5,
        timelockDuration: new BN(3600),
        developerFeeRate: 100,
      });
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("Daily Spending Cap");
    expect(result).to.include("Max Transaction Size");
    expect(result).to.include("Protocol Mode");
    expect(result).to.include("Allowlist");
    expect(result).to.include("Protocols");
    expect(result).to.include("Allowed Destinations");
    expect(result).to.include("Max Leverage");
    expect(result).to.include("20000 BPS");
    expect(result).to.include("Can Open Positions");
    expect(result).to.include("Max Concurrent Positions");
    expect(result).to.include("Timelock Duration");
    expect(result).to.include("Developer Fee Rate");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Something went wrong"),
    });
    const result = await checkPendingPolicy(client as any, { vault });
    expect(result).to.include("Something went wrong");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await checkPendingPolicy(client as any, {
      vault: "not-a-key",
    });
    expect(result).to.include("Invalid public key");
  });
});
