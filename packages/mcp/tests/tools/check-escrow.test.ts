import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { checkEscrow } from "../../src/tools/check-escrow";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_check_escrow", () => {
  const destVault = Keypair.generate().publicKey.toBase58();

  it("returns escrow status", async () => {
    const client = createMockClient();
    const result = await checkEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrowId: "1",
    });
    expect(result).to.include("Escrow Status");
    expect(result).to.include("Active");
    expect(result).to.include("Amount");
  });

  it("calls SDK fetchEscrow", async () => {
    const client = createMockClient();
    await checkEscrow(client as any, {
      sourceVault: TEST_VAULT_PDA.toBase58(),
      destinationVault: destVault,
      escrowId: "1",
    });
    const call = client.calls.find((c) => c.method === "fetchEscrow");
    expect(call).to.exist;
  });

  it("returns error for invalid vault", async () => {
    const client = createMockClient();
    const result = await checkEscrow(client as any, {
      sourceVault: "bad",
      destinationVault: destVault,
      escrowId: "1",
    });
    expect(result).to.include("Invalid public key");
  });
});
