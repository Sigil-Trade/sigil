import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { createEscrow } from "../../src/tools/create-escrow";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";

describe("shield_create_escrow", () => {
  const destVault = Keypair.generate().publicKey.toBase58();
  const sourceVaultAta = Keypair.generate().publicKey.toBase58();

  it("creates escrow successfully", async () => {
    const client = createMockClient();
    const result = await createEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrowId: "1",
      amount: "1000000",
      expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
      conditionHash: new Array(32).fill(0),
      tokenMint: TEST_MINT.toBase58(),
      sourceVaultAta,
    });
    expect(result).to.include("Escrow Created");
    expect(result).to.include("mock-sig-create-escrow");
  });

  it("calls SDK createEscrow", async () => {
    const client = createMockClient();
    await createEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrowId: "1",
      amount: "1000000",
      expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
      conditionHash: new Array(32).fill(0),
      tokenMint: TEST_MINT.toBase58(),
      sourceVaultAta,
    });
    const call = client.calls.find((c) => c.method === "createEscrow");
    expect(call).to.exist;
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await createEscrow(client as any, {
      sourceVault: "bad",
      destinationVault: destVault,
      escrowId: "1",
      amount: "1000000",
      expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
      conditionHash: new Array(32).fill(0),
      tokenMint: TEST_MINT.toBase58(),
      sourceVaultAta,
    });
    expect(result).to.include("Invalid public key");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6054 }),
    });
    const result = await createEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrowId: "1",
      amount: "1000000",
      expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
      conditionHash: new Array(32).fill(0),
      tokenMint: TEST_MINT.toBase58(),
      sourceVaultAta,
    });
    expect(result).to.include("EscrowDurationExceeded");
  });
});
