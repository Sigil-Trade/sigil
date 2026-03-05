import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { updateAgentPermissions } from "../../src/tools/update-agent-permissions";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_AGENT,
} from "../helpers/mock-client";

describe("shield_update_agent_permissions", () => {
  const agentKey = TEST_AGENT.publicKey.toBase58();

  const validInput = {
    vault: TEST_VAULT_PDA.toBase58(),
    agent: agentKey,
    permissions: "2097151",
  };

  it("updates permissions successfully", async () => {
    const client = createMockClient();
    const result = await updateAgentPermissions(client as any, validInput);
    expect(result).to.include("Agent Permissions Updated");
    expect(result).to.include("mock-sig-update-perms");
  });

  it("calls SDK updateAgentPermissions with correct args", async () => {
    const client = createMockClient();
    await updateAgentPermissions(client as any, validInput);
    const call = client.calls.find(
      (c) => c.method === "updateAgentPermissions",
    );
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(TEST_VAULT_PDA.toBase58());
    expect(call!.args[1].toBase58()).to.equal(agentKey);
    expect(call!.args[2].toString()).to.equal("2097151");
  });

  it("returns error for invalid agent key", async () => {
    const client = createMockClient();
    const result = await updateAgentPermissions(client as any, {
      ...validInput,
      agent: "bad",
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on insufficient permissions", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6047 }),
    });
    const result = await updateAgentPermissions(client as any, validInput);
    expect(result).to.include("InsufficientPermissions");
  });
});
