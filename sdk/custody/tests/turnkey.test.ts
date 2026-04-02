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
  TurnkeyWallet,
  turnkey,
  turnkeyFromEnv,
  configFromEnv,
  validateConfig,
  TURNKEY_ENV_KEYS,
  type TurnkeySDKClient,
  type TurnkeyWalletConfig,
} from "../src/turnkey/index.js";

// ---------------------------------------------------------------------------
// Mock SDK client — simulates Turnkey API without real HTTP calls
// ---------------------------------------------------------------------------

/** A Keypair that acts as the "TEE-held" key in our mock. */
const teeKeypair = Keypair.generate();
const TEE_ADDRESS = teeKeypair.publicKey.toBase58();
const MOCK_WALLET_ID = "mock-wallet-id-001";

function createMockClient(opts?: {
  failCreate?: boolean;
  failGet?: boolean;
  failSign?: boolean;
}): TurnkeySDKClient & { calls: { method: string; args: any[] }[] } {
  const calls: { method: string; args: any[] }[] = [];

  return {
    calls,

    async createWallet(params) {
      calls.push({ method: "createWallet", args: [params] });
      if (opts?.failCreate) {
        throw new Error("Mock: wallet creation failed");
      }
      return {
        walletId: MOCK_WALLET_ID,
        address: TEE_ADDRESS,
      };
    },

    async getWallet(walletId) {
      calls.push({ method: "getWallet", args: [walletId] });
      if (opts?.failGet) {
        throw new Error("Mock: wallet lookup failed");
      }
      return { walletId, address: TEE_ADDRESS };
    },

    async signTransaction(walletId, transaction, encoding) {
      calls.push({
        method: "signTransaction",
        args: [walletId, transaction, encoding],
      });
      if (opts?.failSign) {
        throw new Error("Mock: signing failed");
      }

      // Decode the incoming transaction, sign with our TEE keypair, return
      const txBytes = Buffer.from(transaction, "base64");

      // Try legacy Transaction first, fall back to VersionedTransaction
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

describe("@usesigil/custody/turnkey", () => {
  // ---- Config & Validation ------------------------------------------------

  describe("config", () => {
    it("validateConfig throws on empty organizationId", () => {
      expect(() =>
        validateConfig({
          organizationId: "",
          apiKeyId: "key-id",
          apiPrivateKey:
            "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        }),
      ).to.throw("organizationId is required");
    });

    it("validateConfig throws on whitespace-only organizationId", () => {
      expect(() =>
        validateConfig({
          organizationId: "   ",
          apiKeyId: "key-id",
          apiPrivateKey:
            "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        }),
      ).to.throw("organizationId is required");
    });

    it("validateConfig throws on empty apiKeyId", () => {
      expect(() =>
        validateConfig({
          organizationId: "org-123",
          apiKeyId: "",
          apiPrivateKey:
            "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        }),
      ).to.throw("apiKeyId is required");
    });

    it("validateConfig throws on empty apiPrivateKey", () => {
      expect(() =>
        validateConfig({
          organizationId: "org-123",
          apiKeyId: "key-id",
          apiPrivateKey: "",
        }),
      ).to.throw("apiPrivateKey is required");
    });

    it("validateConfig accepts valid config", () => {
      expect(() =>
        validateConfig({
          organizationId: "org-123",
          apiKeyId: "key-id",
          apiPrivateKey:
            "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        }),
      ).to.not.throw();
    });
  });

  describe("configFromEnv", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original env
      for (const key of Object.values(TURNKEY_ENV_KEYS)) {
        if (originalEnv[key] !== undefined) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("throws when TURNKEY_ORGANIZATION_ID is missing", () => {
      delete process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID];
      process.env[TURNKEY_ENV_KEYS.API_KEY_ID] = "key-id";
      process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY] = "pem-key";
      expect(() => configFromEnv()).to.throw("TURNKEY_ORGANIZATION_ID");
    });

    it("throws when TURNKEY_API_KEY_ID is missing", () => {
      process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID] = "org-123";
      delete process.env[TURNKEY_ENV_KEYS.API_KEY_ID];
      process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY] = "pem-key";
      expect(() => configFromEnv()).to.throw("TURNKEY_API_KEY_ID");
    });

    it("throws when TURNKEY_API_PRIVATE_KEY is missing", () => {
      process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID] = "org-123";
      process.env[TURNKEY_ENV_KEYS.API_KEY_ID] = "key-id";
      delete process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY];
      expect(() => configFromEnv()).to.throw("TURNKEY_API_PRIVATE_KEY");
    });

    it("parses minimal config (required fields only)", () => {
      process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID] = "org-abc";
      process.env[TURNKEY_ENV_KEYS.API_KEY_ID] = "key-123";
      process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY] = "pem-data";
      const config = configFromEnv();
      expect(config.organizationId).to.equal("org-abc");
      expect(config.apiKeyId).to.equal("key-123");
      expect(config.apiPrivateKey).to.equal("pem-data");
      expect(config.walletId).to.be.undefined;
      expect(config.baseUrl).to.be.undefined;
    });

    it("parses full config from env", () => {
      process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID] = "org-full";
      process.env[TURNKEY_ENV_KEYS.API_KEY_ID] = "key-full";
      process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY] = "pem-full";
      process.env[TURNKEY_ENV_KEYS.WALLET_ID] = "wallet-full";
      process.env[TURNKEY_ENV_KEYS.BASE_URL] = "https://custom.turnkey.com";

      const config = configFromEnv();
      expect(config.organizationId).to.equal("org-full");
      expect(config.apiKeyId).to.equal("key-full");
      expect(config.apiPrivateKey).to.equal("pem-full");
      expect(config.walletId).to.equal("wallet-full");
      expect(config.baseUrl).to.equal("https://custom.turnkey.com");
    });
  });

  // ---- Wallet Creation ----------------------------------------------------

  describe("TurnkeyWallet.create", () => {
    it("creates a new wallet when no walletId provided", async () => {
      const client = createMockClient();
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(wallet.walletId).to.equal(MOCK_WALLET_ID);
      expect(wallet.provider).to.equal("turnkey");
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("createWallet");
    });

    it("passes walletName to createWallet", async () => {
      const client = createMockClient();
      await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );

      const call = client.calls[0];
      expect(call.args[0].walletName).to.include("sigil-agent-");
    });

    it("uses existing wallet when walletId provided", async () => {
      const client = createMockClient();
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
          walletId: "existing-wallet-id",
        },
        client,
      );

      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
      expect(wallet.walletId).to.equal("existing-wallet-id");
      expect(client.calls).to.have.length(1);
      expect(client.calls[0].method).to.equal("getWallet");
      expect(client.calls[0].args[0]).to.equal("existing-wallet-id");
    });

    it("throws on wallet creation failure", async () => {
      const client = createMockClient({ failCreate: true });
      try {
        await TurnkeyWallet.create(
          {
            organizationId: "org-123",
            apiKeyId: "key-123",
            apiPrivateKey: "pem-key",
          },
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
        await TurnkeyWallet.create(
          {
            organizationId: "org-123",
            apiKeyId: "key-123",
            apiPrivateKey: "pem-key",
            walletId: "bad-id",
          },
          client,
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("wallet lookup failed");
      }
    });

    it("throws on empty organizationId", async () => {
      const client = createMockClient();
      try {
        await TurnkeyWallet.create(
          {
            organizationId: "",
            apiKeyId: "key-123",
            apiPrivateKey: "pem-key",
          },
          client,
        );
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("organizationId is required");
      }
    });
  });

  // ---- Factory Functions --------------------------------------------------

  describe("turnkey() factory", () => {
    it("creates wallet via factory function", async () => {
      const client = createMockClient();
      const wallet = await turnkey(
        {
          organizationId: "org-factory",
          apiKeyId: "key-factory",
          apiPrivateKey: "pem-factory",
        },
        client,
      );

      expect(wallet).to.be.instanceOf(TurnkeyWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });
  });

  describe("turnkeyFromEnv() factory", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.values(TURNKEY_ENV_KEYS)) {
        if (originalEnv[key] !== undefined) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it("creates wallet from env vars", async () => {
      process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID] = "org-env";
      process.env[TURNKEY_ENV_KEYS.API_KEY_ID] = "key-env";
      process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY] = "pem-env";
      const client = createMockClient();
      const wallet = await turnkeyFromEnv(client);

      expect(wallet).to.be.instanceOf(TurnkeyWallet);
      expect(wallet.publicKey.toBase58()).to.equal(TEE_ADDRESS);
    });

    it("throws when env vars missing", async () => {
      delete process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID];
      delete process.env[TURNKEY_ENV_KEYS.API_KEY_ID];
      delete process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY];
      try {
        await turnkeyFromEnv(createMockClient());
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("TURNKEY_ORGANIZATION_ID");
      }
    });
  });

  // ---- WalletLike Contract ------------------------------------------------

  describe("WalletLike contract", () => {
    let wallet: TurnkeyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
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
    let wallet: TurnkeyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );
    });

    it("signs a legacy Transaction", async () => {
      const tx = createTestTransaction();
      const signed = await wallet.signTransaction(tx);

      expect(signed).to.be.instanceOf(Transaction);
      expect(signed.signatures).to.have.length.greaterThan(0);
    });

    it("sends transaction to Turnkey API for signing", async () => {
      const tx = createTestTransaction();
      await wallet.signTransaction(tx);

      const signCall = client.calls.find((c) => c.method === "signTransaction");
      expect(signCall).to.exist;
      expect(signCall!.args[0]).to.equal(wallet.walletId);
      expect(signCall!.args[2]).to.equal("base64");
    });

    it("throws on signing failure", async () => {
      const failClient = createMockClient({ failSign: true });
      const failWallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
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
    let wallet: TurnkeyWallet;

    beforeEach(async () => {
      const client = createMockClient();
      wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
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
    let wallet: TurnkeyWallet;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(async () => {
      client = createMockClient();
      wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
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
    it("returns true when address matches", async () => {
      const client = createMockClient();
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );

      const result = await wallet.verifyProviderCustody();
      expect(result).to.be.true;
    });

    it("returns false when address does not match", async () => {
      const mismatchClient: TurnkeySDKClient & {
        calls: { method: string; args: any[] }[];
      } = {
        calls: [],
        async createWallet(params) {
          return { walletId: MOCK_WALLET_ID, address: TEE_ADDRESS };
        },
        async getWallet(walletId) {
          return {
            walletId,
            address: Keypair.generate().publicKey.toBase58(),
          };
        },
        async signTransaction() {
          return { signedTransaction: "" };
        },
      };

      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        mismatchClient,
      );

      const result = await wallet.verifyProviderCustody();
      expect(result).to.be.false;
    });

    it("calls getWallet with correct walletId", async () => {
      const client = createMockClient();
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );

      await wallet.verifyProviderCustody();
      const getCalls = client.calls.filter((c) => c.method === "getWallet");
      expect(getCalls).to.have.length(1);
      expect(getCalls[0].args[0]).to.equal(MOCK_WALLET_ID);
    });
  });

  // ---- shieldWallet() Compatibility ----------------------------------------

  describe("shieldWallet() compatibility", () => {
    it("TurnkeyWallet satisfies WalletLike interface shape", async () => {
      const client = createMockClient();
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
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
      const wallet = await TurnkeyWallet.create(
        {
          organizationId: "org-123",
          apiKeyId: "key-123",
          apiPrivateKey: "pem-key",
        },
        client,
      );

      expect(wallet.provider).to.equal("turnkey");
      expect(wallet.walletId).to.be.a("string");
      expect(wallet.walletId).to.equal(MOCK_WALLET_ID);
    });
  });
});
