import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, loadKeypair, loadAgentKeypair } from "../src/config";

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
      expect(() => loadConfig()).to.throw("AGENTSHIELD_WALLET_PATH is required");
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
  });

  describe("loadAgentKeypair", () => {
    it("throws when agentKeypairPath is not set", () => {
      expect(() =>
        loadAgentKeypair({ walletPath: keypairPath, rpcUrl: "" })
      ).to.throw("AGENTSHIELD_AGENT_KEYPAIR_PATH is required");
    });
  });
});
