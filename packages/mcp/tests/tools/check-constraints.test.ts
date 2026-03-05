import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { checkConstraints } from "../../src/tools/check-constraints";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_check_constraints", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("returns no constraints message when none configured", async () => {
    const client = createMockClient();
    const result = await checkConstraints(client as any, { vault });
    expect(result).to.include("No constraints configured");
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await checkConstraints(client as any, { vault: "bad" });
    expect(result).to.include("Invalid public key");
  });
});
