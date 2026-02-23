import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { agentTransfer } from "../../src/tools/agent-transfer";
import { createMockClient } from "../helpers/mock-client";

describe("shield_agent_transfer", () => {
  const vault = Keypair.generate().publicKey.toBase58();
  const destination = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  const validInput = {
    vault,
    destination,
    mint,
    amount: "100000000",
  };

  it("transfers tokens successfully", async () => {
    const client = createMockClient();
    const result = await agentTransfer(client as any, validInput);
    expect(result).to.include("Agent Transfer Complete");
    expect(result).to.include("mock-sig-transfer");
    expect(result).to.include(vault);
    expect(result).to.include(destination);
  });

  it("derives ATAs and passes params to SDK", async () => {
    const client = createMockClient();
    await agentTransfer(client as any, validInput);
    const call = client.calls.find((c) => c.method === "agentTransfer");
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(vault);
    const params = call!.args[1];
    expect(params.amount.toString()).to.equal("100000000");
    expect(params.vaultTokenAccount).to.exist;
    expect(params.destinationTokenAccount).to.exist;
  });

  it("passes amount as BN", async () => {
    const client = createMockClient();
    await agentTransfer(client as any, {
      ...validInput,
      amount: "999999999999",
    });
    const call = client.calls.find((c) => c.method === "agentTransfer");
    expect(call!.args[1].amount.toString()).to.equal("999999999999");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await agentTransfer(client as any, {
      ...validInput,
      vault: "not-a-key",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on invalid destination", async () => {
    const client = createMockClient();
    const result = await agentTransfer(client as any, {
      ...validInput,
      destination: "not-a-key",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on SDK failure (DestinationNotAllowed)", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6039 }),
    });
    const result = await agentTransfer(client as any, validInput);
    expect(result).to.include("DestinationNotAllowed");
  });
});
