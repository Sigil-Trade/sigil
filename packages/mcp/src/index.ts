#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadConfig,
  createClient,
  isConfigured,
  type McpConfig,
} from "./config";
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
import { provision } from "./tools/provision";
import { queuePolicyUpdate } from "./tools/queue-policy-update";
import { applyPendingPolicy } from "./tools/apply-pending-policy";
import { cancelPendingPolicy } from "./tools/cancel-pending-policy";
import { checkPendingPolicy } from "./tools/check-pending-policy";
import { agentTransfer } from "./tools/agent-transfer";

// Setup & onboarding tools (work without SDK client)
import { setupStatus } from "./tools/setup-status";
import { configure } from "./tools/configure";
import { configureFromFile } from "./tools/configure-from-file";
import { fundWallet } from "./tools/fund-wallet";
import { upgradeTier } from "./tools/upgrade-tier";

// Resources
import { getPolicyResource } from "./resources/policy";
import { getSpendingResource } from "./resources/spending";
import { getActivityResource } from "./resources/activity";

const NOT_CONFIGURED_MSG =
  "AgentShield is not configured yet. " +
  'Use shield_setup_status to check status, or ask me to "Set up AgentShield".';

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
  handler: (
    input: any,
  ) => Promise<{ content: { type: "text"; text: string }[] }>,
) {
  (server as any).tool(name, description, schema, handler);
}

