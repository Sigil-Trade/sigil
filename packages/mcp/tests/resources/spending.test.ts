import { expect } from "chai";
import { getSpendingResource } from "../../src/resources/spending";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("resource: shield://vault/{address}/spending", () => {
  it("returns spending JSON for valid vault", async () => {
    const client = createMockClient();
    const json = await getSpendingResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.vault).to.equal(TEST_VAULT_PDA.toBase58());
    expect(data.dailySpendingCapUsd).to.equal("10000000000");
    expect(data.buckets).to.be.an("array").with.length(1);
    expect(data.buckets[0].usdAmount).to.equal("500000000");
    expect(data.totalRolling24hUsd).to.equal("500000000");
  });

  it("returns default state for missing vault", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const json = await getSpendingResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.error).to.include("not found");
    expect(data.buckets).to.deep.equal([]);
  });

  it("includes percent-of-cap calculation", async () => {
    const client = createMockClient();
    const json = await getSpendingResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    // 500000000 / 10000000000 = 5%
    expect(data.percentOfCap).to.equal("5%");
  });
});
