import { expect } from "chai";
import { checkVault } from "../../src/tools/check-vault";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_OWNER,
} from "../helpers/mock-client";

describe("shield_check_vault", () => {
  it("returns vault status by address", async () => {
    const client = createMockClient();
    const result = await checkVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Vault:");
    expect(result).to.include("Active");
    expect(result).to.include("Policy");
    expect(result).to.include("Daily Spending Cap");
  });

  it("derives vault PDA from owner + vaultId", async () => {
    const client = createMockClient();
    const result = await checkVault(client as any, {
      vault: "",
      owner: TEST_OWNER.publicKey.toBase58(),
      vaultId: "1",
    });
    // The mock resolves getVaultPDA and then fetches by address
    expect(client.calls.some((c) => c.method === "getVaultPDA")).to.be.true;
  });

  it("returns error for missing input", async () => {
    const client = createMockClient();
    const result = await checkVault(client as any, {
      vault: "",
    });
    expect(result).to.include("Error");
  });

  it("returns formatted error on fetch failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const result = await checkVault(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Account not found");
  });
});
