import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { cancelPendingPolicy } from "../../src/tools/cancel-pending-policy";
import { createMockClient } from "../helpers/mock-client";

describe("shield_cancel_pending_policy", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("cancels pending policy successfully", async () => {
    const client = createMockClient();
    const result = await cancelPendingPolicy(client as any, { vault });
    expect(result).to.include("Pending Policy Cancelled");
    expect(result).to.include("mock-sig-cancel");
  });

  it("passes vault PublicKey to SDK", async () => {
    const client = createMockClient();
    await cancelPendingPolicy(client as any, { vault });
    const call = client.calls.find((c) => c.method === "cancelPendingPolicy");
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(vault);
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist or has no data"),
    });
    const result = await cancelPendingPolicy(client as any, { vault });
    expect(result).to.include("Account not found");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await cancelPendingPolicy(client as any, {
      vault: "not-a-key",
    });
    expect(result).to.include("Invalid public key");
  });
});
