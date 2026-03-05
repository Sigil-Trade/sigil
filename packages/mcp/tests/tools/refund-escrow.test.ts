import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { refundEscrow } from "../../src/tools/refund-escrow";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";

describe("shield_refund_escrow", () => {
  const escrowPda = Keypair.generate().publicKey.toBase58();
  const escrowAta = Keypair.generate().publicKey.toBase58();
  const sourceVaultAta = Keypair.generate().publicKey.toBase58();

  it("refunds escrow successfully", async () => {
    const client = createMockClient();
    const result = await refundEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      escrow: escrowPda,
      escrowAta,
      sourceVaultAta,
      tokenMint: TEST_MINT.toBase58(),
    });
    expect(result).to.include("Escrow Refunded");
    expect(result).to.include("mock-sig-refund-escrow");
  });

  it("returns error when not expired", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6051 }),
    });
    const result = await refundEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      escrow: escrowPda,
      escrowAta,
      sourceVaultAta,
      tokenMint: TEST_MINT.toBase58(),
    });
    expect(result).to.include("EscrowNotExpired");
  });
});
