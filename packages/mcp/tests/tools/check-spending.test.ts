import { expect } from "chai";
import { checkSpending } from "../../src/tools/check-spending";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";
import { BN } from "@coral-xyz/anchor";

describe("shield_check_spending", () => {
  it("returns spending report with epoch buckets", async () => {
    const client = createMockClient();
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Spending Report");
    expect(result).to.include("Daily Cap");
    expect(result).to.include("Rolling 24h Spend");
  });

  it("handles empty spending data", async () => {
    const client = createMockClient({
      tracker: { buckets: [] },
    });
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("No spending activity");
  });

  it("shows total 24h spend and active buckets", async () => {
    const client = createMockClient({
      tracker: {
        buckets: [
          { epochId: new BN(100), usdAmount: new BN("300000000") },
          { epochId: new BN(101), usdAmount: new BN("200000000") },
        ],
      },
    });
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Total 24h Spend");
    expect(result).to.include("500000000");
    expect(result).to.include("Active Epoch Buckets");
  });

  it("returns error on fetch failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Account not found");
  });

  it("notes transaction history via Anchor events", async () => {
    const client = createMockClient();
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Anchor events");
  });
});
