import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { closeSettledEscrow } from "../../src/tools/close-settled-escrow";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_close_settled_escrow", () => {
  const destVault = Keypair.generate().publicKey.toBase58();
  const escrowPda = Keypair.generate().publicKey.toBase58();

  it("closes settled escrow successfully", async () => {
    const client = createMockClient();
    const result = await closeSettledEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrow: escrowPda,
      escrowId: "1",
    });
    expect(result).to.include("Escrow Account Closed");
    expect(result).to.include("mock-sig-close-escrow");
  });

  it("returns error when not settled", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6049 }),
    });
    const result = await closeSettledEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrow: escrowPda,
      escrowId: "1",
    });
    expect(result).to.include("EscrowNotActive");
  });
});
