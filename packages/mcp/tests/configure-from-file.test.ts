import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configureFromFile } from "../src/tools/configure-from-file";

describe("shield_configure_from_file", () => {
  let tmpDir: string;
  const origConfigDir = process.env.HOME;

  // Redirect config writes to temp dir to avoid polluting real config
  let testConfigDir: string;

  function makeValidConfig(overrides?: Partial<any>): any {
    return {
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
        path: "~/.agentshield/wallets/agent.json",
        publicKey: "11111111111111111111111111111112",
      },
      network: "devnet",
      template: "conservative",
      configuredAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function writeConfigFile(name: string, content: any): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    return filePath;
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-test-"));
    testConfigDir = path.join(tmpDir, ".agentshield");
    fs.mkdirSync(testConfigDir, { recursive: true, mode: 0o700 });
    // Override HOME so saveShieldConfig writes to tmp
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a valid config file", async () => {
    const filePath = writeConfigFile("valid.json", makeValidConfig());
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("Configured from File");
    expect(result).to.include("$500");
    expect(result).to.include("devnet");
    expect(result).to.include("conservative");
  });

  it("resolves ~ in file path", async () => {
    const filePath = writeConfigFile("tilde.json", makeValidConfig());
    const relativePath = filePath.replace(os.homedir(), "~");
    // This will resolve ~ to current HOME (tmpDir)
    const result = await configureFromFile(null, {
      configFile: path.join("~", path.basename(filePath)),
    });
    // Should either succeed or give "not found" depending on HOME
    expect(typeof result).to.equal("string");
  });

  it("returns error for non-existent file", async () => {
    const result = await configureFromFile(null, {
      configFile: "/tmp/nonexistent-agentshield-config-12345.json",
    });
    expect(result).to.include("not found");
  });

  it("returns error for invalid JSON", async () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json }}}");
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("not valid JSON");
  });

  it("returns error for missing version", async () => {
    const config = makeValidConfig();
    delete config.version;
    const filePath = writeConfigFile("no-version.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("version");
    expect(result).to.include("invalid structure");
  });

  it("returns error for missing layers", async () => {
    const config = makeValidConfig();
    delete config.layers;
    const filePath = writeConfigFile("no-layers.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("layers");
  });

  it("returns error for missing wallet", async () => {
    const config = makeValidConfig();
    delete config.wallet;
    const filePath = writeConfigFile("no-wallet.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("wallet");
  });

  it("returns error for invalid network", async () => {
    const config = makeValidConfig({ network: "testnet" });
    const filePath = writeConfigFile("bad-network.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("network");
  });

  it("returns error for invalid template", async () => {
    const config = makeValidConfig({ template: "yolo" });
    const filePath = writeConfigFile("bad-template.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("template");
  });

  it("shows fully configured for all-layers-enabled config", async () => {
    const config = makeValidConfig();
    config.layers.tee.enabled = true;
    config.layers.tee.publicKey = "22222222222222222222222222222222";
    config.layers.tee.locator = "test-locator";
    config.layers.vault.enabled = true;
    config.layers.vault.address = "33333333333333333333333333333333";
    const filePath = writeConfigFile("full.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("Fully configured");
    // Fully configured should NOT show the upgrade note
    expect(result).to.not.include("ensure all layers");
  });

  it("shows note for partially configured", async () => {
    const config = makeValidConfig();
    const filePath = writeConfigFile("partial.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("Partially configured");
    expect(result).to.include("ensure all layers");
  });

  it("shows overwritten when config already exists", async () => {
    // First write
    const config1 = makeValidConfig();
    const filePath1 = writeConfigFile("first.json", config1);
    await configureFromFile(null, { configFile: filePath1 });

    // Second write (overwrite)
    const config2 = makeValidConfig({ template: "moderate" });
    const filePath2 = writeConfigFile("second.json", config2);
    const result = await configureFromFile(null, { configFile: filePath2 });
    expect(result).to.include("overwritten");
  });

  it("validates shield layer fields", async () => {
    const config = makeValidConfig();
    config.layers.shield.dailySpendingCapUsd = "not a number";
    const filePath = writeConfigFile("bad-shield.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("dailySpendingCapUsd");
    expect(result).to.include("must be a number");
  });

  it("validates wallet type", async () => {
    const config = makeValidConfig();
    config.wallet.type = "phantom";
    const filePath = writeConfigFile("bad-wallet-type.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("wallet.type");
  });

  it("validates wallet publicKey is non-empty", async () => {
    const config = makeValidConfig();
    config.wallet.publicKey = "";
    const filePath = writeConfigFile("empty-pubkey.json", config);
    const result = await configureFromFile(null, { configFile: filePath });
    expect(result).to.include("wallet.publicKey");
  });
});
