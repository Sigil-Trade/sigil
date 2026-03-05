import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { addCollateral } from "../../src/tools/add-collateral";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";
import type { McpConfig } from "../../src/config";

describe("shield_add_collateral", () => {
  let tmpDir: string;
  let agentKeypairPath: string;
  let config: McpConfig;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-addcol-test-"));
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

  it("adds collateral successfully", async () => {
    const client = createMockClient();
    const result = await addCollateral(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      side: "long",
      positionPubKey: Keypair.generate().publicKey.toBase58(),
    });
    expect(result).to.include("Collateral Added");
    expect(result).to.include("mock-sig-flash");
  });

  it("calls flashTradeAddCollateral", async () => {
    const client = createMockClient();
    await addCollateral(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      market: "SOL",
      collateralMint: TEST_MINT.toBase58(),
      collateralAmount: "1000000000",
      side: "long",
      positionPubKey: Keypair.generate().publicKey.toBase58(),
    });
    expect(client.calls.some((c) => c.method === "flashTradeAddCollateral")).to
      .be.true;
  });

  it("returns error without agent keypair", async () => {
    const client = createMockClient();
    const result = await addCollateral(
      client as any,
      { walletPath: agentKeypairPath, rpcUrl: "" },
      {
        vault: TEST_VAULT_PDA.toBase58(),
        market: "SOL",
        collateralMint: TEST_MINT.toBase58(),
        collateralAmount: "1000000000",
        side: "long",
        positionPubKey: Keypair.generate().publicKey.toBase58(),
      },
    );
    expect(result).to.include("PHALNX_AGENT_KEYPAIR_PATH is required");
  });
});
