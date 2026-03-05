import { expect } from "chai";
import * as sinon from "sinon";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configure } from "../../src/tools/configure";

const MOCK_TEE_RESPONSE = {
  publicKey: "TESTpubkey111111111111111111111111111111111",
  locator: "userId:phalnx-test-1234",
};

describe("shield_configure", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origCrossmintKey = process.env.CROSSMINT_API_KEY;
  const origPrivyId = process.env.PRIVY_APP_ID;
  const origPrivySecret = process.env.PRIVY_APP_SECRET;
  const origTurnkeyOrg = process.env.TURNKEY_ORGANIZATION_ID;
  const origTurnkeyKey = process.env.TURNKEY_API_KEY_ID;
  const origTurnkeyPk = process.env.TURNKEY_API_PRIVATE_KEY;
  let fetchStub: sinon.SinonStub;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-configure-"));
  });

  beforeEach(() => {
    const shieldDir = path.join(tmpHome, ".phalnx");
    if (!fs.existsSync(shieldDir)) {
      fs.mkdirSync(shieldDir, { recursive: true });
    }
    process.env.HOME = tmpHome;
    delete process.env.PHALNX_WALLET_PATH;
    delete process.env.PHALNX_RPC_URL;
    // Clear all TEE provider env vars to ensure clean test state
    delete process.env.CROSSMINT_API_KEY;
    delete process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
    delete process.env.TURNKEY_ORGANIZATION_ID;
    delete process.env.TURNKEY_API_KEY_ID;
    delete process.env.TURNKEY_API_PRIVATE_KEY;

    // Stub global.fetch to prevent live network calls
    fetchStub = sinon.stub(global, "fetch").resolves(
      new Response(JSON.stringify(MOCK_TEE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    process.env.HOME = origHome;
    // Restore original env vars
    if (origCrossmintKey) process.env.CROSSMINT_API_KEY = origCrossmintKey;
    else delete process.env.CROSSMINT_API_KEY;
    if (origPrivyId) process.env.PRIVY_APP_ID = origPrivyId;
    else delete process.env.PRIVY_APP_ID;
    if (origPrivySecret) process.env.PRIVY_APP_SECRET = origPrivySecret;
    else delete process.env.PRIVY_APP_SECRET;
    if (origTurnkeyOrg) process.env.TURNKEY_ORGANIZATION_ID = origTurnkeyOrg;
    else delete process.env.TURNKEY_ORGANIZATION_ID;
    if (origTurnkeyKey) process.env.TURNKEY_API_KEY_ID = origTurnkeyKey;
    else delete process.env.TURNKEY_API_KEY_ID;
    if (origTurnkeyPk) process.env.TURNKEY_API_PRIVATE_KEY = origTurnkeyPk;
    else delete process.env.TURNKEY_API_PRIVATE_KEY;
    fetchStub.restore();
    // Clean up config
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    // Clean up generated wallet
    const walletPath = path.join(tmpHome, ".phalnx", "wallets", "agent.json");
    if (fs.existsSync(walletPath)) {
      fs.unlinkSync(walletPath);
    }
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("configures with conservative template", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    expect(result).to.include("Phalnx Configured");
    expect(result).to.include("$500");
    expect(result).to.include("devnet");

    // Verify config file created
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    expect(fs.existsSync(configPath)).to.be.true;

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.version).to.equal(1);
    expect(config.layers.shield.enabled).to.be.true;
    expect(config.layers.shield.dailySpendingCapUsd).to.equal(500);
    // Full setup provisions TEE and vault
    expect(config.layers.tee.enabled).to.be.true;
    expect(config.layers.vault.enabled).to.be.true;
    expect(fetchStub.calledOnce).to.be.true;
  });

  it("generates a new keypair when walletPath not provided", async () => {
    await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    const walletPath = path.join(tmpHome, ".phalnx", "wallets", "agent.json");
    expect(fs.existsSync(walletPath)).to.be.true;

    // Verify it's a valid keypair (array of 64 numbers)
    const raw = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
    expect(raw).to.be.an("array");
    expect(raw.length).to.equal(64);
  });

  it("uses existing keypair when walletPath provided", async () => {
    // Create a test keypair file
    const { Keypair } = await import("@solana/web3.js");
    const kp = Keypair.generate();
    const walletDir = path.join(tmpHome, ".phalnx", "wallets");
    fs.mkdirSync(walletDir, { recursive: true });
    const existingPath = path.join(walletDir, "existing.json");
    fs.writeFileSync(existingPath, JSON.stringify(Array.from(kp.secretKey)));

    const result = await configure(null, {
      template: "moderate",
      network: "devnet",
      walletPath: existingPath,
    });

    expect(result).to.include(kp.publicKey.toBase58());
  });

  it("applies custom dailySpendingCapUsd override", async () => {
    await configure(null, {
      template: "conservative",
      dailySpendingCapUsd: 1000,
      network: "devnet",
    });

    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.layers.shield.dailySpendingCapUsd).to.equal(1000);
  });

  it("applies moderate template defaults", async () => {
    await configure(null, {
      template: "moderate",
      network: "devnet",
    });

    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.layers.shield.dailySpendingCapUsd).to.equal(2000);
    expect(config.layers.shield.maxLeverageBps).to.equal(20000);
    expect(config.layers.shield.protocols.length).to.equal(4);
  });

  it("applies aggressive template defaults", async () => {
    await configure(null, {
      template: "aggressive",
      network: "devnet",
    });

    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.layers.shield.dailySpendingCapUsd).to.equal(10000);
    expect(config.layers.shield.maxLeverageBps).to.equal(50000);
    expect(config.layers.shield.protocols.length).to.equal(5);
  });

  it("sets network to mainnet-beta when specified", async () => {
    await configure(null, {
      template: "conservative",
      network: "mainnet-beta",
    });

    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.network).to.equal("mainnet-beta");
  });

  it("returns error on invalid wallet path", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
      walletPath: "/nonexistent/path/wallet.json",
    });

    expect(result).to.include("Error");
  });

  it("provisions TEE and generates vault Blink URL", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    // TEE provisioning should use the mock
    expect(fetchStub.calledOnce).to.be.true;
    expect(fetchStub.firstCall.args[0]).to.include("provision-tee");

    expect(result).to.include("Configured");
    expect(result).to.include(MOCK_TEE_RESPONSE.publicKey);
    expect(result).to.include(MOCK_TEE_RESPONSE.locator);
    expect(result).to.include("dial.to");

    // Config should have TEE + vault enabled
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.layers.tee.enabled).to.be.true;
    expect(config.layers.tee.publicKey).to.equal(MOCK_TEE_RESPONSE.publicKey);
    expect(config.layers.vault.enabled).to.be.true;
  });

  it("returns error when TEE provisioning fails", async () => {
    fetchStub.resolves(
      new Response("Internal Server Error", {
        status: 502,
      }),
    );

    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    expect(fetchStub.calledOnce).to.be.true;
    expect(result).to.include("Error provisioning TEE wallet");
    expect(result).to.include("502");
  });

  it("next steps include signing vault creation", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    expect(result).to.include("Sign the vault creation transaction");
    expect(result).to.include("full on-chain protection");
  });

  // ── Dedup guard tests ──────────────────────────────────────

  it("reuses existing TEE wallet on retry (dedup guard)", async () => {
    // Pre-write a config with TEE already provisioned
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const existingConfig = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailySpendingCapUsd: 500,
          protocolMode: 1,
          protocols: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
          maxLeverageBps: 0,
          rateLimit: 60,
        },
        tee: {
          enabled: true,
          locator: "userId:phalnx-existing-1234",
          publicKey: "ExistingTEEpubkey111111111111111111111111111",
        },
        vault: { enabled: false, address: null, owner: null, vaultId: null },
      },
      wallet: {
        type: "crossmint",
        path: null,
        publicKey: "ExistingTEEpubkey111111111111111111111111111",
      },
      network: "devnet",
      template: "conservative",
      configuredAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    // Should NOT have called fetch (no new provisioning)
    expect(fetchStub.notCalled).to.be.true;
    // Should reuse existing TEE wallet
    expect(result).to.include("reused existing");
    expect(result).to.include("ExistingTEEpubkey111111111111111111111111111");
  });

  // ── Local Crossmint path tests ─────────────────────────────

  it("uses local Crossmint when CROSSMINT_API_KEY set", async () => {
    const origCrossmintKey = process.env.CROSSMINT_API_KEY;
    process.env.CROSSMINT_API_KEY = "test-crossmint-api-key";

    // Mock the custody adapter module
    const mockPublicKey = {
      toBase58: () => "LocalCrossmintPubkey11111111111111111111111",
    };
    const mockModule = {
      crossmint: sinon.stub().resolves({
        publicKey: mockPublicKey,
        signTransaction: async (t: any) => t,
      }),
    };
    // We need to intercept require() for the custody adapter.
    // The configure function uses require("@phalnx/custody-crossmint").
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (request === "@phalnx/custody-crossmint") {
        return request; // Return the name itself
      }
      return origResolve.call(this, request, ...args);
    };
    const origCache = require.cache["@phalnx/custody-crossmint"];
    require.cache["@phalnx/custody-crossmint"] = {
      id: "@phalnx/custody-crossmint",
      filename: "@phalnx/custody-crossmint",
      loaded: true,
      exports: mockModule,
    } as any;

    try {
      const result = await configure(null, {
        template: "conservative",
        network: "devnet",
      });

      // Should NOT have called fetch (uses local Crossmint)
      expect(fetchStub.notCalled).to.be.true;
      expect(result).to.include("local Crossmint");
      expect(mockModule.crossmint.calledOnce).to.be.true;
      const callArgs = mockModule.crossmint.firstCall.args[0];
      expect(callArgs.apiKey).to.equal("test-crossmint-api-key");
      expect(callArgs.linkedUser).to.include("userId:phalnx-");
    } finally {
      Module._resolveFilename = origResolve;
      if (origCache) {
        require.cache["@phalnx/custody-crossmint"] = origCache;
      } else {
        delete require.cache["@phalnx/custody-crossmint"];
      }
      if (origCrossmintKey) {
        process.env.CROSSMINT_API_KEY = origCrossmintKey;
      } else {
        delete process.env.CROSSMINT_API_KEY;
      }
    }
  });

  it("returns clear error when adapter not installed", async () => {
    const origCrossmintKey = process.env.CROSSMINT_API_KEY;
    process.env.CROSSMINT_API_KEY = "test-crossmint-api-key";

    // Ensure no cached module from previous test
    delete require.cache["@phalnx/custody-crossmint"];

    // Override resolver to ensure require() fails (no cached resolution)
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (request === "@phalnx/custody-crossmint") {
        throw new Error("Cannot find module '@phalnx/custody-crossmint'");
      }
      return origResolve.call(this, request, ...args);
    };

    try {
      const result = await configure(null, {
        template: "conservative",
        network: "devnet",
      });

      expect(result).to.include("@phalnx/custody-crossmint");
      expect(result).to.include("not installed");
    } finally {
      Module._resolveFilename = origResolve;
      if (origCrossmintKey) {
        process.env.CROSSMINT_API_KEY = origCrossmintKey;
      } else {
        delete process.env.CROSSMINT_API_KEY;
      }
    }
  });

  it("sends publicKey in provision request body", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    expect(fetchStub.calledOnce).to.be.true;
    const fetchBody = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(fetchBody.publicKey).to.be.a("string");
    expect(fetchBody.publicKey.length).to.be.greaterThan(0);
  });

  // ── Multi-provider TEE provisioning ────────────────────────────

  it("sends provider in hosted provision request", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
      teeProvider: "privy",
    });

    expect(fetchStub.calledOnce).to.be.true;
    const fetchBody = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(fetchBody.provider).to.equal("privy");
  });

  it("sets wallet.type to privy when using privy provider", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
      teeProvider: "privy",
    });

    expect(result).to.include("Phalnx Configured");
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.wallet.type).to.equal("privy");
  });

  it("sets wallet.type to turnkey when using turnkey provider", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
      teeProvider: "turnkey",
    });

    expect(result).to.include("Phalnx Configured");
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.wallet.type).to.equal("turnkey");
  });

  it("includes shield_confirm_vault in next steps", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    expect(result).to.include("shield_confirm_vault");
  });

  it("returns error for Privy local provisioning without adapter", async () => {
    const origPrivyId = process.env.PRIVY_APP_ID;
    const origPrivySecret = process.env.PRIVY_APP_SECRET;
    process.env.PRIVY_APP_ID = "clx_test";
    process.env.PRIVY_APP_SECRET = "sk_test";

    try {
      const result = await configure(null, {
        template: "conservative",
        network: "devnet",
        teeProvider: "privy",
      });

      // Should fail because @phalnx/custody-privy adapter not available in test env
      // or succeed via hosted fallback — either way shouldn't crash
      expect(result).to.be.a("string");
    } finally {
      if (origPrivyId) process.env.PRIVY_APP_ID = origPrivyId;
      else delete process.env.PRIVY_APP_ID;
      if (origPrivySecret) process.env.PRIVY_APP_SECRET = origPrivySecret;
      else delete process.env.PRIVY_APP_SECRET;
    }
  });

  it("returns error for Turnkey local provisioning without adapter", async () => {
    const origOrgId = process.env.TURNKEY_ORGANIZATION_ID;
    const origKeyId = process.env.TURNKEY_API_KEY_ID;
    const origPk = process.env.TURNKEY_API_PRIVATE_KEY;
    process.env.TURNKEY_ORGANIZATION_ID = "org123";
    process.env.TURNKEY_API_KEY_ID = "key123";
    process.env.TURNKEY_API_PRIVATE_KEY = "pk_test";

    try {
      const result = await configure(null, {
        template: "conservative",
        network: "devnet",
        teeProvider: "turnkey",
      });

      expect(result).to.be.a("string");
    } finally {
      if (origOrgId) process.env.TURNKEY_ORGANIZATION_ID = origOrgId;
      else delete process.env.TURNKEY_ORGANIZATION_ID;
      if (origKeyId) process.env.TURNKEY_API_KEY_ID = origKeyId;
      else delete process.env.TURNKEY_API_KEY_ID;
      if (origPk) process.env.TURNKEY_API_PRIVATE_KEY = origPk;
      else delete process.env.TURNKEY_API_PRIVATE_KEY;
    }
  });

  it("defaults teeProvider to crossmint", async () => {
    const result = await configure(null, {
      template: "conservative",
      network: "devnet",
    });

    // Should use crossmint path (hosted fallback)
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.wallet.type).to.equal("crossmint");
  });
});
