import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { updatePolicy } from "../../src/tools/update-policy";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_update_policy", () => {
  it("updates policy successfully", async () => {
    const client = createMockClient();
    const result = await updatePolicy(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      dailySpendingCap: "50000000000",
    });
    expect(result).to.include("Policy Updated");
    expect(result).to.include("mock-sig-update");
    expect(result).to.include("dailySpendingCap");
  });

  it("passes only provided fields to SDK", async () => {
    const client = createMockClient();
    await updatePolicy(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      maxLeverageBps: 50000,
      canOpenPositions: false,
    });
    const call = client.calls.find((c) => c.method === "updatePolicy");
    expect(call).to.exist;
    const params = call!.args[1];
    expect(params.maxLeverageBps).to.equal(50000);
    expect(params.canOpenPositions).to.equal(false);
    expect(params.dailySpendingCap).to.be.undefined;
  });

  it("handles allowedTokens update", async () => {
    const mint1 = Keypair.generate().publicKey.toBase58();
    const mint2 = Keypair.generate().publicKey.toBase58();
    const client = createMockClient();
    const result = await updatePolicy(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      allowedTokens: [mint1, mint2],
    });
    expect(result).to.include("allowedTokens");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6014 }),
    });
    const result = await updatePolicy(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      allowedTokens: [],
    });
    expect(result).to.include("TooManyAllowedTokens");
  });
});
