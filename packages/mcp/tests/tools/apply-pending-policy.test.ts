import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { applyPendingPolicy } from "../../src/tools/apply-pending-policy";
import { createMockClient } from "../helpers/mock-client";

describe("shield_apply_pending_policy", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("applies pending policy successfully", async () => {
    const client = createMockClient();
    const result = await applyPendingPolicy(client as any, { vault });
    expect(result).to.include("Pending Policy Applied");
    expect(result).to.include("mock-sig-apply");
  });

  it("passes vault PublicKey to SDK", async () => {
    const client = createMockClient();
    await applyPendingPolicy(client as any, { vault });
    const call = client.calls.find((c) => c.method === "applyPendingPolicy");
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(vault);
  });

  it("returns error on SDK failure (TimelockNotExpired)", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6036 }),
    });
    const result = await applyPendingPolicy(client as any, { vault });
    expect(result).to.include("TimelockNotExpired");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await applyPendingPolicy(client as any, {
      vault: "not-a-key",
    });
    expect(result).to.include("Invalid public key");
  });
});
