import { expect } from "chai";
import { pauseAgent } from "../../src/tools/pause-agent";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_AGENT,
} from "../helpers/mock-client";

describe("shield_pause_agent", () => {
  const agentKey = TEST_AGENT.publicKey.toBase58();

  it("pauses agent successfully", async () => {
    const client = createMockClient();
    const result = await pauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("Agent Paused");
    expect(result).to.include("mock-sig-pause");
  });

  it("calls SDK pauseAgent with correct args", async () => {
    const client = createMockClient();
    await pauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    const call = client.calls.find((c) => c.method === "pauseAgent");
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(TEST_VAULT_PDA.toBase58());
    expect(call!.args[1].toBase58()).to.equal(agentKey);
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await pauseAgent(client as any, {
      vault: "bad",
      agent: agentKey,
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error when agent already paused", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6068 }),
    });
    const result = await pauseAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("AgentAlreadyPaused");
  });
});
