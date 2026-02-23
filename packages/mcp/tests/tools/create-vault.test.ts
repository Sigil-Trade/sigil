import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { createVault } from "../../src/tools/create-vault";
import { createMockClient } from "../helpers/mock-client";

describe("shield_create_vault", () => {
  const feeDest = Keypair.generate().publicKey.toBase58();
  const protocol = Keypair.generate().publicKey.toBase58();

  const validInput = {
    vaultId: "1",
    dailySpendingCapUsd: "10000000000",
    maxTransactionSizeUsd: "1000000000",
    protocolMode: 1,
    protocols: [protocol],
    maxLeverageBps: 30000,
    maxConcurrentPositions: 5,
    feeDestination: feeDest,
    developerFeeRate: 10,
    timelockDuration: 0,
  };

  it("creates vault successfully", async () => {
    const client = createMockClient();
    const result = await createVault(client as any, validInput);
    expect(result).to.include("Vault Created Successfully");
    expect(result).to.include("mock-sig-create");
    expect(client.calls.some((c) => c.method === "createVault")).to.be.true;
  });

  it("passes correct params to SDK", async () => {
    const client = createMockClient();
    await createVault(client as any, validInput);
    const call = client.calls.find((c) => c.method === "createVault");
    expect(call).to.exist;
    const params = call!.args[0];
    expect(params.vaultId.toString()).to.equal("1");
    expect(params.maxLeverageBps).to.equal(30000);
    expect(params.protocolMode).to.equal(1);
    expect(params.protocols).to.have.length(1);
  });

  it("returns error on invalid public key", async () => {
    const client = createMockClient();
    const result = await createVault(client as any, {
      ...validInput,
      feeDestination: "invalid-key",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6020 }),
    });
    const result = await createVault(client as any, validInput);
    expect(result).to.include("DeveloperFeeTooHigh");
  });

  it("handles empty protocols array gracefully", async () => {
    const client = createMockClient();
    const result = await createVault(client as any, {
      ...validInput,
      protocolMode: 0,
      protocols: [],
    });
    expect(result).to.include("Vault Created Successfully");
    const call = client.calls.find((c) => c.method === "createVault");
    expect(call!.args[0].protocols).to.have.length(0);
  });

  it("handles amount = '0' for dailySpendingCapUsd", async () => {
    const client = createMockClient();
    const result = await createVault(client as any, {
      ...validInput,
      dailySpendingCapUsd: "0",
    });
    expect(result).to.include("Vault Created Successfully");
    const call = client.calls.find((c) => c.method === "createVault");
    expect(call!.args[0].dailySpendingCapUsd.toString()).to.equal("0");
  });
});
