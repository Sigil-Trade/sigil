#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, createClient, type McpConfig } from "./config";
import type { AgentShieldClient } from "@agent-shield/sdk";

// Tool handlers
import { checkVault } from "./tools/check-vault";
import { checkSpending } from "./tools/check-spending";
import { createVault } from "./tools/create-vault";
import { deposit } from "./tools/deposit";
import { withdraw } from "./tools/withdraw";
import { registerAgent } from "./tools/register-agent";
import { updatePolicy } from "./tools/update-policy";
import { revokeAgent } from "./tools/revoke-agent";
import { reactivateVault } from "./tools/reactivate-vault";
import { executeSwap } from "./tools/execute-swap";
import { openPosition } from "./tools/open-position";
import { closePosition } from "./tools/close-position";

// Resources
import { getPolicyResource } from "./resources/policy";
import { getSpendingResource } from "./resources/spending";
import { getActivityResource } from "./resources/activity";

/**
 * Helper to register a tool with the MCP server.
 * Uses `any` cast to work around zod version mismatch between
 * @modelcontextprotocol/sdk's bundled zod types and our workspace zod.
 * At runtime both resolve to the same zod 3.25.x — this is safe.
 */
function registerTool(
  server: McpServer,
  name: string,
  description: string,
  schema: Record<string, any>,
  handler: (input: any) => Promise<{ content: { type: "text"; text: string }[] }>
) {
  (server as any).tool(name, description, schema, handler);
}

