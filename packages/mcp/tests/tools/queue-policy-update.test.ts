import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { queuePolicyUpdate } from "../../src/tools/queue-policy-update";
import { createMockClient } from "../helpers/mock-client";

describe("shield_queue_policy_update", () => {
  const vault = Keypair.generate().publicKey.toBase58();
  const protocol = Keypair.generate().publicKey.toBase58();
  const dest = Keypair.generate().publicKey.toBase58();

  it("queues policy update successfully", async () => {
    const client = createMockClient();
    const result = await queuePolicyUpdate(client as any, {
      vault,
      dailySpendingCapUsd: "5000000000",
    });
    expect(result).to.include("Policy Update Queued");
    expect(result).to.include("mock-sig-queue");
  });

  it("passes all params correctly", async () => {
    const client = createMockClient();
    await queuePolicyUpdate(client as any, {
      vault,
      dailySpendingCapUsd: "5000000000",
      maxTransactionSizeUsd: "1000000000",
      protocolMode: 2,
      protocols: [protocol],
      allowedDestinations: [dest],
      maxLeverageBps: 20000,
      canOpenPositions: true,
      maxConcurrentPositions: 5,
      timelockDuration: 3600,
      developerFeeRate: 100,
    });
    const call = client.calls.find((c) => c.method === "queuePolicyUpdate");
    expect(call).to.exist;
    const params = call!.args[1];
    expect(params.dailySpendingCapUsd.toString()).to.equal("5000000000");
    expect(params.maxTransactionAmountUsd.toString()).to.equal("1000000000");
    expect(params.protocolMode).to.equal(2);
    expect(params.protocols).to.have.length(1);
    expect(params.allowedDestinations).to.have.length(1);
    expect(params.maxLeverageBps).to.equal(20000);
    expect(params.canOpenPositions).to.equal(true);
    expect(params.maxConcurrentPositions).to.equal(5);
    expect(params.timelockDuration.toString()).to.equal("3600");
    expect(params.developerFeeRate).to.equal(100);
  });

  it("handles partial fields (only dailySpendingCapUsd)", async () => {
    const client = createMockClient();
    const result = await queuePolicyUpdate(client as any, {
      vault,
      dailySpendingCapUsd: "1000000000",
    });
    expect(result).to.include("Policy Update Queued");
    const call = client.calls.find((c) => c.method === "queuePolicyUpdate");
    const params = call!.args[1];
    expect(params.dailySpendingCapUsd).to.exist;
    expect(params.protocolMode).to.be.undefined;
    expect(params.protocols).to.be.undefined;
  });

  it("converts protocols to PublicKey[]", async () => {
    const client = createMockClient();
    await queuePolicyUpdate(client as any, {
      vault,
      protocols: [protocol],
    });
    const call = client.calls.find((c) => c.method === "queuePolicyUpdate");
    const params = call!.args[1];
    expect(params.protocols[0].toBase58()).to.equal(protocol);
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6037 }),
    });
    const result = await queuePolicyUpdate(client as any, {
      vault,
      dailySpendingCapUsd: "5000000000",
    });
    expect(result).to.include("TimelockActive");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await queuePolicyUpdate(client as any, {
      vault: "not-a-key",
      dailySpendingCapUsd: "5000000000",
    });
    expect(result).to.include("Invalid public key");
  });
});
