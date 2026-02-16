import { expect } from "chai";
import { getPolicyResource } from "../../src/resources/policy";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("resource: shield://vault/{address}/policy", () => {
  it("returns policy JSON for valid vault", async () => {
    const client = createMockClient();
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    const data = JSON.parse(json);
    expect(data.vault).to.equal(TEST_VAULT_PDA.toBase58());
    expect(data.dailySpendingCap).to.equal("10000000000");
    expect(data.maxLeverageBps).to.equal(30000);
    expect(data.allowedTokens).to.be.an("array");
    expect(data.canOpenPositions).to.be.true;
  });

  it("returns default state for missing vault", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    const data = JSON.parse(json);
    expect(data.error).to.include("not found");
    expect(data.dailySpendingCap).to.equal("0");
    expect(data.allowedTokens).to.deep.equal([]);
  });

  it("returns well-formed JSON", async () => {
    const client = createMockClient();
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58()
    );
    expect(() => JSON.parse(json)).not.to.throw();
  });
});
