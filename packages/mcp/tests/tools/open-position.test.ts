import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { openPosition } from "../../src/tools/open-position";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";
import type { McpConfig } from "../../src/config";

describe("shield_open_position", () => {
  let tmpDir: string;
  let agentKeypairPath: string;
  let config: McpConfig;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-pos-test-"));
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

  it("opens position successfully", async () => {
    const client = createMockClient();
    const result = await openPosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      sizeUsd: "10000000000",
      side: "long",
      leverageBps: 20000,
    });
    expect(result).to.include("Position Opened");
    expect(result).to.include("LONG");
    expect(result).to.include("mock-sig-flash");
  });

  it("calls flashTradeOpen and executeFlashTrade", async () => {
    const client = createMockClient();
    await openPosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      sizeUsd: "10000000000",
      side: "long",
      leverageBps: 20000,
    });
    expect(client.calls.some((c) => c.method === "flashTradeOpen")).to.be.true;
    expect(client.calls.some((c) => c.method === "executeFlashTrade")).to.be
      .true;
  });

  it("returns error without agent keypair", async () => {
    const client = createMockClient();
    const result = await openPosition(
      client as any,
      { walletPath: agentKeypairPath, rpcUrl: "" },
      {
        vault: TEST_VAULT_PDA.toBase58(),
        market: "SOL",
        collateralMint: TEST_MINT.toBase58(),
        collateralAmount: "1000000000",
        sizeUsd: "10000000000",
        side: "long",
        leverageBps: 20000,
      },
    );
    expect(result).to.include("PHALNX_AGENT_KEYPAIR_PATH is required");
  });

  it("returns error on leverage violation", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6007 }),
    });
    const result = await openPosition(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      sizeUsd: "10000000000",
      side: "long",
      leverageBps: 200000,
    });
    expect(result).to.include("LeverageTooHigh");
  });

  it("returns error for malformed vault address", async () => {
    const client = createMockClient();
    const result = await openPosition(client as any, config, {
      vault: "not-valid-base58!!!",
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      sizeUsd: "10000000000",
      side: "long",
      leverageBps: 20000,
    });
    expect(result).to.include("Invalid public key");
  });
});
