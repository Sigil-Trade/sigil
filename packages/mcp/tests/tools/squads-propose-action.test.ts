import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { squadsProposeAction } from "../../src/tools/squads-propose-action";
import { createMockClient, createMockConfig } from "../helpers/mock-client";

describe("shield_squads_propose_action", () => {
  let mockConfig: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    mockConfig = createMockConfig();
  });

  afterEach(() => {
    mockConfig.cleanup();
  });

  const multisig = Keypair.generate().publicKey.toBase58();
  const vault = Keypair.generate().publicKey.toBase58();

  const validInput = {
    multisig,
    vaultIndex: 0,
    action: "update_policy" as const,
    phalnxVault: vault,
    actionParams: JSON.stringify({ dailySpendingCapUsd: "5000000000" }),
  };

  it("proposes action successfully", async () => {
    const client = createMockClient();
    const result = await squadsProposeAction(
      client as any,
      mockConfig as any,
      validInput,
    );
    expect(result).to.include("Squads Proposal Created");
    expect(result).to.include("update policy");
    expect(result).to.include("Transaction Index");
  });

  it("calls squadsProposeAction on client", async () => {
    const client = createMockClient();
    await squadsProposeAction(client as any, mockConfig as any, validInput);
    const call = client.calls.find((c) => c.method === "squadsProposeAction");
    expect(call).to.exist;
    const params = call!.args[0];
    expect(params.action).to.equal("update_policy");
    expect(params.phalnxVault.toBase58()).to.equal(vault);
  });

  it("handles apply_pending_policy (no actionParams)", async () => {
    const client = createMockClient();
    const result = await squadsProposeAction(client as any, mockConfig as any, {
      multisig,
      vaultIndex: 0,
      action: "apply_pending_policy" as const,
      phalnxVault: vault,
    });
    expect(result).to.include("Squads Proposal Created");
    expect(result).to.include("apply pending policy");
  });

  it("rejects invalid actionParams JSON", async () => {
    const client = createMockClient();
    const result = await squadsProposeAction(client as any, mockConfig as any, {
      ...validInput,
      actionParams: "not-json",
    });
    expect(result).to.include("valid JSON");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("Multisig not found"),
    });
    const result = await squadsProposeAction(
      client as any,
      mockConfig as any,
      validInput,
    );
    expect(result).to.include("Multisig not found");
  });
});
