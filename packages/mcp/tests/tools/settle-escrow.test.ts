import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { settleEscrow } from "../../src/tools/settle-escrow";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";

describe("shield_settle_escrow", () => {
  const destVault = Keypair.generate().publicKey.toBase58();
  const escrowPda = Keypair.generate().publicKey.toBase58();
  const escrowAta = Keypair.generate().publicKey.toBase58();
  const destVaultAta = Keypair.generate().publicKey.toBase58();

  it("settles escrow successfully", async () => {
    const client = createMockClient();
    const result = await settleEscrow(client as any, {
      destinationVault: destVault,
      sourceVault: TEST_VAULT_PDA.toBase58(),
      escrow: escrowPda,
      escrowAta,
      destinationVaultAta: destVaultAta,
      tokenMint: TEST_MINT.toBase58(),
      proof: Buffer.from("proof").toString("base64"),
    });
    expect(result).to.include("Escrow Settled");
    expect(result).to.include("mock-sig-settle-escrow");
  });

  it("returns error on conditions not met", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6053 }),
    });
    const result = await settleEscrow(client as any, {
      destinationVault: destVault,
      sourceVault: TEST_VAULT_PDA.toBase58(),
      escrow: escrowPda,
      escrowAta,
      destinationVaultAta: destVaultAta,
      tokenMint: TEST_MINT.toBase58(),
      proof: Buffer.from("proof").toString("base64"),
    });
    expect(result).to.include("EscrowConditionsNotMet");
  });
});
