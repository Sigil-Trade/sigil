import { expect } from "chai";
import * as sinon from "sinon";
import { PublicKey, Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { discoverVault } from "../../src/tools/discover-vault";

describe("shield_discover_vault", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  let connectionStub: sinon.SinonStub;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-discover-"));
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

  it("returns error for invalid owner pubkey", async () => {
    const result = await discoverVault(null, { owner: "not-a-key" });
    expect(result).to.include("Invalid owner public key");
  });

  it("reports not found for single vault ID check", async () => {
    // Stub Connection.getAccountInfo to return null
    connectionStub = sinon
      .stub(Connection.prototype, "getAccountInfo")
      .resolves(null);

    const owner = PublicKey.unique().toBase58();
    const result = await discoverVault(null, { owner, vaultId: 0 });
    expect(result).to.include("No vault found");
    expect(result).to.include("Derived PDA");
    expect(connectionStub.calledOnce).to.be.true;
  });

  it("reports found for single vault ID check", async () => {
    connectionStub = sinon
      .stub(Connection.prototype, "getAccountInfo")
      .resolves({
        data: Buffer.alloc(519),
        executable: false,
        lamports: 1000000,
        owner: new PublicKey("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"),
        rentEpoch: 0,
      });

    const owner = PublicKey.unique().toBase58();
    const result = await discoverVault(null, { owner, vaultId: 0 });
    expect(result).to.include("Vault Found");
    expect(result).to.include("519 bytes");
  });

  it("scans range and finds no vaults", async () => {
    connectionStub = sinon
      .stub(Connection.prototype, "getMultipleAccountsInfo")
      .resolves(new Array(10).fill(null));

    const owner = PublicKey.unique().toBase58();
    const result = await discoverVault(null, { owner, scanRange: 10 });
    expect(result).to.include("No vaults found");
    expect(result).to.include("scanned IDs 0–9");
  });

  it("scans range and finds vaults", async () => {
    const accountInfo = {
      data: Buffer.alloc(519),
      executable: false,
      lamports: 1000000,
      owner: new PublicKey("4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"),
      rentEpoch: 0,
    };
    // Vault ID 0 exists, rest don't
    const results = new Array(5).fill(null);
    results[0] = accountInfo;
    results[3] = accountInfo;

    connectionStub = sinon
      .stub(Connection.prototype, "getMultipleAccountsInfo")
      .resolves(results);

    const owner = PublicKey.unique().toBase58();
    const result = await discoverVault(null, { owner, scanRange: 5 });
    expect(result).to.include("Vaults Found");
    expect(result).to.include("2");
    expect(result).to.include("Vault ID 0");
    expect(result).to.include("Vault ID 3");
  });

  it("caps scanRange at 256", async () => {
    connectionStub = sinon
      .stub(Connection.prototype, "getMultipleAccountsInfo")
      .resolves([]);

    const owner = PublicKey.unique().toBase58();
    // Even though we pass 1000, it should cap at 256
    await discoverVault(null, { owner, scanRange: 1000 });
    // The stub should be called with an array of at most 100 keys per batch
    // 256 keys / 100 per batch = 3 batches
    expect(connectionStub.callCount).to.equal(3);
  });

  it("handles RPC error gracefully", async () => {
    connectionStub = sinon
      .stub(Connection.prototype, "getAccountInfo")
      .rejects(new Error("RPC unavailable"));

    const owner = PublicKey.unique().toBase58();
    const result = await discoverVault(null, { owner, vaultId: 0 });
    expect(result).to.include("Error discovering vaults");
    expect(result).to.include("RPC unavailable");
  });

  it("uses configured RPC when config exists", async () => {
    const shieldDir = path.join(tmpHome, ".phalnx");
    if (!fs.existsSync(shieldDir)) {
      fs.mkdirSync(shieldDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(shieldDir, "config.json"),
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
          vault: { enabled: false, address: null, owner: null, vaultId: null },
        },
        wallet: {
          type: "keypair",
          path: null,
          publicKey: PublicKey.unique().toBase58(),
        },
        network: "devnet",
        template: "conservative",
        configuredAt: new Date().toISOString(),
      }),
    );

    connectionStub = sinon
      .stub(Connection.prototype, "getAccountInfo")
      .resolves(null);

    const owner = PublicKey.unique().toBase58();
    await discoverVault(null, { owner, vaultId: 0 });
    expect(connectionStub.calledOnce).to.be.true;
  });
});
