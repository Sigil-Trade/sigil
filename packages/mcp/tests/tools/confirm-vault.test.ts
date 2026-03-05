import { expect } from "chai";
import * as sinon from "sinon";
import { PublicKey, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { confirmVault } from "../../src/tools/confirm-vault";

function writeConfig(tmpHome: string, overrides: Record<string, any> = {}) {
  const shieldDir = path.join(tmpHome, ".phalnx");
  if (!fs.existsSync(shieldDir)) {
    fs.mkdirSync(shieldDir, { recursive: true });
  }
  const walletPubkey = PublicKey.unique().toBase58();
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
      tee: { enabled: true, locator: "test-locator", publicKey: walletPubkey },
      vault: { enabled: true, address: null, owner: null, vaultId: null },
    },
    wallet: {
      type: "crossmint",
      path: null,
      publicKey: walletPubkey,
    },
    network: "devnet",
    template: "conservative",
    configuredAt: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(
    path.join(shieldDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  return { walletPubkey, configPath: path.join(shieldDir, "config.json") };
}

describe("shield_confirm_vault", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-confirm-"));
  });

  beforeEach(() => {
    process.env.HOME = tmpHome;
    delete process.env.PHALNX_RPC_URL;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    sinon.restore();
    const configPath = path.join(tmpHome, ".phalnx", "config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns error when not configured", async () => {
    const result = await confirmVault(null, {});
    expect(result).to.include("not configured");
  });

  it("returns error for invalid owner pubkey", async () => {
    writeConfig(tmpHome);
    const result = await confirmVault(null, { owner: "not-a-key" });
    expect(result).to.include("Invalid owner public key");
  });

  it("reports vault not found when PDA does not exist", async () => {
    const { walletPubkey } = writeConfig(tmpHome);
    sinon.stub(Connection.prototype, "getAccountInfo").resolves(null);

    const result = await confirmVault(null, {
      owner: walletPubkey,
      vaultId: 0,
    });
    expect(result).to.include("Vault Not Found");
    expect(result).to.include("hasn't been confirmed yet");
  });

  it("confirms vault and updates config", async () => {
    const { walletPubkey, configPath } = writeConfig(tmpHome);
    sinon.stub(Connection.prototype, "getAccountInfo").resolves({
      data: Buffer.alloc(519),
      executable: false,
      lamports: 1000000,
      owner: new PublicKey("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"),
      rentEpoch: 0,
    });

    const result = await confirmVault(null, {
      owner: walletPubkey,
      vaultId: 0,
    });
    expect(result).to.include("Vault Confirmed");
    expect(result).to.include("saved to config");

    // Verify config was updated
    const updatedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(updatedConfig.layers.vault.address).to.be.a("string");
    expect(updatedConfig.layers.vault.address).to.have.length.greaterThan(30);
    expect(updatedConfig.layers.vault.owner).to.equal(walletPubkey);
    expect(updatedConfig.layers.vault.vaultId).to.equal("0");
    expect(updatedConfig.layers.vault.enabled).to.be.true;
  });

  it("uses configured wallet pubkey when no owner specified", async () => {
    const { configPath } = writeConfig(tmpHome);
    sinon.stub(Connection.prototype, "getAccountInfo").resolves({
      data: Buffer.alloc(519),
      executable: false,
      lamports: 1000000,
      owner: new PublicKey("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"),
      rentEpoch: 0,
    });

    const result = await confirmVault(null, { vaultId: 0 });
    expect(result).to.include("Vault Confirmed");

    const updatedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(updatedConfig.layers.vault.address).to.not.be.null;
  });

  it("defaults vaultId to 0", async () => {
    const { walletPubkey } = writeConfig(tmpHome);
    sinon.stub(Connection.prototype, "getAccountInfo").resolves({
      data: Buffer.alloc(519),
      executable: false,
      lamports: 1000000,
      owner: new PublicKey("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"),
      rentEpoch: 0,
    });

    const result = await confirmVault(null, { owner: walletPubkey });
    expect(result).to.include("Vault Confirmed");
    expect(result).to.include("Vault ID:** 0");
  });

  it("handles RPC error gracefully", async () => {
    writeConfig(tmpHome);
    sinon
      .stub(Connection.prototype, "getAccountInfo")
      .rejects(new Error("RPC down"));

    const result = await confirmVault(null, { vaultId: 0 });
    expect(result).to.include("Error confirming vault");
    expect(result).to.include("RPC down");
  });
});