async function main() {
  // All logging to stderr — stdout is reserved for JSON-RPC
  console.error("[agent-shield-mcp] Starting...");

  // Try to load config, but don't exit if it fails — run in setup mode
  let config: McpConfig | null = null;
  let client: AgentShieldClient | null = null;

  try {
    config = loadConfig();
    client = createClient(config);
    console.error(
      `[agent-shield-mcp] Connected to ${config.rpcUrl}, ` +
        `wallet: ${client.provider.wallet.publicKey.toBase58()}`,
    );
  } catch {
    console.error(
      "[agent-shield-mcp] No wallet configured — running in setup mode. " +
        "Use shield_setup_status or shield_configure to get started.",
    );
  }

  /**
   * Guard for tools that require a configured SDK client.
   * Returns the "not configured" message if no client is available.
   */
  function requireClient(
    fn: (input: any) => Promise<string>,
  ): (input: any) => Promise<{ content: { type: "text"; text: string }[] }> {
    return async (input) => {
      // Re-check at call time (config may have been created since startup)
      if (!client) {
        try {
          const freshConfig = loadConfig();
          client = createClient(freshConfig);
          config = freshConfig;
        } catch {
          return {
            content: [{ type: "text", text: NOT_CONFIGURED_MSG }],
          };
        }
      }
      return {
        content: [{ type: "text", text: await fn(input) }],
      };
    };
  }

  const server = new McpServer({
    name: "agent-shield",
    version: "0.1.0",
  });

  // ── Setup & Onboarding Tools (always available) ───────────────

  registerTool(
    server,
    "shield_setup_status",
    "Check the current AgentShield setup status — shows which security tiers are active, wallet, policy, and network. Works even when not configured.",
    {},
    async (input) => ({
      content: [{ type: "text", text: await setupStatus(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_configure",
    "Set up AgentShield with any security tier (1=Shield, 2=Shield+TEE, 3=Shield+TEE+Vault). Generates keypair, provisions TEE, and/or creates vault.",
    {
      tier: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .describe("Security tier: 1=Shield, 2=Shield+TEE, 3=Shield+TEE+Vault"),
      template: z
        .enum(["conservative", "moderate", "aggressive"])
        .optional()
        .default("conservative")
        .describe("Policy template"),
      dailyCapUsd: z.number().optional().describe("Custom daily cap in USD"),
      allowedProtocols: z
        .array(z.string())
        .optional()
        .describe("Custom protocol IDs (base58)"),
      maxLeverageBps: z
        .number()
        .optional()
        .describe("Custom max leverage in BPS"),
      rateLimit: z.number().optional().describe("Custom rate limit (tx/min)"),
      network: z
        .enum(["devnet", "mainnet-beta"])
        .optional()
        .default("devnet")
        .describe("Solana network"),
      walletPath: z
        .string()
        .optional()
        .describe("Path to existing keypair JSON"),
    },
    async (input) => ({
      content: [{ type: "text", text: await configure(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_fund_wallet",
    "Generate funding links (Blink URL, Solana Pay, raw address) for the configured AgentShield wallet.",
    {
      mint: z
        .string()
        .optional()
        .describe("Token mint (base58). Omit for SOL."),
      amount: z.string().optional().describe("Amount in human-readable units"),
    },
    async (input) => ({
      content: [{ type: "text", text: await fundWallet(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_configure_from_file",
    "Apply AgentShield configuration from a pre-written JSON file. For CI/CD pipelines and orchestrator platforms that need non-interactive setup. The config file must match the ShieldLocalConfig schema (same format as ~/.agentshield/config.json).",
    {
      configFile: z
        .string()
        .describe(
          "Absolute or ~-relative path to a JSON config file matching the ShieldLocalConfig schema",
        ),
    },
    async (input) => ({
      content: [{ type: "text", text: await configureFromFile(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_upgrade_tier",
    "Upgrade AgentShield from current tier to a higher one (2=add TEE, 3=add Vault). Preserves existing policy.",
    {
      targetTier: z
        .union([z.literal(2), z.literal(3)])
        .describe("Target tier: 2=add TEE, 3=add Vault"),
    },
    async (input) => ({
      content: [{ type: "text", text: await upgradeTier(null, input) }],
    }),
  );

  // ── Read-Only Tools ──────────────────────────────────────────

  registerTool(
    server,
    "shield_check_vault",
    "Check the status and policy configuration of an AgentShield vault",
    {
      vault: z
        .string()
        .describe("Vault PDA address (base58). Provide this OR owner+vaultId."),
      owner: z
        .string()
        .optional()
        .describe("Owner public key (base58). Used with vaultId."),
      vaultId: z
        .string()
        .optional()
        .describe("Vault ID number. Used with owner."),
    },
    requireClient((input) => checkVault(client!, input)),
  );

  registerTool(
    server,
    "shield_check_spending",
    "Check the rolling 24h spending and recent transactions for a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => checkSpending(client!, input)),
  );

  registerTool(
    server,
    "shield_check_pending_policy",
    "Check if a pending timelocked policy update exists for a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => checkPendingPolicy(client!, input)),
  );

  // ── Owner-Signed Write Tools ────────────────────────────────

  registerTool(
    server,
    "shield_create_vault",
    "Create a new AgentShield vault with policy configuration",
    {
      vaultId: z.string().describe("Unique vault ID number"),
      dailySpendingCapUsd: z
        .string()
        .describe("Max daily spending in USD base units"),
      maxTransactionSizeUsd: z
        .string()
        .describe("Max single transaction size in USD base units"),
      allowedTokens: z
        .array(z.string())
        .describe("Allowed token mint addresses (base58). Max 10."),
      allowedProtocols: z
        .array(z.string())
        .describe("Allowed protocol program IDs (base58). Max 10."),
      maxLeverageBps: z
        .number()
        .describe("Max leverage in basis points (e.g. 30000 = 3x)"),
      maxConcurrentPositions: z
        .number()
        .describe("Max concurrent open positions"),
      feeDestination: z
        .string()
        .describe("Fee destination wallet address (base58). Immutable."),
      developerFeeRate: z
        .number()
        .optional()
        .default(0)
        .describe("Developer fee rate (max 50 = 0.5 BPS)"),
      allowedDestinations: z
        .array(z.string())
        .optional()
        .describe(
          "Allowed destination addresses for agent transfers (base58). Max 10.",
        ),
      timelockDuration: z
        .number()
        .optional()
        .default(0)
        .describe(
          "Timelock duration in seconds (0 = immediate policy updates)",
        ),
    },
    requireClient((input) => createVault(client!, input)),
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
    requireClient((input) => deposit(client!, input)),
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
    requireClient((input) => withdraw(client!, input)),
  );

  registerTool(
    server,
    "shield_register_agent",
    "Register an agent signing key to a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      agent: z.string().describe("Agent public key to register (base58)"),
    },
    requireClient((input) => registerAgent(client!, input)),
  );

  registerTool(
    server,
    "shield_update_policy",
    "Update the policy configuration for a vault (owner-only)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      dailySpendingCapUsd: z
        .string()
        .optional()
        .describe("New daily spending cap in USD"),
      maxTransactionSizeUsd: z
        .string()
        .optional()
        .describe("New max transaction size in USD"),
      allowedTokens: z
        .array(z.string())
        .optional()
        .describe("New allowed token mints (base58)"),
      allowedProtocols: z
        .array(z.string())
        .optional()
        .describe("New allowed protocols (base58)"),
      maxLeverageBps: z.number().optional().describe("New max leverage in BPS"),
      canOpenPositions: z
        .boolean()
        .optional()
        .describe("Whether agent can open positions"),
      maxConcurrentPositions: z
        .number()
        .optional()
        .describe("New max concurrent positions"),
      developerFeeRate: z
        .number()
        .optional()
        .describe("New developer fee rate (max 50)"),
      allowedDestinations: z
        .array(z.string())
        .optional()
        .describe("New allowed destinations (base58)"),
      timelockDuration: z
        .number()
        .optional()
        .describe("New timelock duration in seconds"),
    },
    requireClient((input) => updatePolicy(client!, input)),
  );

  registerTool(
    server,
    "shield_queue_policy_update",
    "Queue a timelocked policy change (required when timelock_duration > 0)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      dailySpendingCapUsd: z
        .string()
        .optional()
        .describe("New daily spending cap in USD"),
      maxTransactionSizeUsd: z
        .string()
        .optional()
        .describe("New max transaction size in USD"),
      allowedTokens: z
        .array(z.string())
        .optional()
        .describe("New allowed token mints (base58)"),
      allowedProtocols: z
        .array(z.string())
        .optional()
        .describe("New allowed protocols (base58)"),
      allowedDestinations: z
        .array(z.string())
        .optional()
        .describe("New allowed destinations (base58)"),
      maxLeverageBps: z.number().optional().describe("New max leverage in BPS"),
      canOpenPositions: z
        .boolean()
        .optional()
        .describe("Whether agent can open positions"),
      maxConcurrentPositions: z
        .number()
        .optional()
        .describe("New max concurrent positions"),
      timelockDuration: z
        .number()
        .optional()
        .describe("New timelock duration in seconds"),
      developerFeeRate: z
        .number()
        .optional()
        .describe("New developer fee rate (max 50)"),
    },
    requireClient((input) => queuePolicyUpdate(client!, input)),
  );

  registerTool(
    server,
    "shield_apply_pending_policy",
    "Apply a pending timelocked policy update after timelock expires",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => applyPendingPolicy(client!, input)),
  );

  registerTool(
    server,
    "shield_cancel_pending_policy",
    "Cancel a pending timelocked policy update before it takes effect",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => cancelPendingPolicy(client!, input)),
  );

  registerTool(
    server,
    "shield_revoke_agent",
    "Emergency kill switch — revokes agent and freezes vault immediately",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => revokeAgent(client!, input)),
  );

  registerTool(
    server,
    "shield_reactivate_vault",
    "Reactivate a frozen vault, optionally with a new agent",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      newAgent: z
        .string()
        .optional()
        .describe("Optional new agent public key (base58)"),
    },
    requireClient((input) => reactivateVault(client!, input)),
  );

  // ── Agent-Signed Tools ──────────────────────────────────────

  registerTool(
    server,
    "shield_agent_transfer",
    "Transfer tokens from a vault to an allowed destination (agent-signed)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      destination: z
        .string()
        .describe(
          "Destination wallet address (base58). Must be in allowed_destinations if configured.",
        ),
      mint: z.string().describe("Token mint address (base58)"),
      amount: z.string().describe("Amount in token base units"),
    },
    requireClient((input) => agentTransfer(client!, input)),
  );

  registerTool(
    server,
    "shield_execute_swap",
    "Execute a Jupiter token swap through an AgentShield vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      inputMint: z.string().describe("Input token mint address (base58)"),
      outputMint: z.string().describe("Output token mint address (base58)"),
      amount: z.string().describe("Input amount in token base units"),
      slippageBps: z
        .number()
        .optional()
        .default(50)
        .describe("Slippage tolerance in BPS (default: 50)"),
    },
    requireClient((input) => executeSwap(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_open_position",
    "Open a leveraged perpetual position via Flash Trade through a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      collateralAmount: z
        .string()
        .describe("Collateral amount in token base units"),
      sizeUsd: z.string().describe("Position size in USD base units"),
      side: z.enum(["long", "short"]).describe("Position side"),
      leverageBps: z
        .number()
        .describe("Leverage in basis points (e.g. 20000 = 2x)"),
    },
    requireClient((input) => openPosition(client!, config!, input)),
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
      priceExponent: z
        .number()
        .optional()
        .default(0)
        .describe("Price exponent (default: 0)"),
    },
    requireClient((input) => closePosition(client!, config!, input)),
  );

  // ── Platform Tools ─────────────────────────────────────────

  registerTool(
    server,
    "shield_provision",
    "Generate a Solana Action URL (Blink) for one-click vault provisioning. The user clicks the link to approve — no agent signing needed.",
    {
      platformUrl: z
        .string()
        .optional()
        .default("https://agent-middleware.vercel.app")
        .describe("AgentShield Actions server URL"),
      template: z
        .enum(["conservative", "moderate", "aggressive"])
        .optional()
        .default("conservative")
        .describe("Policy template"),
      dailyCap: z
        .number()
        .optional()
        .describe("Custom daily spending cap in USDC"),
      agentPubkey: z
        .string()
        .optional()
        .describe("Agent public key (base58) to register in the vault"),
      allowedProtocols: z
        .array(z.string())
        .optional()
        .describe("Custom allowed protocol program IDs (base58)"),
      maxLeverageBps: z
        .number()
        .optional()
        .describe("Custom max leverage in basis points"),
    },
    async (input) => ({
      content: [{ type: "text", text: await provision(client as any, input) }],
    }),
  );

  // ── MCP Resources ───────────────────────────────────────────

  (server as any).resource(
    "vault-policy",
    "shield://vault/{address}/policy",
    { description: "Current policy configuration for a vault" },
    async (uri: URL) => {
      if (!client) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: NOT_CONFIGURED_MSG,
            },
          ],
        };
      }
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
    },
  );

  (server as any).resource(
    "vault-spending",
    "shield://vault/{address}/spending",
    { description: "Rolling 24h spending state for a vault" },
    async (uri: URL) => {
      if (!client) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: NOT_CONFIGURED_MSG,
            },
          ],
        };
      }
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
    },
  );

  (server as any).resource(
    "vault-activity",
    "shield://vault/{address}/activity",
    { description: "Recent transaction history for a vault" },
    async (uri: URL) => {
      if (!client) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: NOT_CONFIGURED_MSG,
            },
          ],
        };
      }
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
    },
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
