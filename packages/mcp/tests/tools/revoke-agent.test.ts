import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { revokeAgent } from "../../src/tools/revoke-agent";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_AGENT,
} from "../helpers/mock-client";

describe("shield_revoke_agent", () => {
  const agentKey = TEST_AGENT.publicKey.toBase58();

  it("revokes agent successfully", async () => {
    const client = createMockClient();
    const result = await revokeAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("Agent Revoked");
    expect(result).to.include("mock-sig-revoke");
  });

  it("calls SDK revokeAgent with agent", async () => {
    const client = createMockClient();
    await revokeAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    const call = client.calls.find((c) => c.method === "revokeAgent");
    expect(call).to.exist;
    expect(call!.args[1].toBase58()).to.equal(agentKey);
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await revokeAgent(client as any, {
      vault: "bad",
      agent: agentKey,
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error when no agent registered", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6015 }),
    });
    const result = await revokeAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("NoAgentRegistered");
  });
});
