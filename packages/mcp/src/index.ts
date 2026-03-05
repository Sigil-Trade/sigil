#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadConfig,
  createClient,
  isConfigured,
  resolveClient,
  type McpConfig,
  type CustodyWalletLike,
} from "./config";
import type { PhalnxClient } from "@phalnx/sdk";

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
import { x402Fetch } from "./tools/x402-fetch";
import { addCollateral } from "./tools/add-collateral";
import { removeCollateral } from "./tools/remove-collateral";
import { placeTriggerOrder } from "./tools/place-trigger-order";
import { cancelTriggerOrder } from "./tools/cancel-trigger-order";
import { placeLimitOrder } from "./tools/place-limit-order";
import { cancelLimitOrder } from "./tools/cancel-limit-order";
import { syncPositions } from "./tools/sync-positions";
import { updateAgentPermissions } from "./tools/update-agent-permissions";

// Escrow tools
import { createEscrow } from "./tools/create-escrow";
import { settleEscrow } from "./tools/settle-escrow";
import { refundEscrow } from "./tools/refund-escrow";
import { closeSettledEscrow } from "./tools/close-settled-escrow";
import { checkEscrow } from "./tools/check-escrow";

// Instruction Constraints tools
import { createConstraints } from "./tools/create-constraints";
import { updateConstraints } from "./tools/update-constraints";
import { closeConstraints } from "./tools/close-constraints";
import { queueConstraintsUpdate as queueConstraintsUpdateHandler } from "./tools/queue-constraints-update";
import { applyConstraintsUpdate } from "./tools/apply-constraints-update";
import { cancelConstraintsUpdate } from "./tools/cancel-constraints-update";
import { checkConstraints } from "./tools/check-constraints";

// Jupiter expanded integration tools
import { getPrices } from "./tools/get-prices";

// Squads V4 multisig governance tools
import { squadsCreateMultisig } from "./tools/squads-create-multisig";
import { squadsProposeAction } from "./tools/squads-propose-action";
import { squadsApprove } from "./tools/squads-approve";
import { squadsReject } from "./tools/squads-reject";
import { squadsExecute } from "./tools/squads-execute";
import { squadsStatus } from "./tools/squads-status";
import { searchTokens } from "./tools/search-tokens";
import { trendingTokens } from "./tools/trending-tokens";
import { lendTokens } from "./tools/lend-tokens";
import { lendDeposit } from "./tools/lend-deposit";
import { lendWithdraw } from "./tools/lend-withdraw";
import { createTriggerOrderJup } from "./tools/create-trigger-order-jup";
import { getTriggerOrdersJup } from "./tools/get-trigger-orders-jup";
import { cancelTriggerOrderJup } from "./tools/cancel-trigger-order-jup";
import { createRecurringOrder } from "./tools/create-recurring-order";
import { getRecurringOrders } from "./tools/get-recurring-orders";
import { cancelRecurringOrder } from "./tools/cancel-recurring-order";
import { jupiterPortfolio } from "./tools/jupiter-portfolio";

// Setup & onboarding tools (work without SDK client)
import { setupStatus } from "./tools/setup-status";
import { configure } from "./tools/configure";
import { configureFromFile } from "./tools/configure-from-file";
import { fundWallet } from "./tools/fund-wallet";
import { discoverVault } from "./tools/discover-vault";
import { confirmVault } from "./tools/confirm-vault";

// Resources
import { getPolicyResource } from "./resources/policy";
import { getSpendingResource } from "./resources/spending";
import { getActivityResource } from "./resources/activity";

