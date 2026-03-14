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
  createCustodyWallet,
  type McpConfig,
} from "../src/config";

describe("MCP mode defaults", () => {
  it("default mode resolves to 'v2' when PHALNX_MCP_MODE is unset", () => {
    const origMode = process.env.PHALNX_MCP_MODE;
    delete process.env.PHALNX_MCP_MODE;
    try {
      const mcpMode = process.env.PHALNX_MCP_MODE ?? "v2";
      expect(mcpMode).to.equal("v2");
    } finally {
      if (origMode !== undefined) process.env.PHALNX_MCP_MODE = origMode;
      else delete process.env.PHALNX_MCP_MODE;
    }
  });
});

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
    let originalCustody: string | undefined;

    beforeEach(() => {
      originalWalletPath = process.env.PHALNX_WALLET_PATH;
      originalRpcUrl = process.env.PHALNX_RPC_URL;
      originalAgentPath = process.env.PHALNX_AGENT_KEYPAIR_PATH;
      originalCustody = process.env.PHALNX_CUSTODY;
      // Clear custody so tests exercise the keypair path
      delete process.env.PHALNX_CUSTODY;
    });

    afterEach(() => {
      if (originalWalletPath !== undefined)
        process.env.PHALNX_WALLET_PATH = originalWalletPath;
      else delete process.env.PHALNX_WALLET_PATH;

      if (originalRpcUrl !== undefined)
        process.env.PHALNX_RPC_URL = originalRpcUrl;
      else delete process.env.PHALNX_RPC_URL;

      if (originalAgentPath !== undefined)
        process.env.PHALNX_AGENT_KEYPAIR_PATH = originalAgentPath;
      else delete process.env.PHALNX_AGENT_KEYPAIR_PATH;

      if (originalCustody !== undefined)
        process.env.PHALNX_CUSTODY = originalCustody;
      else delete process.env.PHALNX_CUSTODY;
    });

    it("throws when PHALNX_WALLET_PATH is not set", () => {
      delete process.env.PHALNX_WALLET_PATH;
      expect(() => loadConfig()).to.throw("PHALNX_WALLET_PATH is required");
    });

    it("loads config with required env vars", () => {
      process.env.PHALNX_WALLET_PATH = keypairPath;
      delete process.env.PHALNX_RPC_URL;
      const config = loadConfig();
      expect(config.walletPath).to.equal(keypairPath);
      expect(config.rpcUrl).to.include("devnet");
    });

    it("uses custom RPC URL when provided", () => {
      process.env.PHALNX_WALLET_PATH = keypairPath;
      process.env.PHALNX_RPC_URL = "http://localhost:8899";
      const config = loadConfig();
      expect(config.rpcUrl).to.equal("http://localhost:8899");
    });

    it("loads agent keypair path when provided", () => {
      process.env.PHALNX_WALLET_PATH = keypairPath;
      process.env.PHALNX_AGENT_KEYPAIR_PATH = keypairPath;
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
      ).to.throw("PHALNX_AGENT_KEYPAIR_PATH is required");
    });
  });

  describe("loadShieldConfig schema validation", () => {
    const origHome = process.env.HOME;
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "schema-test-"));
      const shieldDir = path.join(tmpHome, ".phalnx");
      fs.mkdirSync(shieldDir, { recursive: true });
      process.env.HOME = tmpHome;
      delete process.env.PHALNX_WALLET_PATH;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("returns null for malformed JSON", () => {
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
      fs.writeFileSync(configPath, "{ not valid json !!!");
      expect(loadShieldConfig()).to.be.null;
    });

    it("returns null when required fields are missing", () => {
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
      // Valid JSON but missing required structure
      fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));
      expect(loadShieldConfig()).to.be.null;
    });

    it("returns null for wrong version", () => {
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
      const shieldDir = path.join(tmpHome, ".phalnx");
      fs.mkdirSync(shieldDir, { recursive: true });
      process.env.HOME = tmpHome;

      origWalletPath = process.env.PHALNX_WALLET_PATH;
      origRpcUrl = process.env.PHALNX_RPC_URL;
      origCustody = process.env.PHALNX_CUSTODY;
      origCrossmintKey = process.env.CROSSMINT_API_KEY;

      delete process.env.PHALNX_WALLET_PATH;
      delete process.env.PHALNX_RPC_URL;
      delete process.env.PHALNX_CUSTODY;
      delete process.env.CROSSMINT_API_KEY;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      if (origWalletPath !== undefined)
        process.env.PHALNX_WALLET_PATH = origWalletPath;
      else delete process.env.PHALNX_WALLET_PATH;
      if (origRpcUrl !== undefined) process.env.PHALNX_RPC_URL = origRpcUrl;
      else delete process.env.PHALNX_RPC_URL;
      if (origCustody !== undefined) process.env.PHALNX_CUSTODY = origCustody;
      else delete process.env.PHALNX_CUSTODY;
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
      const walletDir = path.join(tmpHome, ".phalnx", "wallets");
      fs.mkdirSync(walletDir, { recursive: true });
      const walletFile = path.join(walletDir, "agent.json");
      fs.writeFileSync(walletFile, JSON.stringify(Array.from(kp.secretKey)));

      // Write config.json
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
      process.env.PHALNX_WALLET_PATH = keypairPath;
      const result = await resolveClient();
      expect(result).to.not.be.null;
      expect(result!.custodyWallet).to.be.null;
      expect(result!.config.walletPath).to.equal(keypairPath);
    });

    it("throws clear error when crossmint config but CROSSMINT_API_KEY missing", async () => {
      // Write config.json with crossmint type but no API key
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
              locator: "userId:phalnx-test",
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

    it("throws clear error when privy config but env vars missing", async () => {
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
              locator: "wlt_privy_123",
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
            type: "privy",
            path: null,
            publicKey: "TestPubkey11111111111111111111111111111111",
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );

      delete process.env.PRIVY_APP_ID;
      delete process.env.PRIVY_APP_SECRET;

      try {
        await resolveClient();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("PRIVY_APP_ID");
      }
    });

    it("throws clear error when turnkey config but env vars missing", async () => {
      const configPath = path.join(tmpHome, ".phalnx", "config.json");
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
              locator: "wlt_turnkey_123",
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
            type: "turnkey",
            path: null,
            publicKey: "TestPubkey11111111111111111111111111111111",
          },
          network: "devnet",
          template: "conservative",
          configuredAt: new Date().toISOString(),
        }),
      );

      delete process.env.TURNKEY_ORGANIZATION_ID;
      delete process.env.TURNKEY_API_KEY_ID;
      delete process.env.TURNKEY_API_PRIVATE_KEY;

      try {
        await resolveClient();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("TURNKEY_ORGANIZATION_ID");
      }
    });
  });

  describe("createCustodyWallet", () => {
    it("throws for privy when credentials missing", async () => {
      const config: McpConfig = {
        rpcUrl: "https://mock.rpc",
        custodyProvider: "privy",
      };
      try {
        await createCustodyWallet(config);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("PRIVY_APP_ID");
      }
    });

    it("throws for turnkey when credentials missing", async () => {
      const config: McpConfig = {
        rpcUrl: "https://mock.rpc",
        custodyProvider: "turnkey",
      };
      try {
        await createCustodyWallet(config);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("TURNKEY_ORGANIZATION_ID");
      }
    });

    it("throws for crossmint when API key missing", async () => {
      const config: McpConfig = {
        rpcUrl: "https://mock.rpc",
        custodyProvider: "crossmint",
      };
      try {
        await createCustodyWallet(config);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("CROSSMINT_API_KEY");
      }
    });

    it("throws for unknown provider", async () => {
      const config: McpConfig = {
        rpcUrl: "https://mock.rpc",
        custodyProvider: "unknown" as any,
      };
      try {
        await createCustodyWallet(config);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Unknown custody provider");
      }
    });
  });

  describe("loadConfig with custody provider", () => {
    let origCustody: string | undefined;
    let origWalletPath: string | undefined;
    let origPrivyId: string | undefined;
    let origPrivySecret: string | undefined;
    let origTurnkeyOrg: string | undefined;
    let origTurnkeyKey: string | undefined;
    let origTurnkeyPk: string | undefined;

    beforeEach(() => {
      origCustody = process.env.PHALNX_CUSTODY;
      origWalletPath = process.env.PHALNX_WALLET_PATH;
      origPrivyId = process.env.PRIVY_APP_ID;
      origPrivySecret = process.env.PRIVY_APP_SECRET;
      origTurnkeyOrg = process.env.TURNKEY_ORGANIZATION_ID;
      origTurnkeyKey = process.env.TURNKEY_API_KEY_ID;
      origTurnkeyPk = process.env.TURNKEY_API_PRIVATE_KEY;
    });

    afterEach(() => {
      const envPairs: [string, string | undefined][] = [
        ["PHALNX_CUSTODY", origCustody],
        ["PHALNX_WALLET_PATH", origWalletPath],
        ["PRIVY_APP_ID", origPrivyId],
        ["PRIVY_APP_SECRET", origPrivySecret],
        ["TURNKEY_ORGANIZATION_ID", origTurnkeyOrg],
        ["TURNKEY_API_KEY_ID", origTurnkeyKey],
        ["TURNKEY_API_PRIVATE_KEY", origTurnkeyPk],
      ];
      for (const [key, val] of envPairs) {
        if (val !== undefined) process.env[key] = val;
        else delete process.env[key];
      }
    });

    it("parses privy env vars when PHALNX_CUSTODY=privy", () => {
      process.env.PHALNX_CUSTODY = "privy";
      process.env.PRIVY_APP_ID = "clx_test";
      process.env.PRIVY_APP_SECRET = "sk_privy_test";
      delete process.env.PHALNX_WALLET_PATH;

      const config = loadConfig();
      expect(config.custodyProvider).to.equal("privy");
      expect(config.privyAppId).to.equal("clx_test");
      expect(config.privyAppSecret).to.equal("sk_privy_test");
    });

    it("parses turnkey env vars when PHALNX_CUSTODY=turnkey", () => {
      process.env.PHALNX_CUSTODY = "turnkey";
      process.env.TURNKEY_ORGANIZATION_ID = "org123";
      process.env.TURNKEY_API_KEY_ID = "key123";
      process.env.TURNKEY_API_PRIVATE_KEY = "pk_test";
      delete process.env.PHALNX_WALLET_PATH;

      const config = loadConfig();
      expect(config.custodyProvider).to.equal("turnkey");
      expect(config.turnkeyOrganizationId).to.equal("org123");
      expect(config.turnkeyApiKeyId).to.equal("key123");
      expect(config.turnkeyApiPrivateKey).to.equal("pk_test");
    });

    it("does not require wallet path when custody provider set", () => {
      process.env.PHALNX_CUSTODY = "crossmint";
      process.env.CROSSMINT_API_KEY = "sk_crossmint";
      delete process.env.PHALNX_WALLET_PATH;

      const config = loadConfig();
      expect(config.walletPath).to.be.undefined;
      expect(config.custodyProvider).to.equal("crossmint");
    });
  });
});
