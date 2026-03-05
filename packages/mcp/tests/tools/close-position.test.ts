import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { closePosition } from "../../src/tools/close-position";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";
import type { McpConfig } from "../../src/config";

describe("shield_close_position", () => {
  let tmpDir: string;
  let agentKeypairPath: string;
  let config: McpConfig;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-close-test-"));
    const kp = Keypair.generate();
    agentKeypairPath = path.join(tmpDir, "agent.json");
    fs.writeFileSync(
      agentKeypairPath,
      JSON.stringify(Array.from(kp.secretKey)),
    );
    config = {
      walletPath: agentKeypairPath,
      rpcUrl: "http://localhost:8899",
      agentKeypairPath,
    };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("closes position successfully", async () => {
    const client = createMockClient();
    const result = await closePosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      side: "long",
      priceWithSlippage: "50000000000",
      priceExponent: 0,
    });
    expect(result).to.include("Position Closed");
    expect(result).to.include("LONG");
    expect(result).to.include("mock-sig-flash");
  });

  it("calls flashTradeClose and executeFlashTrade", async () => {
    const client = createMockClient();
    await closePosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      side: "short",
      priceWithSlippage: "50000000000",
      priceExponent: 0,
    });
    expect(client.calls.some((c) => c.method === "flashTradeClose")).to.be.true;
    expect(client.calls.some((c) => c.method === "executeFlashTrade")).to.be
      .true;
  });

  it("returns error without agent keypair", async () => {
    const client = createMockClient();
    const result = await closePosition(
      client as any,
      { walletPath: agentKeypairPath, rpcUrl: "" },
      {
        vault: TEST_VAULT_PDA.toBase58(),
        market: "SOL",
        side: "long",
        priceWithSlippage: "50000000000",
        priceExponent: 0,
      },
    );
    expect(result).to.include("PHALNX_AGENT_KEYPAIR_PATH is required");
  });

  it("returns formatted error on failure", async () => {
    const client = createMockClient({
      shouldThrow: new Error("failed to send transaction: timeout"),
    });
    const result = await closePosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      side: "long",
      priceWithSlippage: "50000000000",
      priceExponent: 0,
    });
    expect(result).to.include("Transaction failed");
  });
});
