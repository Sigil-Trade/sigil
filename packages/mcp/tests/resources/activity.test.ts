import { expect } from "chai";
import { getActivityResource } from "../../src/resources/activity";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("resource: shield://vault/{address}/activity", () => {
  it("returns activity JSON for valid vault", async () => {
    const client = createMockClient();
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    const data = JSON.parse(json);
    expect(data.vault).to.equal(TEST_VAULT_PDA.toBase58());
    expect(data.totalTransactions).to.equal(1);
    expect(data.transactions).to.be.an("array").with.length(1);
    expect(data.transactions[0].actionType).to.equal("Swap");
    expect(data.transactions[0].success).to.be.true;
  });

  it("returns default state for missing vault", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    const data = JSON.parse(json);
    expect(data.error).to.include("not found");
    expect(data.transactions).to.deep.equal([]);
    expect(data.totalTransactions).to.equal(0);
  });

  it("returns well-formed JSON with all fields", async () => {
    const client = createMockClient();
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    const data = JSON.parse(json);
    const tx = data.transactions[0];
    expect(tx).to.have.all.keys(
      "timestamp",
      "actionType",
      "tokenMint",
      "amount",
      "protocol",
      "success",
      "slot"
    );
  });
});
