import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { executeSwap } from "../../src/tools/execute-swap";
import {
  createMockClient,
  TEST_VAULT_PDA,
  TEST_MINT,
} from "../helpers/mock-client";
import type { McpConfig } from "../../src/config";

describe("shield_execute_swap", () => {
  let tmpDir: string;
  let agentKeypairPath: string;
  let agentKeypair: Keypair;
  let config: McpConfig;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-swap-test-"));
    agentKeypair = Keypair.generate();
    agentKeypairPath = path.join(tmpDir, "agent.json");
    fs.writeFileSync(
      agentKeypairPath,
      JSON.stringify(Array.from(agentKeypair.secretKey)),
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

  const outputMint = Keypair.generate().publicKey.toBase58();

  it("executes swap successfully", async () => {
    const client = createMockClient();
    const result = await executeSwap(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      inputMint: TEST_MINT.toBase58(),
      outputMint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(result).to.include("Swap Executed");
    expect(result).to.include("mock-sig-swap");
  });

  it("calls fetchVaultByAddress and executeJupiterSwap", async () => {
    const client = createMockClient();
    await executeSwap(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      inputMint: TEST_MINT.toBase58(),
      outputMint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(client.calls.some((c) => c.method === "fetchVaultByAddress")).to.be
      .true;
    expect(client.calls.some((c) => c.method === "executeJupiterSwap")).to.be
      .true;
  });

  it("returns error without agent keypair", async () => {
    const client = createMockClient();
    const noAgentConfig = {
      walletPath: agentKeypairPath,
      rpcUrl: "http://localhost:8899",
    };
    const result = await executeSwap(client as any, noAgentConfig, {
      vault: TEST_VAULT_PDA.toBase58(),
      inputMint: TEST_MINT.toBase58(),
      outputMint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(result).to.include("AGENTSHIELD_AGENT_KEYPAIR_PATH is required");
  });

  it("executes swap with custody wallet (no keypair loading)", async () => {
    const client = createMockClient();
    const custodyPubkey = Keypair.generate().publicKey;
    const mockCustodyWallet = {
      publicKey: custodyPubkey,
      signTransaction: async <T>(tx: T): Promise<T> => tx,
    };
    const noAgentConfig = {
      walletPath: agentKeypairPath,
      rpcUrl: "http://localhost:8899",
      // No agentKeypairPath — custody wallet replaces it
    };
    const result = await executeSwap(
      client as any,
      noAgentConfig,
      {
        vault: TEST_VAULT_PDA.toBase58(),
        inputMint: TEST_MINT.toBase58(),
        outputMint,
        amount: "1000000",
        slippageBps: 50,
      },
      mockCustodyWallet,
    );
    expect(result).to.include("Swap Executed");
    // Verify the swap used custody wallet's pubkey
    const swapCall = client.calls.find(
      (c) => c.method === "executeJupiterSwap",
    );
    expect(swapCall).to.exist;
    expect(swapCall!.args[0].agent.toBase58()).to.equal(
      custodyPubkey.toBase58(),
    );
    // Verify no signers passed (custody wallet signs via provider)
    expect(swapCall!.args[1]).to.deep.equal([]);
  });

  it("returns error on swap failure", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6003 }),
    });
    const result = await executeSwap(client as any, config, {
      vault: TEST_VAULT_PDA.toBase58(),
      inputMint: TEST_MINT.toBase58(),
      outputMint,
      amount: "1000000",
      slippageBps: 50,
    });
    expect(result).to.include("TokenNotRegistered");
  });
});
