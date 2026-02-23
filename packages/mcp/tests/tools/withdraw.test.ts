import { expect } from "chai";
import { withdraw } from "../../src/tools/withdraw";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";

describe("shield_withdraw", () => {
  it("withdraws successfully", async () => {
    const client = createMockClient();
    const result = await withdraw(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "500000",
    });
    expect(result).to.include("Withdrawal Successful");
    expect(result).to.include("mock-sig-withdraw");
  });

  it("calls SDK withdraw with correct args", async () => {
    const client = createMockClient();
    await withdraw(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "500000",
    });
    const call = client.calls.find((c) => c.method === "withdraw");
    expect(call).to.exist;
  });

  it("returns error on invalid amount", async () => {
    const client = createMockClient();
    const result = await withdraw(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "not-a-number",
    });
    expect(result).to.include("Invalid numeric value");
  });

  it("returns error when balance insufficient", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6019 }),
    });
    const result = await withdraw(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      mint: TEST_MINT.toBase58(),
      amount: "500000",
    });
    expect(result).to.include("InsufficientBalance");
  });
});
