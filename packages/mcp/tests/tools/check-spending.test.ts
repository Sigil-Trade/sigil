import { expect } from "chai";
import { checkSpending } from "../../src/tools/check-spending";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_check_spending", () => {
  it("returns spending report with rolling spends", async () => {
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
      tracker: { rollingSpends: [], recentTransactions: [] },
    });
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("No spending activity");
    expect(result).to.include("No recent transactions");
  });

  it("shows recent transactions", async () => {
    const client = createMockClient();
    const result = await checkSpending(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Recent Transactions");
    expect(result).to.include("OK");
    expect(result).to.include("Swap");
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
});
