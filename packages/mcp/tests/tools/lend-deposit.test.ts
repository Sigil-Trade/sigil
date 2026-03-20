import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { lendDeposit } from "../../src/tools/lend-deposit";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_lend_deposit", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const mockConfig = {
    walletPath: "/tmp/fake-wallet.json",
    rpcUrl: "https://api.devnet.solana.com",
    agentKeypairPath: "/tmp/fake-agent.json",
  } as any;

  const mockCustodyWallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async <T>(tx: T): Promise<T> => tx,
  };

  const validInput = {
    vault: TEST_VAULT_PDA.toBase58(),
    mint,
    amount: "1000000",
  };

  it("deposits successfully with custody wallet", async () => {
    const client = createMockClient();
    const result = await lendDeposit(
      client as any,
      mockConfig,
      validInput,
      mockCustodyWallet,
    );
    expect(result).to.include("Lend Deposit Complete");
    expect(result).to.include("mock-sig-lend-deposit");
    expect(result).to.include(TEST_VAULT_PDA.toBase58());
    expect(result).to.include(mint);
    expect(result).to.include("1000000");
  });

  it("calls jupiterLendDeposit with correct params", async () => {
    const client = createMockClient();
    await lendDeposit(client as any, mockConfig, validInput, mockCustodyWallet);
    const call = client.calls.find((c) => c.method === "jupiterLendDeposit");
    expect(call).to.exist;
    expect(call!.args[0].agent.toBase58()).to.equal(
      mockCustodyWallet.publicKey.toBase58(),
    );
    expect(call!.args[0].amount.toString()).to.equal("1000000");
  });

  it("mentions spending cap in response", async () => {
    const client = createMockClient();
    const result = await lendDeposit(
      client as any,
      mockConfig,
      validInput,
      mockCustodyWallet,
    );
    expect(result).to.include("spending cap");
  });

  it("returns error on SDK failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6006 }),
    });
    const result = await lendDeposit(
      client as any,
      mockConfig,
      validInput,
      mockCustodyWallet,
    );
    expect(result).to.include("SpendingCapExceeded");
  });

  it("returns error on invalid vault address", async () => {
    const client = createMockClient();
    const result = await lendDeposit(
      client as any,
      mockConfig,
      { ...validInput, vault: "bad-address" },
      mockCustodyWallet,
    );
    expect(result).to.include("Invalid public key");
  });
});
