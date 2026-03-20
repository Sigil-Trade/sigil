import { expect } from "chai";
import { unpauseAgent } from "../../src/tools/unpause-agent";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_AGENT,
} from "../helpers/mock-client";

describe("shield_unpause_agent", () => {
  const agentKey = TEST_AGENT.publicKey.toBase58();

  it("unpauses agent successfully", async () => {
    const client = createMockClient();
    const result = await unpauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("Agent Unpaused");
    expect(result).to.include("mock-sig-unpause");
  });

  it("calls SDK unpauseAgent with correct args", async () => {
    const client = createMockClient();
    await unpauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    const call = client.calls.find((c) => c.method === "unpauseAgent");
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(TEST_VAULT_PDA.toBase58());
    expect(call!.args[1].toBase58()).to.equal(agentKey);
  });

  it("returns error for invalid agent key", async () => {
    const client = createMockClient();
    const result = await unpauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: "bad",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error when agent not paused", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6069 }),
    });
    const result = await unpauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("AgentNotPaused");
  });
});
