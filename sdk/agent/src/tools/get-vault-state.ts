/**
 * MCP tool — `get_vault_state`.
 *
 * Read-only tool that returns the current on-chain state of the agent's
 * vault: owner, status (active/frozen/closed), balance, P&L, and health
 * checks. The model uses this to ground its decisions before proposing
 * any seal_* mutation.
 *
 * Schema is intentionally narrow — the kit's VaultState is rich, but
 * the model only needs the human-meaningful fields. A future
 * `get_vault_state_full` tool can expose everything for power users.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadDefaultConfig } from "../lib/config.js";
import { buildReadClient } from "../lib/kit-client.js";

export function registerGetVaultState(server: McpServer): void {
  server.registerTool(
    "get_vault_state",
    {
      title: "Get vault state",
      description:
        "Returns the current on-chain state of the Sigil vault this agent operates: owner address, status (active/frozen/closed), USDC+USDT balance, P&L, and policy health checks. Call this before proposing any spending action.",
      inputSchema: {},
    },
    async () => {
      const config = loadDefaultConfig();
      if (!config) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No agent config found. Run `npx @usesigil/agent setup` first to provision an agent for a vault.",
            },
          ],
        };
      }

      const { client } = buildReadClient(config);
      try {
        const state = await client.getVaultState();
        const balance = state.balance.tokens.map((t) => ({
          mint: t.mint,
          amount: (Number(t.amount) / 10 ** t.decimals).toString(),
        }));
        const summary = {
          vault: {
            address: state.vault.address,
            status: state.vault.status,
            owner: state.vault.owner,
            agentCount: state.vault.agentCount,
          },
          balance: {
            totalUsd: (Number(state.balance.total) / 1_000_000).toFixed(2),
            tokens: balance,
          },
          pnl: {
            percent: state.pnl.percent,
            absoluteUsd: (Number(state.pnl.absolute) / 1_000_000).toFixed(2),
          },
          health: {
            level: state.health.level,
            alertCount: state.health.alertCount,
            failedChecks: state.health.checks
              .filter((c) => !c.passed)
              .map((c) => c.name),
          },
          network: config.network,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch vault state: ${message}`,
            },
          ],
        };
      }
    },
  );
}
// Suppress unused — Zod is the SDK's required peer dep, kept here for future input-schema tools.
void z;
