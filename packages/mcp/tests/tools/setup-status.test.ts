import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { setupStatus } from "../../src/tools/setup-status";

describe("shield_setup_status", () => {
  const origHome = process.env.HOME;

  // Override HOME so getConfigPath() resolves to our temp dir
  let tmpHome: string;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-test-"));
  });

  beforeEach(() => {
    // Create temp home dir structure
    const shieldDir = path.join(tmpHome, ".agentshield");
    if (!fs.existsSync(shieldDir)) {
      fs.mkdirSync(shieldDir, { recursive: true });
    }
    process.env.HOME = tmpHome;
    // Remove env vars that could interfere
    delete process.env.AGENTSHIELD_WALLET_PATH;
    delete process.env.AGENTSHIELD_RPC_URL;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    const shieldConfig = path.join(tmpHome, ".agentshield", "config.json");
    if (fs.existsSync(shieldConfig)) {
      fs.unlinkSync(shieldConfig);
    }
  });

  after(() => {
    // Clean up temp dirs
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns not-configured message when no config exists", async () => {
    const result = await setupStatus(null, {});
    expect(result).to.include("Not configured");
    expect(result).to.include("Set up AgentShield");
  });

  it("reports partially configured when only shield is enabled", async () => {
    const config = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailyCapUsd: 500,
          allowedProtocols: [],
          maxLeverageBps: 0,
          rateLimit: 60,
        },
        tee: { enabled: false, locator: null, publicKey: null },
        vault: { enabled: false, address: null, owner: null, vaultId: null },
      },
      wallet: {
        type: "keypair",
        path: "~/.agentshield/wallets/agent.json",
        publicKey: "11111111111111111111111111111111",
      },
      network: "devnet",
      template: "conservative",
      configuredAt: "2026-01-01T00:00:00Z",
    };
    fs.writeFileSync(
      path.join(tmpHome, ".agentshield", "config.json"),
      JSON.stringify(config),
    );

    const result = await setupStatus(null, {});
    expect(result).to.include("Partially configured");
    expect(result).to.include("Policy Configuration");
    expect(result).to.include("$500");
    expect(result).to.include("devnet");
  });

  it("reports TEE custody details when TEE is enabled", async () => {
    const config = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailyCapUsd: 2000,
          allowedProtocols: [],
          maxLeverageBps: 20000,
          rateLimit: 120,
        },
        tee: {
          enabled: true,
          locator: "test-locator",
          publicKey: "22222222222222222222222222222222",
        },
        vault: { enabled: false, address: null, owner: null, vaultId: null },
      },
      wallet: {
        type: "crossmint",
        path: null,
        publicKey: "22222222222222222222222222222222",
      },
      network: "devnet",
      template: "moderate",
      configuredAt: "2026-01-01T00:00:00Z",
    };
    fs.writeFileSync(
      path.join(tmpHome, ".agentshield", "config.json"),
      JSON.stringify(config),
    );

    const result = await setupStatus(null, {});
    expect(result).to.include("TEE Custody");
    expect(result).to.include("test-locator");
  });

  it("reports fully configured when all layers enabled", async () => {
    const config = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailyCapUsd: 10000,
          allowedProtocols: [],
          maxLeverageBps: 50000,
          rateLimit: 300,
        },
        tee: {
          enabled: true,
          locator: "tee-loc",
          publicKey: "33333333333333333333333333333333",
        },
        vault: {
          enabled: true,
          address: "vault-address-123",
          owner: "owner-123",
          vaultId: "1",
        },
      },
      wallet: {
        type: "crossmint",
        path: null,
        publicKey: "33333333333333333333333333333333",
      },
      network: "mainnet-beta",
      template: "aggressive",
      configuredAt: "2026-01-01T00:00:00Z",
    };
    fs.writeFileSync(
      path.join(tmpHome, ".agentshield", "config.json"),
      JSON.stringify(config),
    );

    const result = await setupStatus(null, {});
    expect(result).to.include("Fully configured");
    expect(result).to.include("On-Chain Vault");
    expect(result).to.include("vault-address-123");
    expect(result).to.include("mainnet-beta");
  });

  it("suggests running shield_configure when not fully configured", async () => {
    const config = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailyCapUsd: 500,
          allowedProtocols: [],
          maxLeverageBps: 0,
          rateLimit: 60,
        },
        tee: { enabled: false, locator: null, publicKey: null },
        vault: { enabled: false, address: null, owner: null, vaultId: null },
      },
      wallet: {
        type: "keypair",
        path: "~/.agentshield/wallets/agent.json",
        publicKey: "11111111111111111111111111111111",
      },
      network: "devnet",
      template: "conservative",
      configuredAt: "2026-01-01T00:00:00Z",
    };
    fs.writeFileSync(
      path.join(tmpHome, ".agentshield", "config.json"),
      JSON.stringify(config),
    );

    const result = await setupStatus(null, {});
    expect(result).to.include("Setup Incomplete");
    expect(result).to.include("shield_configure");
  });
});
