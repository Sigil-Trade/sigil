import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadConfig,
  loadKeypair,
  loadAgentKeypair,
  loadShieldConfig,
  saveShieldConfig,
  resolveClient,
} from "../src/config";

describe("config", () => {
  let tmpDir: string;
  let keypairPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
    const kp = Keypair.generate();
    keypairPath = path.join(tmpDir, "test-keypair.json");
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe("loadConfig", () => {
    let originalWalletPath: string | undefined;
    let originalRpcUrl: string | undefined;
    let originalAgentPath: string | undefined;

    beforeEach(() => {
      originalWalletPath = process.env.AGENTSHIELD_WALLET_PATH;
      originalRpcUrl = process.env.AGENTSHIELD_RPC_URL;
      originalAgentPath = process.env.AGENTSHIELD_AGENT_KEYPAIR_PATH;
    });

    afterEach(() => {
      if (originalWalletPath !== undefined)
        process.env.AGENTSHIELD_WALLET_PATH = originalWalletPath;
      else delete process.env.AGENTSHIELD_WALLET_PATH;

      if (originalRpcUrl !== undefined)
        process.env.AGENTSHIELD_RPC_URL = originalRpcUrl;
      else delete process.env.AGENTSHIELD_RPC_URL;

      if (originalAgentPath !== undefined)
        process.env.AGENTSHIELD_AGENT_KEYPAIR_PATH = originalAgentPath;
      else delete process.env.AGENTSHIELD_AGENT_KEYPAIR_PATH;
    });

    it("throws when AGENTSHIELD_WALLET_PATH is not set", () => {
      delete process.env.AGENTSHIELD_WALLET_PATH;
      expect(() => loadConfig()).to.throw(
        "AGENTSHIELD_WALLET_PATH is required",
      );
    });

    it("loads config with required env vars", () => {
      process.env.AGENTSHIELD_WALLET_PATH = keypairPath;
      delete process.env.AGENTSHIELD_RPC_URL;
      const config = loadConfig();
      expect(config.walletPath).to.equal(keypairPath);
      expect(config.rpcUrl).to.include("devnet");
    });

    it("uses custom RPC URL when provided", () => {
      process.env.AGENTSHIELD_WALLET_PATH = keypairPath;
      process.env.AGENTSHIELD_RPC_URL = "http://localhost:8899";
      const config = loadConfig();
      expect(config.rpcUrl).to.equal("http://localhost:8899");
    });

    it("loads agent keypair path when provided", () => {
      process.env.AGENTSHIELD_WALLET_PATH = keypairPath;
      process.env.AGENTSHIELD_AGENT_KEYPAIR_PATH = keypairPath;
      const config = loadConfig();
      expect(config.agentKeypairPath).to.equal(keypairPath);
    });
  });

  describe("loadKeypair", () => {
    it("loads a valid keypair from file", () => {
      const kp = loadKeypair(keypairPath);
      expect(kp).to.have.property("publicKey");
      expect(kp).to.have.property("secretKey");
    });

    it("throws on invalid file path", () => {
      expect(() => loadKeypair("/nonexistent/keypair.json")).to.throw();
    });

    it("resolves tilde to os.homedir()", () => {
      // Create a keypair in a subdir of homedir so tilde expansion works
      const homeDir = os.homedir();
      const subDir = fs.mkdtempSync(path.join(homeDir, ".mcp-test-tilde-"));
      const kp = Keypair.generate();
      const tildeKpPath = path.join(subDir, "tilde-kp.json");
      fs.writeFileSync(tildeKpPath, JSON.stringify(Array.from(kp.secretKey)));

      // Build path with ~ prefix
      const relative = tildeKpPath.slice(homeDir.length);
      const tildePath = "~" + relative;

      try {
        const loaded = loadKeypair(tildePath);
        expect(loaded.publicKey.toBase58()).to.equal(kp.publicKey.toBase58());
      } finally {
        fs.rmSync(subDir, { recursive: true, force: true });
      }
    });
  });

  describe("loadAgentKeypair", () => {
    it("throws when agentKeypairPath is not set", () => {
      expect(() =>
        loadAgentKeypair({ walletPath: keypairPath, rpcUrl: "" }),
      ).to.throw("AGENTSHIELD_AGENT_KEYPAIR_PATH is required");
    });
  });

  describe("loadShieldConfig schema validation", () => {
    const origHome = process.env.HOME;
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "schema-test-"));
      const shieldDir = path.join(tmpHome, ".agentshield");
      fs.mkdirSync(shieldDir, { recursive: true });
      process.env.HOME = tmpHome;
      delete process.env.AGENTSHIELD_WALLET_PATH;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("returns null for malformed JSON", () => {
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      fs.writeFileSync(configPath, "{ not valid json !!!");
      expect(loadShieldConfig()).to.be.null;
    });

    it("returns null when required fields are missing", () => {
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      // Valid JSON but missing required structure
      fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));
      expect(loadShieldConfig()).to.be.null;
    });

    it("returns null for wrong version", () => {
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 99,
          layers: {
            shield: {
              enabled: true,
              dailySpendingCapUsd: 500,
              protocolMode: 0,
              protocols: [],
              maxLeverageBps: 0,
              rateLimit: 60,
            },
            tee: { enabled: false, locator: null, publicKey: null },
            vault: {
              enabled: false,
              address: null,
              owner: null,
              vaultId: null,
            },
          },
          wallet: {
            type: "keypair",
            path: null,
            publicKey: "TestPubkey11111111111111111111111111111111",
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );
      expect(loadShieldConfig()).to.be.null;
    });

    it("returns config for valid file", () => {
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          layers: {
            shield: {
              enabled: true,
              dailySpendingCapUsd: 500,
              protocolMode: 0,
              protocols: [],
              maxLeverageBps: 0,
              rateLimit: 60,
            },
            tee: { enabled: false, locator: null, publicKey: null },
            vault: {
              enabled: false,
              address: null,
              owner: null,
              vaultId: null,
            },
          },
          wallet: {
            type: "keypair",
            path: null,
            publicKey: "TestPubkey11111111111111111111111111111111",
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );
      const result = loadShieldConfig();
      expect(result).to.not.be.null;
      expect(result!.version).to.equal(1);
      expect(result!.layers.shield.dailySpendingCapUsd).to.equal(500);
    });
  });

  describe("resolveClient", () => {
    const origHome = process.env.HOME;
    let origWalletPath: string | undefined;
    let origRpcUrl: string | undefined;
    let origCustody: string | undefined;
    let origCrossmintKey: string | undefined;
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-client-"));
      const shieldDir = path.join(tmpHome, ".agentshield");
      fs.mkdirSync(shieldDir, { recursive: true });
      process.env.HOME = tmpHome;

      origWalletPath = process.env.AGENTSHIELD_WALLET_PATH;
      origRpcUrl = process.env.AGENTSHIELD_RPC_URL;
      origCustody = process.env.AGENTSHIELD_CUSTODY;
      origCrossmintKey = process.env.CROSSMINT_API_KEY;

      delete process.env.AGENTSHIELD_WALLET_PATH;
      delete process.env.AGENTSHIELD_RPC_URL;
      delete process.env.AGENTSHIELD_CUSTODY;
      delete process.env.CROSSMINT_API_KEY;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      if (origWalletPath !== undefined)
        process.env.AGENTSHIELD_WALLET_PATH = origWalletPath;
      else delete process.env.AGENTSHIELD_WALLET_PATH;
      if (origRpcUrl !== undefined)
        process.env.AGENTSHIELD_RPC_URL = origRpcUrl;
      else delete process.env.AGENTSHIELD_RPC_URL;
      if (origCustody !== undefined)
        process.env.AGENTSHIELD_CUSTODY = origCustody;
      else delete process.env.AGENTSHIELD_CUSTODY;
      if (origCrossmintKey !== undefined)
        process.env.CROSSMINT_API_KEY = origCrossmintKey;
      else delete process.env.CROSSMINT_API_KEY;

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("returns null when no config available", async () => {
      const result = await resolveClient();
      expect(result).to.be.null;
    });

    it("resolves from config.json with keypair type", async () => {
      // Write a keypair file
      const kp = Keypair.generate();
      const walletDir = path.join(tmpHome, ".agentshield", "wallets");
      fs.mkdirSync(walletDir, { recursive: true });
      const walletFile = path.join(walletDir, "agent.json");
      fs.writeFileSync(walletFile, JSON.stringify(Array.from(kp.secretKey)));

      // Write config.json
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          layers: {
            shield: {
              enabled: true,
              dailySpendingCapUsd: 500,
              protocolMode: 0,
              protocols: [],
              maxLeverageBps: 0,
              rateLimit: 60,
            },
            tee: { enabled: false, locator: null, publicKey: null },
            vault: {
              enabled: false,
              address: null,
              owner: null,
              vaultId: null,
            },
          },
          wallet: {
            type: "keypair",
            path: walletFile,
            publicKey: kp.publicKey.toBase58(),
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );

      const result = await resolveClient();
      expect(result).to.not.be.null;
      expect(result!.client).to.have.property("provider");
      expect(result!.custodyWallet).to.be.null;
      expect(result!.config.walletPath).to.equal(walletFile);
    });

    it("falls back to env vars when no config.json", async () => {
      process.env.AGENTSHIELD_WALLET_PATH = keypairPath;
      const result = await resolveClient();
      expect(result).to.not.be.null;
      expect(result!.custodyWallet).to.be.null;
      expect(result!.config.walletPath).to.equal(keypairPath);
    });

    it("throws clear error when crossmint config but CROSSMINT_API_KEY missing", async () => {
      // Write config.json with crossmint type but no API key
      const configPath = path.join(tmpHome, ".agentshield", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          layers: {
            shield: {
              enabled: true,
              dailySpendingCapUsd: 500,
              protocolMode: 0,
              protocols: [],
              maxLeverageBps: 0,
              rateLimit: 60,
            },
            tee: {
              enabled: true,
              locator: "userId:agent-shield-test",
              publicKey: "TestPubkey11111111111111111111111111111111",
            },
            vault: {
              enabled: false,
              address: null,
              owner: null,
              vaultId: null,
            },
          },
          wallet: {
            type: "crossmint",
            path: null,
            publicKey: "TestPubkey11111111111111111111111111111111",
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );

      try {
        await resolveClient();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("CROSSMINT_API_KEY");
      }
    });
  });
});
