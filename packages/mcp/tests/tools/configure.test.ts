import { expect } from "chai";
import * as sinon from "sinon";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configure } from "../../src/tools/configure";

const MOCK_TEE_RESPONSE = {
  publicKey: "TESTpubkey111111111111111111111111111111111",
  locator: "userId:agent-shield-test-1234",
};

describe("shield_configure", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  let fetchStub: sinon.SinonStub;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-configure-"));
  });

  beforeEach(() => {
    const shieldDir = path.join(tmpHome, ".agentshield");
    if (!fs.existsSync(shieldDir)) {
      fs.mkdirSync(shieldDir, { recursive: true });
    }
    process.env.HOME = tmpHome;
    delete process.env.AGENTSHIELD_WALLET_PATH;
    delete process.env.AGENTSHIELD_RPC_URL;

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
    fetchStub.restore();
    // Clean up config
    const configPath = path.join(tmpHome, ".agentshield", "config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    // Clean up generated wallet
    const walletPath = path.join(
      tmpHome,
      ".agentshield",
      "wallets",
      "agent.json",
    );
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

    expect(result).to.include("AgentShield Configured");
    expect(result).to.include("$500");
    expect(result).to.include("devnet");

    // Verify config file created
    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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

    const walletPath = path.join(
      tmpHome,
      ".agentshield",
      "wallets",
      "agent.json",
    );
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
    const walletDir = path.join(tmpHome, ".agentshield", "wallets");
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

    const configPath = path.join(tmpHome, ".agentshield", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.layers.shield.dailySpendingCapUsd).to.equal(1000);
  });

  it("applies moderate template defaults", async () => {
    await configure(null, {
      template: "moderate",
      network: "devnet",
    });

    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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

    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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

    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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
    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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
    const configPath = path.join(tmpHome, ".agentshield", "config.json");
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
          locator: "userId:agent-shield-existing-1234",
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
    // The configure function uses require("@agent-shield/custody-crossmint").
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (request === "@agent-shield/custody-crossmint") {
        return request; // Return the name itself
      }
      return origResolve.call(this, request, ...args);
    };
    const origCache = require.cache["@agent-shield/custody-crossmint"];
    require.cache["@agent-shield/custody-crossmint"] = {
      id: "@agent-shield/custody-crossmint",
      filename: "@agent-shield/custody-crossmint",
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
      expect(callArgs.linkedUser).to.include("userId:agent-shield-");
    } finally {
      Module._resolveFilename = origResolve;
      if (origCache) {
        require.cache["@agent-shield/custody-crossmint"] = origCache;
      } else {
        delete require.cache["@agent-shield/custody-crossmint"];
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
    delete require.cache["@agent-shield/custody-crossmint"];

    // Override resolver to ensure require() fails (no cached resolution)
    const Module = require("module");
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (request === "@agent-shield/custody-crossmint") {
        throw new Error("Cannot find module '@agent-shield/custody-crossmint'");
      }
      return origResolve.call(this, request, ...args);
    };

    try {
      const result = await configure(null, {
        template: "conservative",
        network: "devnet",
      });

      expect(result).to.include("@agent-shield/custody-crossmint");
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
});
