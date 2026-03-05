import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { closeConstraints } from "../../src/tools/close-constraints";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_close_constraints", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("closes constraints successfully", async () => {
    const client = createMockClient();
    const result = await closeConstraints(client as any, { vault });
    expect(result).to.include("Instruction Constraints Removed");
    expect(result).to.include("mock-sig-close-constraints");
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await closeConstraints(client as any, { vault: "bad" });
    expect(result).to.include("Invalid public key");
  });
});
