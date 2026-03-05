import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { registerAgent } from "../../src/tools/register-agent";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_AGENT,
} from "../helpers/mock-client";

describe("shield_register_agent (permissions)", () => {
  const agentKey = Keypair.generate().publicKey.toBase58();

  it("registers with default full permissions when omitted", async () => {
    const client = createMockClient();
    await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
    });
    const call = client.calls.find((c) => c.method === "registerAgent");
    expect(call).to.exist;
    expect(call!.args).to.have.lengthOf(3);
    expect(call!.args[2].toString()).to.equal("2097151");
  });

  it("registers with custom permissions", async () => {
    const client = createMockClient();
    await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
      permissions: "1",
    });
    const call = client.calls.find((c) => c.method === "registerAgent");
    expect(call).to.exist;
    expect(call!.args[2].toString()).to.equal("1");
  });

  it("includes permissions in output", async () => {
    const client = createMockClient();
    const result = await registerAgent(client as any, {
      vault: TEST_VAULT_PDA.toBase58(),
      agent: agentKey,
      permissions: "255",
    });
    expect(result).to.include("Permissions:");
  });
});
