import { expect } from "chai";
import { getPolicyResource } from "../../src/resources/policy";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("resource: shield://vault/{address}/policy", () => {
  it("returns policy JSON for valid vault", async () => {
    const client = createMockClient();
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.vault).to.equal(TEST_VAULT_PDA.toBase58());
    expect(data.dailySpendingCapUsd).to.equal("10000000000");
    expect(data.maxLeverageBps).to.equal(30000);
    expect(data.protocolMode).to.equal("allowlist");
    expect(data.protocols).to.be.an("array");
    expect(data.canOpenPositions).to.be.true;
  });

  it("returns default state for missing vault", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Account does not exist"),
    });
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    const data = JSON.parse(json);
    expect(data.error).to.include("not found");
    expect(data.dailySpendingCapUsd).to.equal("0");
    expect(data.protocols).to.deep.equal([]);
    expect(data.protocolMode).to.equal("all");
  });

  it("returns well-formed JSON", async () => {
    const client = createMockClient();
    const json = await getPolicyResource(
      client as any,
      TEST_VAULT_PDA.toBase58(),
    );
    expect(() => JSON.parse(json)).not.to.throw();
  });
});
