import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { reactivateVault } from "../../src/tools/reactivate-vault";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_reactivate_vault", () => {
  it("reactivates vault successfully", async () => {
    const client = createMockClient();
    const result = await reactivateVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Vault Reactivated");
    expect(result).to.include("ACTIVE");
    expect(result).to.include("mock-sig-reactivate");
  });

  it("accepts new agent key", async () => {
    const newAgent = Keypair.generate().publicKey.toBase58();
    const client = createMockClient();
    const result = await reactivateVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      newAgent,
    });
    expect(result).to.include(newAgent);
    const call = client.calls.find((c) => c.method === "reactivateVault");
    expect(call!.args[1].toBase58()).to.equal(newAgent);
  });

  it("passes undefined when no newAgent", async () => {
    const client = createMockClient();
    await reactivateVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    const call = client.calls.find((c) => c.method === "reactivateVault");
    expect(call!.args[1]).to.be.undefined;
  });

  it("returns error when vault not frozen", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6017 }),
    });
    const result = await reactivateVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("VaultNotFrozen");
  });
});
