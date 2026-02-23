import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { registerAgent } from "../../src/tools/register-agent";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_register_agent", () => {
  const agentKey = Keypair.generate().publicKey.toBase58();

  it("registers agent successfully", async () => {
    const client = createMockClient();
    const result = await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("Agent Registered");
    expect(result).to.include("mock-sig-register");
    expect(result).to.include(agentKey);
  });

  it("calls SDK registerAgent with correct args", async () => {
    const client = createMockClient();
    await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    const call = client.calls.find((c) => c.method === "registerAgent");
    expect(call).to.exist;
    expect(call!.args[1].toBase58()).to.equal(agentKey);
  });

  it("returns error for invalid agent key", async () => {
    const client = createMockClient();
    const result = await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: "invalid",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error when agent already registered", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6015 }),
    });
    const result = await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    expect(result).to.include("AgentAlreadyRegistered");
  });
});
