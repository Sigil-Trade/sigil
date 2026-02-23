import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fundWallet } from "../../src/tools/fund-wallet";

describe("shield_fund_wallet", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-fund-"));
  });

  beforeEach(() => {
    const shieldDir = path.join(tmpHome, ".agentshield");
    if (!fs.existsSync(shieldDir)) {
      fs.mkdirSync(shieldDir, { recursive: true });
    }
    process.env.HOME = tmpHome;
    delete process.env.AGENTSHIELD_WALLET_PATH;
    delete process.env.AGENTSHIELD_RPC_URL;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    const configPath = path.join(tmpHome, ".agentshield", "config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(overrides: Record<string, any> = {}) {
    const config = {
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
      ...overrides,
    };
    fs.writeFileSync(
      path.join(tmpHome, ".agentshield", "config.json"),
      JSON.stringify(config),
    );
  }

  it("returns not-configured message when no config", async () => {
    const result = await fundWallet(null, {});
    expect(result).to.include("not configured");
  });

  it("generates Blink URL for SOL funding", async () => {
    writeConfig();
    const result = await fundWallet(null, { amount: "1.5" });
    expect(result).to.include("Fund Your AgentShield Wallet");
    expect(result).to.include("11111111111111111111111111111111");
    expect(result).to.include("dial.to");
    expect(result).to.include("SOL");
  });

  it("generates Solana Pay URL", async () => {
    writeConfig();
    const result = await fundWallet(null, { amount: "1.5" });
    expect(result).to.include("solana:");
    expect(result).to.include("Solana Pay");
  });

  it("includes mint in URLs for token funding", async () => {
    writeConfig();
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const result = await fundWallet(null, { mint: usdcMint, amount: "100" });
    expect(result).to.include(usdcMint);
    expect(result).to.include("tokens");
  });

  it("shows raw address for direct send", async () => {
    writeConfig();
    const result = await fundWallet(null, {});
    expect(result).to.include("Send Directly");
    expect(result).to.include("11111111111111111111111111111111");
  });
});
