import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { updateConstraints } from "../../src/tools/update-constraints";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_update_constraints", () => {
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

  it("updates constraints successfully", async () => {
    const client = createMockClient();
    const result = await updateConstraints(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("Instruction Constraints Updated");
    expect(result).to.include("mock-sig-update-constraints");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6057 }),
    });
    const result = await updateConstraints(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("InvalidConstraintsPda");
  });
});
