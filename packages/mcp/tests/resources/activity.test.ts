import { expect } from "chai";
import { getActivityResource } from "../../src/resources/activity";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("resource: shield://vault/{address}/activity", () => {
  it("returns activity JSON for valid vault", async () => {
    const client = createMockClient();
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.vault).to.equal(TEST_VAULT_PDA.toBase58());
    expect(data.totalTransactions).to.equal("42");
    expect(data.totalVolume).to.equal("1000000000");
    expect(data.note).to.include("Anchor events");
  });

  it("returns default state for missing vault", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.error).to.include("not found");
    expect(data.totalTransactions).to.equal("0");
    expect(data.totalVolume).to.equal("0");
  });

  it("returns well-formed JSON with all fields", async () => {
    const client = createMockClient();
    const json = await getActivityResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data).to.have.all.keys(
      "vault",
      "totalTransactions",
      "totalVolume",
      "note",
    );
  });
});