const NOT_CONFIGURED_MSG =
  "Phalnx is not configured yet. " +
  'Use shield_setup_status to check status, or ask me to "Set up Phalnx".';

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
  console.error("[phalnx-mcp] Starting...");

  // Try to load config, but don't exit if it fails — run in setup mode
  let config: McpConfig | null = null;
  let client: PhalnxClient | null = null;
  let custodyWallet: CustodyWalletLike | null = null;

  try {
    const resolved = await resolveClient();
    if (resolved) {
      client = resolved.client;
      config = resolved.config;
      custodyWallet = resolved.custodyWallet;
      console.error(
        `[phalnx-mcp] Connected to ${config.rpcUrl}, ` +
          `wallet: ${client.provider.wallet.publicKey.toBase58()}` +
          (custodyWallet ? " (custody)" : ""),
      );
    } else {
      console.error(
        "[phalnx-mcp] No wallet configured — running in setup mode. " +
          "Use shield_setup_status or shield_configure to get started.",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[phalnx-mcp] Config error: ${msg} — running in setup mode.`);
  }

  /**
   * Guard for tools that require a configured SDK client.
   * Returns the "not configured" message if no client is available.
   * Re-checks at call time since config may be created after startup.
   */
  function requireClient(
    fn: (input: any) => Promise<string>,
  ): (input: any) => Promise<{ content: { type: "text"; text: string }[] }> {
    return async (input) => {
      // Re-check at call time (config may have been created since startup)
      if (!client) {
        try {
          const resolved = await resolveClient();
          if (resolved) {
            client = resolved.client;
            config = resolved.config;
            custodyWallet = resolved.custodyWallet;
          } else {
            return {
              content: [{ type: "text", text: NOT_CONFIGURED_MSG }],
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Configuration error: ${msg}` }],
          };
        }
      }
      return {
        content: [{ type: "text", text: await fn(input) }],
      };
    };
  }

  const server = new McpServer({
    name: "phalnx",
    version: "0.1.0",
  });

  // ── Setup & Onboarding Tools (always available) ───────────────

  registerTool(
    server,
    "shield_setup_status",
    "Check the current Phalnx setup status — shows wallet, guardrails, and network configuration. Works even when not configured.",
    {},
    async (input) => ({
      content: [{ type: "text", text: await setupStatus(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_configure",
    "Set up Phalnx with full on-chain protection. Generates keypair, provisions TEE wallet, and creates vault Blink URL.",
    {
      teeProvider: z
        .enum(["crossmint", "turnkey", "privy"])
        .optional()
        .default("crossmint")
        .describe("TEE custody provider (default: crossmint)"),
      template: z
        .enum(["conservative", "moderate", "aggressive"])
        .optional()
        .default("conservative")
        .describe("Policy template"),
      dailySpendingCapUsd: z
        .number()
        .optional()
        .describe("Custom daily cap in USD"),
      protocolMode: z
        .number()
        .optional()
        .describe(
          "Protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
        ),
      protocols: z
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
    "Generate funding links (Blink URL, Solana Pay, raw address) for the configured Phalnx wallet.",
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
    "Apply Phalnx configuration from a pre-written JSON file. For CI/CD pipelines and orchestrator platforms that need non-interactive setup. The config file must match the ShieldLocalConfig schema (same format as ~/.phalnx/config.json).",
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
    "shield_discover_vault",
    "Discover vaults owned by a public key. Derives vault PDA(s) from owner + vaultId and checks on-chain. Use to find vault addresses after creation, or scan for all vaults owned by an address.",
    {
      owner: z.string().describe("Owner public key (base58)"),
      vaultId: z
        .number()
        .optional()
        .describe("Specific vault ID. If omitted, scans a range."),
      scanRange: z
        .number()
        .optional()
        .default(10)
        .describe("Number of IDs to scan (max 256). Default: 10."),
    },
    async (input) => ({
      content: [{ type: "text", text: await discoverVault(null, input) }],
    }),
  );

  registerTool(
    server,
    "shield_confirm_vault",
    "Confirm a vault exists on-chain and save its address to config. Use after signing the vault creation Blink to populate the vault address.",
    {
      owner: z
        .string()
        .optional()
        .describe("Owner public key (base58). Defaults to configured wallet."),
      vaultId: z
        .number()
        .optional()
        .default(0)
        .describe("Vault ID. Default: 0"),
    },
    async (input) => ({
      content: [{ type: "text", text: await confirmVault(null, input) }],
    }),
  );

  // ── Read-Only Tools ──────────────────────────────────────────

  registerTool(
    server,
    "shield_check_vault",
    "Check the status and policy configuration of an Phalnx vault",
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
    "Check the rolling 24h spending for a vault (epoch-based circular buffer)",
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
    "Create a new Phalnx vault with policy configuration",
    {
      vaultId: z.string().describe("Unique vault ID number"),
      dailySpendingCapUsd: z
        .string()
        .describe("Max daily spending in USD base units"),
      maxTransactionSizeUsd: z
        .string()
        .describe("Max single transaction size in USD base units"),
      protocolMode: z
        .number()
        .optional()
        .default(0)
        .describe(
          "Protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
        ),
      protocols: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Protocol program IDs (base58) for allowlist/denylist. Max 10.",
        ),
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
        .describe("Developer fee rate (max 500 = 5 BPS)"),
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
    "Deposit tokens into an Phalnx vault",
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
    "Withdraw tokens from an Phalnx vault (owner-only)",
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
    "Register an agent signing key to a vault. Up to 10 agents per vault. Omit permissions for full access.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      agent: z.string().describe("Agent public key to register (base58)"),
      permissions: z
        .string()
        .optional()
        .describe(
          "Permission bitmask as decimal string. Omit for full permissions (2097151).",
        ),
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
      protocolMode: z
        .number()
        .optional()
        .describe(
          "New protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
        ),
      protocols: z
        .array(z.string())
        .optional()
        .describe("New protocol program IDs (base58)"),
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
        .describe("New developer fee rate (max 500)"),
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
      protocolMode: z
        .number()
        .optional()
        .describe(
          "New protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
        ),
      protocols: z
        .array(z.string())
        .optional()
        .describe("New protocol program IDs (base58)"),
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
        .describe("New developer fee rate (max 500)"),
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
    "Remove an agent from a vault. If no agents remain, the vault freezes.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      agent: z.string().describe("Agent public key to revoke (base58)"),
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
      newAgentPermissions: z
        .string()
        .optional()
        .describe(
          "Permission bitmask for the new agent (decimal string). Only used with newAgent.",
        ),
    },
    requireClient((input) => reactivateVault(client!, input)),
  );

  registerTool(
    server,
    "shield_update_agent_permissions",
    "Update the permission bitmask for a registered agent. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      agent: z.string().describe("Agent public key (base58)"),
      permissions: z
        .string()
        .describe("New permission bitmask as decimal string (full = 2097151)"),
    },
    requireClient((input) => updateAgentPermissions(client!, input)),
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
    "Execute a Jupiter token swap through an Phalnx vault",
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
    requireClient((input) =>
      executeSwap(client!, config!, input, custodyWallet),
    ),
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
    requireClient((input) =>
      openPosition(client!, config!, input, custodyWallet),
    ),
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
    requireClient((input) =>
      closePosition(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_add_collateral",
    "Add collateral to an existing Flash Trade position (spending-checked)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      collateralAmount: z
        .string()
        .describe("Collateral amount in token base units"),
      side: z.enum(["long", "short"]).describe("Position side"),
      positionPubKey: z.string().describe("Position account address (base58)"),
    },
    requireClient((input) =>
      addCollateral(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_remove_collateral",
    "Remove collateral from a Flash Trade position (non-spending)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralDeltaUsd: z.string().describe("Collateral USD delta to remove"),
      side: z.enum(["long", "short"]).describe("Position side"),
      positionPubKey: z.string().describe("Position account address (base58)"),
    },
    requireClient((input) =>
      removeCollateral(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_place_trigger_order",
    "Place a TP/SL trigger order on a Flash Trade position (non-spending)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      receiveSymbol: z.string().describe("Token symbol to receive on trigger"),
      side: z.enum(["long", "short"]).describe("Position side"),
      triggerPrice: z.string().describe("Trigger price in base units"),
      deltaSizeAmount: z.string().describe("Size delta in base units"),
      isStopLoss: z
        .boolean()
        .describe("True for stop-loss, false for take-profit"),
    },
    requireClient((input) =>
      placeTriggerOrder(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_cancel_trigger_order",
    "Cancel a TP/SL trigger order on a Flash Trade position (non-spending)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      side: z.enum(["long", "short"]).describe("Position side"),
      orderId: z.string().describe("Trigger order ID to cancel"),
      isStopLoss: z
        .boolean()
        .describe("True for stop-loss, false for take-profit"),
    },
    requireClient((input) =>
      cancelTriggerOrder(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_place_limit_order",
    "Place a limit order via Flash Trade (spending + position increment)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      reserveSymbol: z.string().describe("Reserve token symbol"),
      receiveSymbol: z.string().describe("Receive token symbol"),
      side: z.enum(["long", "short"]).describe("Position side"),
      limitPrice: z.string().describe("Limit price in base units"),
      reserveAmount: z.string().describe("Reserve amount in token base units"),
      sizeAmount: z.string().describe("Position size in base units"),
      leverageBps: z
        .number()
        .describe("Leverage in basis points (e.g. 20000 = 2x)"),
      stopLossPrice: z
        .string()
        .optional()
        .describe("Optional stop-loss trigger price"),
      takeProfitPrice: z
        .string()
        .optional()
        .describe("Optional take-profit trigger price"),
    },
    requireClient((input) =>
      placeLimitOrder(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_cancel_limit_order",
    "Cancel a limit order on Flash Trade (non-spending, position decrement)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      market: z.string().describe("Market/pool name (e.g. 'SOL', 'ETH')"),
      collateralMint: z
        .string()
        .describe("Collateral token mint address (base58)"),
      reserveSymbol: z.string().describe("Reserve token symbol"),
      receiveSymbol: z.string().describe("Receive token symbol"),
      side: z.enum(["long", "short"]).describe("Position side"),
      orderId: z.string().describe("Limit order ID to cancel"),
    },
    requireClient((input) =>
      cancelLimitOrder(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_sync_positions",
    "Sync vault position counter with actual Flash Trade state (owner-only)",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      poolCustodyPairs: z
        .array(
          z.object({
            pool: z.string().describe("Flash Trade pool address"),
            custody: z.string().describe("Custody account address"),
          }),
        )
        .describe("Pool/custody pairs to check positions against"),
      flashProgramId: z
        .string()
        .optional()
        .describe("Flash Trade program ID (defaults to mainnet)"),
    },
    requireClient((input) => syncPositions(client!, config!, input)),
  );

  // ── Escrow Tools ───────────────────────────────────────────

  registerTool(
    server,
    "shield_check_escrow",
    "Check the status of a conditional escrow between two vaults",
    {
      sourceVault: z.string().describe("Source vault PDA address (base58)"),
      destinationVault: z
        .string()
        .describe("Destination vault PDA address (base58)"),
      escrowId: z.string().describe("Escrow ID number"),
    },
    requireClient((input) => checkEscrow(client!, input)),
  );

  registerTool(
    server,
    "shield_create_escrow",
    "Create a conditional escrow between two vaults. Locks tokens until conditions are met or escrow expires. Agent-signed.",
    {
      sourceVault: z.string().describe("Source vault PDA address (base58)"),
      destinationVault: z
        .string()
        .describe("Destination vault PDA address (base58)"),
      escrowId: z.string().describe("Unique escrow ID number"),
      amount: z.string().describe("Amount in token base units"),
      expiresAt: z
        .string()
        .describe("Expiration timestamp (Unix seconds). Max 30 days."),
      conditionHash: z
        .array(z.number().int().min(0).max(255))
        .length(32)
        .describe("SHA-256 condition hash (32 bytes)"),
      tokenMint: z.string().describe("Token mint address (base58)"),
      sourceVaultAta: z
        .string()
        .describe("Source vault token account (base58)"),
      protocolTreasuryAta: z
        .string()
        .optional()
        .describe("Protocol treasury token account (base58)"),
      feeDestinationAta: z
        .string()
        .optional()
        .describe("Developer fee destination token account (base58)"),
    },
    requireClient((input) => createEscrow(client!, input)),
  );

  registerTool(
    server,
    "shield_settle_escrow",
    "Settle an escrow by providing proof matching the condition hash. Agent-signed (destination vault).",
    {
      destinationVault: z
        .string()
        .describe("Destination vault PDA address (base58)"),
      sourceVault: z.string().describe("Source vault PDA address (base58)"),
      escrow: z.string().describe("Escrow PDA address (base58)"),
      escrowAta: z.string().describe("Escrow token account (base58)"),
      destinationVaultAta: z
        .string()
        .describe("Destination vault token account (base58)"),
      tokenMint: z.string().describe("Token mint address (base58)"),
      proof: z
        .string()
        .describe(
          "Base64-encoded proof data (SHA-256 must match condition_hash)",
        ),
    },
    requireClient((input) => settleEscrow(client!, input)),
  );

  registerTool(
    server,
    "shield_refund_escrow",
    "Refund an expired escrow, returning tokens to the source vault",
    {
      sourceVault: z.string().describe("Source vault PDA address (base58)"),
      escrow: z.string().describe("Escrow PDA address (base58)"),
      escrowAta: z.string().describe("Escrow token account (base58)"),
      sourceVaultAta: z
        .string()
        .describe("Source vault token account (base58)"),
      tokenMint: z.string().describe("Token mint address (base58)"),
    },
    requireClient((input) => refundEscrow(client!, input)),
  );

  registerTool(
    server,
    "shield_close_settled_escrow",
    "Close a settled or refunded escrow account and reclaim rent",
    {
      sourceVault: z.string().describe("Source vault PDA address (base58)"),
      destinationVault: z
        .string()
        .describe("Destination vault PDA address (base58)"),
      escrow: z.string().describe("Escrow PDA address (base58)"),
      escrowId: z.string().describe("Escrow ID number"),
    },
    requireClient((input) => closeSettledEscrow(client!, input)),
  );

  // ── Instruction Constraints Tools ─────────────────────────

  registerTool(
    server,
    "shield_check_constraints",
    "Check instruction constraints and pending updates for a vault",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => checkConstraints(client!, input)),
  );

  registerTool(
    server,
    "shield_create_constraints",
    "Create instruction constraints that validate DeFi instruction data bytes. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      entries: z
        .array(
          z.object({
            programId: z.string().describe("Target program ID (base58)"),
            dataConstraints: z.array(
              z.object({
                offset: z
                  .number()
                  .int()
                  .min(0)
                  .describe("Byte offset in instruction data"),
                operator: z
                  .enum(["eq", "ne", "gte", "lte"])
                  .describe("Comparison operator"),
                value: z
                  .array(z.number().int().min(0).max(255))
                  .min(1)
                  .max(32)
                  .describe("Expected value bytes"),
              }),
            ),
          }),
        )
        .min(1)
        .describe("Constraint entries (one per target program)"),
    },
    requireClient((input) => createConstraints(client!, input)),
  );

  registerTool(
    server,
    "shield_update_constraints",
    "Replace all instruction constraints for a vault. No-timelock vaults only. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      entries: z
        .array(
          z.object({
            programId: z.string().describe("Target program ID (base58)"),
            dataConstraints: z.array(
              z.object({
                offset: z.number().int().min(0),
                operator: z.enum(["eq", "ne", "gte", "lte"]),
                value: z.array(z.number().int().min(0).max(255)).min(1).max(32),
              }),
            ),
          }),
        )
        .min(1)
        .describe("New constraint entries"),
    },
    requireClient((input) => updateConstraints(client!, input)),
  );

  registerTool(
    server,
    "shield_close_constraints",
    "Remove all instruction constraints from a vault and reclaim rent. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => closeConstraints(client!, input)),
  );

  registerTool(
    server,
    "shield_queue_constraints_update",
    "Queue a timelocked constraints update. Required for vaults with timelock. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      entries: z
        .array(
          z.object({
            programId: z.string().describe("Target program ID (base58)"),
            dataConstraints: z.array(
              z.object({
                offset: z.number().int().min(0),
                operator: z.enum(["eq", "ne", "gte", "lte"]),
                value: z.array(z.number().int().min(0).max(255)).min(1).max(32),
              }),
            ),
          }),
        )
        .min(1)
        .describe("New constraint entries"),
    },
    requireClient((input) => queueConstraintsUpdateHandler(client!, input)),
  );

  registerTool(
    server,
    "shield_apply_constraints_update",
    "Apply a pending timelocked constraints update after timelock expires. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => applyConstraintsUpdate(client!, input)),
  );

  registerTool(
    server,
    "shield_cancel_constraints_update",
    "Cancel a pending timelocked constraints update. Owner-only.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
    },
    requireClient((input) => cancelConstraintsUpdate(client!, input)),
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
        .describe("Phalnx Actions server URL"),
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
      protocolMode: z
        .number()
        .optional()
        .describe(
          "Protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist",
        ),
      protocols: z
        .array(z.string())
        .optional()
        .describe("Custom protocol program IDs (base58)"),
      maxLeverageBps: z
        .number()
        .optional()
        .describe("Custom max leverage in basis points"),
    },
    async (input) => ({
      content: [{ type: "text", text: await provision(client as any, input) }],
    }),
  );

  registerTool(
    server,
    "shield_x402_fetch",
    "Fetch a URL with automatic x402 (HTTP 402) payment support",
    {
      url: z.string().describe("URL of the x402-protected API endpoint"),
      method: z
        .string()
        .optional()
        .default("GET")
        .describe("HTTP method (default: GET)"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional HTTP headers"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
      maxPayment: z
        .string()
        .regex(/^\d+$/, "Must be a non-negative integer in token base units")
        .optional()
        .describe("Maximum payment in token base units"),
    },
    requireClient((input) => x402Fetch(client!, config!, input, custodyWallet)),
  );

  // ── Jupiter Expanded Tools (Read-Only) ─────────────────────

  registerTool(
    server,
    "shield_get_prices",
    "Get real-time USD prices for Solana tokens via Jupiter Price API. Read-only — no vault required. Supports up to 50 mints per request.",
    {
      mints: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Token mint addresses (base58). Max 50."),
      showExtraInfo: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include confidence level, depth, and quoted prices"),
    },
    async (input) => ({
      content: [{ type: "text", text: await getPrices(input) }],
    }),
  );

  registerTool(
    server,
    "shield_search_tokens",
    "Search for Solana tokens by name, symbol, or address. Returns verification status and safety indicators. Read-only — no vault required.",
    {
      query: z
        .string()
        .min(1)
        .describe("Search query (name, symbol, or mint address)"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max results (default 10, max 50)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await searchTokens(input) }],
    }),
  );

  registerTool(
    server,
    "shield_trending_tokens",
    "Get trending Solana tokens from Jupiter with safety indicators. Read-only — no vault required.",
    {
      interval: z
        .enum(["5m", "1h", "6h", "24h"])
        .optional()
        .default("24h")
        .describe("Trending interval (default: 24h)"),
    },
    async (input) => ({
      content: [{ type: "text", text: await trendingTokens(input) }],
    }),
  );

  registerTool(
    server,
    "shield_lend_tokens",
    "List available tokens for Jupiter Lend/Earn with APY rates. Read-only — no vault required.",
    {},
    async (input) => ({
      content: [{ type: "text", text: await lendTokens(input) }],
    }),
  );

  registerTool(
    server,
    "shield_get_trigger_orders_jup",
    "List Jupiter trigger/limit orders for a wallet. Read-only — no vault required.",
    {
      authority: z
        .string()
        .describe("Wallet address to query orders for (base58)"),
      state: z
        .enum(["active", "completed", "cancelled"])
        .optional()
        .describe("Filter by order state"),
    },
    requireClient((input) => getTriggerOrdersJup(client!, input)),
  );

  registerTool(
    server,
    "shield_get_recurring_orders",
    "List Jupiter recurring/DCA orders for a wallet. Read-only — no vault required.",
    {
      user: z.string().describe("Wallet address to query orders for (base58)"),
    },
    requireClient((input) => getRecurringOrders(client!, input)),
  );

  registerTool(
    server,
    "shield_jupiter_portfolio",
    "Get portfolio positions across Jupiter-supported platforms. Beta API. Read-only — no vault required.",
    {
      wallet: z.string().describe("Wallet address to check portfolio (base58)"),
    },
    requireClient((input) => jupiterPortfolio(client!, input)),
  );

  // ── Jupiter Expanded Tools (Agent-Signed) ─────────────────

  registerTool(
    server,
    "shield_lend_deposit",
    "Deposit tokens into Jupiter Lend/Earn through an Phalnx vault. Full on-chain sandwich enforcement. Counts against daily spending cap.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      mint: z.string().describe("Token mint to deposit (base58)"),
      amount: z.string().describe("Amount in token base units"),
    },
    requireClient((input) =>
      lendDeposit(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_lend_withdraw",
    "Withdraw tokens from Jupiter Lend/Earn through an Phalnx vault. Full on-chain sandwich enforcement. Non-spending action.",
    {
      vault: z.string().describe("Vault PDA address (base58)"),
      mint: z.string().describe("Token mint to withdraw (base58)"),
      amount: z.string().describe("Amount in token base units"),
    },
    requireClient((input) =>
      lendWithdraw(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_create_trigger_order_jup",
    "Create a Jupiter limit/trigger order. Client-side policy enforcement.",
    {
      inputMint: z.string().describe("Input token mint address (base58)"),
      outputMint: z.string().describe("Output token mint address (base58)"),
      makingAmount: z.string().describe("Input amount in token base units"),
      takingAmount: z
        .string()
        .describe("Minimum output amount in token base units"),
      expiredAt: z
        .number()
        .optional()
        .default(0)
        .describe("Expiry timestamp (Unix seconds). 0 = no expiry."),
    },
    requireClient((input) =>
      createTriggerOrderJup(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_cancel_trigger_order_jup",
    "Cancel a Jupiter trigger/limit order. Client-side policy enforcement.",
    {
      orderId: z.string().describe("Jupiter trigger order ID to cancel"),
    },
    requireClient((input) =>
      cancelTriggerOrderJup(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_create_recurring_order",
    "Create a Jupiter recurring/DCA order. Automates periodic token buys. Client-side policy enforcement.",
    {
      inputMint: z.string().describe("Input token mint address (base58)"),
      outputMint: z.string().describe("Output token mint address (base58)"),
      inAmount: z
        .string()
        .describe("Total input amount across all orders (token base units)"),
      numberOfOrders: z
        .number()
        .min(2)
        .describe("Number of orders to split into (min 2)"),
      intervalSeconds: z
        .number()
        .describe("Interval between orders in seconds"),
    },
    requireClient((input) =>
      createRecurringOrder(client!, config!, input, custodyWallet),
    ),
  );

  registerTool(
    server,
    "shield_cancel_recurring_order",
    "Cancel a Jupiter recurring/DCA order. Client-side policy enforcement.",
    {
      orderId: z.string().describe("Jupiter recurring order ID to cancel"),
    },
    requireClient((input) =>
      cancelRecurringOrder(client!, config!, input, custodyWallet),
    ),
  );

  // ── Squads V4 Multisig Governance Tools ─────────────────────

  registerTool(
    server,
    "shield_squads_create_multisig",
    "Create a new Squads V4 multisig for N-of-M governance over Phalnx vaults. " +
      "The vault PDA becomes the Phalnx vault owner.",
    {
      members: z
        .array(
          z.object({
            key: z.string().describe("Member wallet address (base58)"),
            permissions: z
              .object({
                initiate: z.boolean().optional().default(true),
                vote: z.boolean().optional().default(true),
                execute: z.boolean().optional().default(true),
              })
              .describe("Member permissions"),
          }),
        )
        .min(1)
        .describe("Multisig members with permissions"),
      threshold: z
        .number()
        .int()
        .min(1)
        .describe("Number of approvals required (N-of-M)"),
      timeLock: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Delay in seconds between approval and execution"),
      memo: z.string().optional().describe("Optional memo"),
    },
    requireClient((input) => squadsCreateMultisig(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_squads_propose_action",
    "Propose an Phalnx admin action through Squads multisig governance. " +
      "Wraps the instruction in a vault transaction and opens a proposal.",
    {
      multisig: z.string().describe("Squads multisig address (base58)"),
      vaultIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Squads vault authority index (default 0)"),
      action: z
        .enum([
          "update_policy",
          "queue_policy_update",
          "apply_pending_policy",
          "emergency_close",
          "sync_positions",
        ])
        .describe("Phalnx admin action to propose"),
      phalnxVault: z.string().describe("Phalnx vault PDA address (base58)"),
      actionParams: z
        .string()
        .optional()
        .describe("JSON string with action-specific params"),
      memo: z.string().optional().describe("Optional proposal memo"),
    },
    requireClient((input) => squadsProposeAction(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_squads_approve",
    "Cast an approval vote on a Squads proposal. " +
      "Wallet must be a member with Vote permission.",
    {
      multisig: z.string().describe("Squads multisig address (base58)"),
      transactionIndex: z
        .string()
        .describe("Transaction index to approve (numeric string)"),
      memo: z.string().optional().describe("Optional approval memo"),
    },
    requireClient((input) => squadsApprove(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_squads_reject",
    "Cast a rejection vote on a Squads proposal. " +
      "Wallet must be a member with Vote permission.",
    {
      multisig: z.string().describe("Squads multisig address (base58)"),
      transactionIndex: z
        .string()
        .describe("Transaction index to reject (numeric string)"),
    },
    requireClient((input) => squadsReject(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_squads_execute",
    "Execute an approved Squads vault transaction. " +
      "Wallet must be a member with Execute permission.",
    {
      multisig: z.string().describe("Squads multisig address (base58)"),
      transactionIndex: z
        .string()
        .describe("Transaction index to execute (numeric string)"),
    },
    requireClient((input) => squadsExecute(client!, config!, input)),
  );

  registerTool(
    server,
    "shield_squads_status",
    "Check Squads multisig status: members, threshold, transaction count. " +
      "Optionally check a specific proposal's voting status.",
    {
      multisig: z.string().describe("Squads multisig address (base58)"),
      transactionIndex: z
        .string()
        .optional()
        .describe("Optional transaction index to check proposal status"),
    },
    requireClient((input) => squadsStatus(client!, input)),
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
  console.error("[phalnx-mcp] Server running on stdio");
}

main().catch((error) => {
  console.error("[phalnx-mcp] Fatal error:", error);
  process.exit(1);
});
