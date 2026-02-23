import { expect } from "chai";
import { revokeAgent } from "../../src/tools/revoke-agent";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_revoke_agent", () => {
  it("revokes agent successfully", async () => {
    const client = createMockClient();
    const result = await revokeAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("Agent Revoked");
    expect(result).to.include("FROZEN");
    expect(result).to.include("mock-sig-revoke");
  });

  it("calls SDK revokeAgent", async () => {
    const client = createMockClient();
    await revokeAgent(client as any, { vault: TEST_VAULT_PDA.toBase58() });
    const call = client.calls.find((c) => c.method === "revokeAgent");
    expect(call).to.exist;
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await revokeAgent(client as any, { vault: "bad" });
    expect(result).to.include("Invalid public key");
  });

  it("returns error when no agent registered", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6016 }),
    });
    const result = await revokeAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
    });
    expect(result).to.include("NoAgentRegistered");
  });
});
