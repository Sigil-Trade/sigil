import { expect } from "chai";
import { deposit } from "../../src/tools/deposit";
import { createMockClient, TEST_VAULT_PDA, TEST_MINT } from "../helpers/mock-client";

describe("shield_deposit", () => {
  it("deposits successfully", async () => {
    const client = createMockClient();
    const result = await deposit(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "1000000",
    });
    expect(result).to.include("Deposit Successful");
    expect(result).to.include("mock-sig-deposit");
  });

  it("calls SDK deposit with correct args", async () => {
    const client = createMockClient();
    await deposit(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "5000000",
    });
    const call = client.calls.find((c) => c.method === "deposit");
    expect(call).to.exist;
    expect(call!.args[2].toString()).to.equal("5000000");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await deposit(client as any, {
      vault: "bad-address",
      mint: TEST_MINT.toBase58(),
      amount: "1000000",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6000 }),
    });
    const result = await deposit(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "1000000",
    });
    expect(result).to.include("VaultNotActive");
  });
});
