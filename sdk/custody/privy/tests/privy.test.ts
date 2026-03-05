import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  PrivyWallet,
  privy,
  privyFromEnv,
  configFromEnv,
  validateConfig,
  PRIVY_ENV_KEYS,
  type PrivySDKClient,
  type PrivyWalletConfig,
} from "../src";

// ---------------------------------------------------------------------------
// Mock SDK client — simulates Privy API without real HTTP calls
// ---------------------------------------------------------------------------

/** A Keypair that acts as the "TEE-held" key in our mock. */
const teeKeypair = Keypair.generate();
const TEE_ADDRESS = teeKeypair.publicKey.toBase58();
const TEE_WALLET_ID = "wlt_mock_12345";

function createMockClient(opts?: {
  failCreate?: boolean;
  failGet?: boolean;
  failSign?: boolean;
  failGetByAddress?: boolean;
  returnMismatchAddress?: boolean;
}): PrivySDKClient & { calls: { method: string; args: any[] }[] } {
  const calls: { method: string; args: any[] }[] = [];

  return {
    calls,

    async createWallet(params) {
      calls.push({ method: "createWallet", args: [params] });
      if (opts?.failCreate) {
        throw new Error("Mock: wallet creation failed");
      }
      return {
        id: TEE_WALLET_ID,
        address: TEE_ADDRESS,
      };
    },

    async getWallet(walletId) {
      calls.push({ method: "getWallet", args: [walletId] });
      if (opts?.failGet) {
        throw new Error("Mock: wallet lookup failed");
      }
      if (opts?.returnMismatchAddress) {
        return {
          id: walletId,
          address: Keypair.generate().publicKey.toBase58(),
        };
      }
      return { id: walletId, address: TEE_ADDRESS };
    },

    async getWalletByAddress(address) {
      calls.push({ method: "getWalletByAddress", args: [address] });
      if (opts?.failGetByAddress) {
        throw new Error("Mock: address lookup failed");
      }
      if (address === TEE_ADDRESS) {
        return { id: TEE_WALLET_ID, address: TEE_ADDRESS };
      }
      return null;
    },

    async signTransaction(walletId, transaction, encoding) {
      calls.push({
        method: "signTransaction",
        args: [walletId, transaction, encoding],
      });
      if (opts?.failSign) {
        throw new Error("Mock: signing failed");
      }

      const txBytes = Buffer.from(transaction, "base64");

      let signedBytes: Buffer;
      try {
        const legacyTx = Transaction.from(txBytes);
        legacyTx.partialSign(teeKeypair);
        signedBytes = Buffer.from(
          legacyTx.serialize({ requireAllSignatures: false }),
        );
      } catch {
        const vtx = VersionedTransaction.deserialize(txBytes);
        vtx.sign([teeKeypair]);
        signedBytes = Buffer.from(vtx.serialize());
      }

      return {
        signedTransaction: signedBytes.toString("base64"),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create a minimal transaction for signing tests
// ---------------------------------------------------------------------------

function createTestTransaction(): Transaction {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: teeKeypair.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000,
    }),
  );
  tx.recentBlockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
  tx.feePayer = teeKeypair.publicKey;
  return tx;
}

function createTestVersionedTransaction(): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: teeKeypair.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: teeKeypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 500_000,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("@phalnx/custody-privy", () => {
  // ---- Config & Validation ------------------------------------------------

  describe("config", () => {
    it("validateConfig throws on empty appId", () => {
      expect(() => validateConfig({ appId: "", appSecret: "secret" })).to.throw(
        "appId is required",
      );
    });

    it("validateConfig throws on whitespace-only appId", () => {
      expect(() =>
        validateConfig({ appId: "   ", appSecret: "secret" }),
      ).to.throw("appId is required");
    });

    it("validateConfig throws on empty appSecret", () => {
      expect(() =>
        validateConfig({ appId: "clx_test", appSecret: "" }),
      ).to.throw("appSecret is required");
    });

    it("validateConfig throws on whitespace-only appSecret", () => {
      expect(() =>
        validateConfig({ appId: "clx_test", appSecret: "   " }),
      ).to.throw("appSecret is required");
    });

    it("validateConfig accepts valid config", () => {
      expect(() =>
        validateConfig({ appId: "clx_test", appSecret: "sk_test_123" }),
      ).to.not.throw();
    });
  });

  describe("configFromEnv", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.values(PRIVY_ENV_KEYS)) {
        if (originalEnv[key] !== undefined) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("throws when PRIVY_APP_ID is missing", () => {
      delete process.env[PRIVY_ENV_KEYS.APP_ID];
      process.env[PRIVY_ENV_KEYS.APP_SECRET] = "sk_test";
      expect(() => configFromEnv()).to.throw("PRIVY_APP_ID");
    });

    it("throws when PRIVY_APP_SECRET is missing", () => {
      process.env[PRIVY_ENV_KEYS.APP_ID] = "clx_test";
      delete process.env[PRIVY_ENV_KEYS.APP_SECRET];
      expect(() => configFromEnv()).to.throw("PRIVY_APP_SECRET");
    });

    it("parses minimal config (appId + appSecret only)", () => {
      process.env[PRIVY_ENV_KEYS.APP_ID] = "clx_test_abc";
      process.env[PRIVY_ENV_KEYS.APP_SECRET] = "sk_test_abc";
      const config = configFromEnv();
      expect(config.appId).to.equal("clx_test_abc");
      expect(config.appSecret).to.equal("sk_test_abc");
      expect(config.walletId).to.be.undefined;
      expect(config.baseUrl).to.be.undefined;
    });

    it("parses full config from env", () => {
      process.env[PRIVY_ENV_KEYS.APP_ID] = "clx_test_full";
      process.env[PRIVY_ENV_KEYS.APP_SECRET] = "sk_test_full";
      process.env[PRIVY_ENV_KEYS.WALLET_ID] = "wlt_abc123";
      process.env[PRIVY_ENV_KEYS.BASE_URL] = "https://staging.privy.io";

      const config = configFromEnv();
      expect(config.appId).to.equal("clx_test_full");
      expect(config.appSecret).to.equal("sk_test_full");
      expect(config.walletId).to.equal("wlt_abc123");
      expect(config.baseUrl).to.equal("https://staging.privy.io");
    });
  });

  // ---- Wallet Creation ----------------------------------------------------

  describe("PrivyWallet.create", () => {
    it("creates a new wallet when no walletId provided", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(wallet.walletId).to.equal(TEE_WALLET_ID);
      expect(wallet.provider).to.equal("privy");
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("createWallet");
    });

    it("passes chainType: solana to createWallet", async () => {
      const client = createMockClient();
      await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      const call = client.calls[0];
      expect(call.args[0].chainType).to.equal("solana");
    });

    it("uses existing wallet when walletId provided", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        {
          appId: "clx_test",
          appSecret: "sk_test",
          walletId: TEE_WALLET_ID,
        },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(wallet.walletId).to.equal(TEE_WALLET_ID);
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("getWallet");
    });

    it("throws on wallet creation failure", async () => {
      const client = createMockClient({ failCreate: true });
      try {
        await PrivyWallet.create(
          { appId: "clx_test", appSecret: "sk_test" },
          client,
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet creation failed");
      }
    });

    it("throws on wallet lookup failure", async () => {
      const client = createMockClient({ failGet: true });
      try {
        await PrivyWallet.create(
          { appId: "clx_test", appSecret: "sk_test", walletId: "wlt_bad" },
          client,
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet lookup failed");
      }
    });

    it("throws on empty appId", async () => {
      const client = createMockClient();
      try {
        await PrivyWallet.create({ appId: "", appSecret: "sk_test" }, client);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("appId is required");
      }
    });

    it("throws on empty appSecret", async () => {
      const client = createMockClient();
      try {
        await PrivyWallet.create({ appId: "clx_test", appSecret: "" }, client);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("appSecret is required");
      }
    });
  });

  // ---- Factory Functions --------------------------------------------------

  describe("privy() factory", () => {
    it("creates wallet via factory function", async () => {
      const client = createMockClient();
      const wallet = await privy(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      expect(wallet).to.be.instanceOf(PrivyWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });
  });

  describe("privyFromEnv() factory", () => {
    const originalId = process.env[PRIVY_ENV_KEYS.APP_ID];
    const originalSecret = process.env[PRIVY_ENV_KEYS.APP_SECRET];

    afterEach(() => {
      if (originalId !== undefined) {
        process.env[PRIVY_ENV_KEYS.APP_ID] = originalId;
      } else {
        delete process.env[PRIVY_ENV_KEYS.APP_ID];
      }
      if (originalSecret !== undefined) {
        process.env[PRIVY_ENV_KEYS.APP_SECRET] = originalSecret;
      } else {
        delete process.env[PRIVY_ENV_KEYS.APP_SECRET];
      }
    });

    it("creates wallet from env vars", async () => {
      process.env[PRIVY_ENV_KEYS.APP_ID] = "clx_test_env";
      process.env[PRIVY_ENV_KEYS.APP_SECRET] = "sk_test_env";
      const client = createMockClient();
      const wallet = await privyFromEnv(client);

      expect(wallet).to.be.instanceOf(PrivyWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });

    it("throws when env vars missing", async () => {
      delete process.env[PRIVY_ENV_KEYS.APP_ID];
      delete process.env[PRIVY_ENV_KEYS.APP_SECRET];
      try {
        await privyFromEnv(createMockClient());
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("PRIVY_APP_ID");
      }
    });
  });

  // ---- WalletLike Contract ------------------------------------------------

  describe("WalletLike contract", () => {
    let wallet: PrivyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );
    });

    it("has publicKey property", () => {
      expect(wallet.publicKey).to.be.instanceOf(PublicKey);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });

    it("has signTransaction method", () => {
      expect(wallet.signTransaction).to.be.a("function");
    });

    it("has signAllTransactions method", () => {
      expect(wallet.signAllTransactions).to.be.a("function");
    });
  });

  // ---- Transaction Signing ------------------------------------------------

  describe("signTransaction (legacy)", () => {
    let wallet: PrivyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );
    });

    it("signs a legacy Transaction", async () => {
      const tx = createTestTransaction();
      const signed = await wallet.signTransaction(tx);

      expect(signed).to.be.instanceOf(Transaction);
      expect(signed.signatures).to.have.length.greaterThan(0);
    });

    it("sends transaction to Privy API for signing", async () => {
      const tx = createTestTransaction();
      await wallet.signTransaction(tx);

      const signCall = client.calls.find((c) => c.method === "signTransaction");
      expect(signCall).to.exist;
      expect(signCall!.args[0]).to.equal(wallet.walletId);
      expect(signCall!.args[2]).to.equal("base64");
    });

    it("throws on signing failure", async () => {
      const failClient = createMockClient({ failSign: true });
      const failWallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        failClient,
      );

      const tx = createTestTransaction();
      try {
        await failWallet.signTransaction(tx);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("signing failed");
      }
    });
  });

  describe("signTransaction (versioned)", () => {
    let wallet: PrivyWallet;

    beforeEach(async () => {
      const client = createMockClient();
      wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );
    });

    it("signs a VersionedTransaction", async () => {
      const tx = createTestVersionedTransaction();
      const signed = await wallet.signTransaction(tx);

      expect(signed).to.be.instanceOf(VersionedTransaction);
      expect(signed.signatures).to.have.length.greaterThan(0);
    });
  });

  describe("signAllTransactions", () => {
    let wallet: PrivyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );
    });

    it("signs multiple transactions", async () => {
      const txs = [createTestTransaction(), createTestTransaction()];
      const signed = await wallet.signAllTransactions(txs);

      expect(signed).to.have.length(2);
      const signCalls = client.calls.filter(
        (c) => c.method === "signTransaction",
      );
      expect(signCalls).to.have.length(2);
    });

    it("signs empty array", async () => {
      const signed = await wallet.signAllTransactions([]);
      expect(signed).to.have.length(0);
    });
  });

  // ---- Custody Verification -----------------------------------------------

  describe("verifyProviderCustody", () => {
    it("returns true when API confirms custody", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      const result = await wallet.verifyProviderCustody();
      expect(result).to.be.true;

      const getCalls = client.calls.filter((c) => c.method === "getWallet");
      // One from create (if walletId provided) + one from verifyProviderCustody
      // Since create used createWallet, only one getWallet from verify
      expect(getCalls).to.have.length(1);
    });

    it("returns false when API returns mismatched address", async () => {
      const client = createMockClient({ returnMismatchAddress: true });
      // First create with normal client, then swap to mismatch client
      const normalClient = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        normalClient,
      );

      // Replace the internal client via a second wallet with the mismatch client
      const mismatchWallet = await PrivyWallet.create(
        {
          appId: "clx_test",
          appSecret: "sk_test",
          walletId: TEE_WALLET_ID,
        },
        client,
      );
      // The mismatch client returns a different address from getWallet,
      // but create still got TEE_ADDRESS. So verifyProviderCustody should return false.
      const result = await mismatchWallet.verifyProviderCustody();
      expect(result).to.be.false;
    });

    it("throws when API call fails", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      // Make getWallet fail for the custody check
      const failClient = createMockClient({ failGet: true });
      const failWallet = await PrivyWallet.create(
        {
          appId: "clx_test",
          appSecret: "sk_test",
          walletId: TEE_WALLET_ID,
        },
        // We need to pass the mock that will succeed for getWallet during create
        // but fail on subsequent calls. Use a custom approach:
        {
          ...failClient,
          getWallet: async (walletId: string) => {
            // First call (from create) succeeds, second call (from verify) fails
            const calls = failClient.calls.filter(
              (c) => c.method === "getWallet",
            );
            if (calls.length === 0) {
              failClient.calls.push({
                method: "getWallet",
                args: [walletId],
              });
              return { id: walletId, address: TEE_ADDRESS };
            }
            failClient.calls.push({
              method: "getWallet",
              args: [walletId],
            });
            throw new Error("Mock: wallet lookup failed");
          },
          createWallet: failClient.createWallet,
          getWalletByAddress: failClient.getWalletByAddress,
          signTransaction: failClient.signTransaction,
        },
      );

      try {
        await failWallet.verifyProviderCustody();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet lookup failed");
      }
    });
  });

  // ---- shieldWallet() Compatibility ----------------------------------------

  describe("shieldWallet() compatibility", () => {
    it("PrivyWallet satisfies WalletLike interface shape", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      const walletLike: {
        publicKey: PublicKey;
        signTransaction: Function;
        signAllTransactions?: Function;
      } = wallet;

      expect(walletLike.publicKey).to.be.instanceOf(PublicKey);
      expect(walletLike.signTransaction).to.be.a("function");
      expect(walletLike.signAllTransactions).to.be.a("function");
    });

    it("exposes provider metadata", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      expect(wallet.provider).to.equal("privy");
      expect(wallet.walletId).to.be.a("string");
      expect(wallet.walletId).to.equal(TEE_WALLET_ID);
    });

    it("has verifyProviderCustody method", async () => {
      const client = createMockClient();
      const wallet = await PrivyWallet.create(
        { appId: "clx_test", appSecret: "sk_test" },
        client,
      );

      expect(wallet.verifyProviderCustody).to.be.a("function");
    });
  });
});