async function main() {
  // All logging to stderr — stdout is reserved for JSON-RPC
  console.error("[agent-shield-mcp] Starting...");

  let config: McpConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[agent-shield-mcp] Configuration error: ${error}`);
    process.exit(1);
  }

  let client: AgentShieldClient;
  try {
    client = createClient(config);
  } catch (error) {
    console.error(`[agent-shield-mcp] Client creation failed: ${error}`);
    process.exit(1);
  }

  console.error(
    `[agent-shield-mcp] Connected to ${config.rpcUrl}, ` +
      `wallet: ${client.provider.wallet.publicKey.toBase58()}`
  );

  const server = new McpServer({
    name: "agent-shield",
    version: "0.1.0",
  });

  // ── Read-Only Tools ──────────────────────────────────────────

  registerTool(
    server,
    "shield_check_vault",
    "Check the status and policy configuration of an AgentShield vault",
    {
      vault: z.string().describe("Vault PDA address (base58). Provide this OR owner+vaultId."),
      owner: z.string().optional().describe("Owner public key (base58). Used with vaultId."),
      vaultId: z.string().optional().describe("Vault ID number. Used with owner."),
    },
    async (input) => ({
      content: [{ type: "text", text: await checkVault(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_check_spending",
    "Check the rolling 24h spending and recent transactions for a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await checkSpending(client, input) }],
    })
  );

  // ── Owner-Signed Write Tools ────────────────────────────────

  registerTool(
    server,
    "shield_create_vault",
    "Create a new AgentShield vault with policy configuration",
    {
      vaultId: z.string().describe("Unique vault ID number"),
      dailySpendingCap: z.string().describe("Max daily spending in token base units"),
      maxTransactionSize: z.string().describe("Max single transaction size in token base units"),
      allowedTokens: z.array(z.string()).describe("Allowed token mint addresses (base58). Max 10."),
      allowedProtocols: z.array(z.string()).describe("Allowed protocol program IDs (base58). Max 10."),
      maxLeverageBps: z.number().describe("Max leverage in basis points (e.g. 30000 = 3x)"),
      maxConcurrentPositions: z.number().describe("Max concurrent open positions"),
      feeDestination: z.string().describe("Fee destination wallet address (base58). Immutable."),
      developerFeeRate: z.number().optional().default(0).describe("Developer fee rate (max 50 = 0.5 BPS)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await createVault(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_deposit",
    "Deposit tokens into an AgentShield vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      mint: z.string().describe("Token mint address (base58)"),
      amount: z.string().describe("Amount in token base units"),
    },
    async (input) => ({
      content: [{ type: "text", text: await deposit(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_withdraw",
    "Withdraw tokens from an AgentShield vault (owner-only)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      mint: z.string().describe("Token mint address (base58)"),
      amount: z.string().describe("Amount in token base units"),
    },
    async (input) => ({
      content: [{ type: "text", text: await withdraw(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_register_agent",
    "Register an agent signing key to a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      agent: z.string().describe("Agent public key to register (base58)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await registerAgent(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_update_policy",
    "Update the policy configuration for a vault (owner-only)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      dailySpendingCap: z.string().optional().describe("New daily spending cap"),
      maxTransactionSize: z.string().optional().describe("New max transaction size"),
      allowedTokens: z.array(z.string()).optional().describe("New allowed token mints (base58)"),
      allowedProtocols: z.array(z.string()).optional().describe("New allowed protocols (base58)"),
      maxLeverageBps: z.number().optional().describe("New max leverage in BPS"),
      canOpenPositions: z.boolean().optional().describe("Whether agent can open positions"),
      maxConcurrentPositions: z.number().optional().describe("New max concurrent positions"),
      developerFeeRate: z.number().optional().describe("New developer fee rate (max 50)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await updatePolicy(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_revoke_agent",
    "Emergency kill switch — revokes agent and freezes vault immediately",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await revokeAgent(client, input) }],
    })
  );

  registerTool(
    server,
    "shield_reactivate_vault",
    "Reactivate a frozen vault, optionally with a new agent",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      newAgent: z.string().optional().describe("Optional new agent public key (base58)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await reactivateVault(client, input) }],
    })
  );

  // ── Agent-Signed Tools ──────────────────────────────────────

  registerTool(
    server,
    "shield_execute_swap",
    "Execute a Jupiter token swap through an AgentShield vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      inputMint: z.string().describe("Input token mint address (base58)"),
      outputMint: z.string().describe("Output token mint address (base58)"),
      amount: z.string().describe("Input amount in token base units"),
      slippageBps: z.number().optional().default(50).describe("Slippage tolerance in BPS (default: 50)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await executeSwap(client, config, input) }],
    })
  );

  registerTool(
    server,
    "shield_open_position",
    "Open a leveraged perpetual position via Flash Trade through a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z.string().describe("Collateral token mint address (base58)"),
      collateralAmount: z.string().describe("Collateral amount in token base units"),
      sizeUsd: z.string().describe("Position size in USD base units"),
      side: z.enum(["long", "short"]).describe("Position side"),
      leverageBps: z.number().describe("Leverage in basis points (e.g. 20000 = 2x)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await openPosition(client, config, input) }],
    })
  );

  registerTool(
    server,
    "shield_close_position",
    "Close a leveraged perpetual position via Flash Trade through a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      side: z.enum(["long", "short"]).describe("Position side"),
      priceWithSlippage: z.string().describe("Exit price in base units"),
      priceExponent: z.number().optional().default(0).describe("Price exponent (default: 0)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await closePosition(client, config, input) }],
    })
  );

  // ── MCP Resources ───────────────────────────────────────────

  (server as any).resource(
    "vault-policy",
    "shield://vault/{address}/policy",
    { description: "Current policy configuration for a vault" },
    async (uri: URL) => {
      const address = uri.pathname.split("/")[2];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: await getPolicyResource(client, address),
          },
        ],
      };
    }
  );

  (server as any).resource(
    "vault-spending",
    "shield://vault/{address}/spending",
    { description: "Rolling 24h spending state for a vault" },
    async (uri: URL) => {
      const address = uri.pathname.split("/")[2];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: await getSpendingResource(client, address),
          },
        ],
      };
    }
  );

  (server as any).resource(
    "vault-activity",
    "shield://vault/{address}/activity",
    { description: "Recent transaction history for a vault" },
    async (uri: URL) => {
      const address = uri.pathname.split("/")[2];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: await getActivityResource(client, address),
          },
        ],
      };
    }
  );

  // ── Start Server ────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-shield-mcp] Server running on stdio");
}

main().catch((error) => {
  console.error("[agent-shield-mcp] Fatal error:", error);
  process.exit(1);
});
