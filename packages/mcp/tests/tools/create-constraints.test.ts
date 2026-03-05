import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { createConstraints } from "../../src/tools/create-constraints";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_create_constraints", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  const entry = {
    programId: Keypair.generate().publicKey.toBase58(),
    dataConstraints: [
      {
        offset: 0,
        operator: "eq" as const,
        value: [0xc3, 0x58, 0x63, 0xa5, 0xb4, 0x8d, 0x2c, 0x81],
      },
    ],
  };

  it("creates constraints successfully", async () => {
    const client = createMockClient();
    const result = await createConstraints(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("Instruction Constraints Created");
    expect(result).to.include("mock-sig-create-constraints");
  });

  it("calls SDK createInstructionConstraints", async () => {
    const client = createMockClient();
    await createConstraints(client as any, { vault, entries: [entry] });
    const call = client.calls.find(
      (c) => c.method === "createInstructionConstraints",
    );
    expect(call).to.exist;
    expect(call!.args[0].toBase58()).to.equal(vault);
    expect(call!.args[1]).to.have.length(1);
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await createConstraints(client as any, {
      vault: "bad",
      entries: [entry],
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6055 }),
    });
    const result = await createConstraints(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("InvalidConstraintConfig");
  });
});
