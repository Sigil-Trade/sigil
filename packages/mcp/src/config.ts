import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { AgentShieldClient } from "@agent-shield/sdk";
import * as fs from "fs";

export interface McpConfig {
  walletPath: string;
  rpcUrl: string;
  agentKeypairPath?: string;
}

export function loadConfig(): McpConfig {
  const walletPath = process.env.AGENTSHIELD_WALLET_PATH;
  if (!walletPath) {
    throw new Error(
      "AGENTSHIELD_WALLET_PATH is required. " +
        "Set it to the path of your Solana keypair JSON file."
    );
  }

  const rpcUrl =
    process.env.AGENTSHIELD_RPC_URL || clusterApiUrl("devnet");

  const agentKeypairPath =
    process.env.AGENTSHIELD_AGENT_KEYPAIR_PATH || undefined;

  return { walletPath, rpcUrl, agentKeypairPath };
}

export function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~")
    ? path.replace("~", process.env.HOME || "")
    : path;
  const raw = fs.readFileSync(resolved, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

export function createClient(config: McpConfig): AgentShieldClient {
  const keypair = loadKeypair(config.walletPath);
  const wallet = new Wallet(keypair);
  const connection = new Connection(config.rpcUrl, "confirmed");
  return new AgentShieldClient(connection, wallet);
}

export function loadAgentKeypair(config: McpConfig): Keypair {
  if (!config.agentKeypairPath) {
    throw new Error(
      "AGENTSHIELD_AGENT_KEYPAIR_PATH is required for agent-signed operations. " +
        "Set it to the path of the agent's Solana keypair JSON file."
    );
  }
  return loadKeypair(config.agentKeypairPath);
}
