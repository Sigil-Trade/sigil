/**
 * @usesigil/agent — Sigil for AI.
 *
 * Stdio MCP server that exposes Sigil tools to any MCP-aware AI runtime
 * (Claude Desktop, Claude Code, Cursor, Continue, Cline, Goose). Spawned
 * as a child process by the runtime; communicates via JSON-RPC over
 * stdin/stdout.
 *
 * Subcommands (Day 1 = MCP only; Day 3 adds setup):
 *   sigil-agent           — start MCP server (default)
 *   sigil-agent setup     — first-run onboarding wizard (Day 3)
 *
 * Architecture rationale:
 *   - stdio transport (not HTTP) — keeps the agent keypair on the user's
 *     machine, aligns with Sigil's "chain-as-enforcer" trust model
 *   - single binary — npx @usesigil/agent works everywhere npm works
 *   - reads ~/.sigil/agents/<vault>.json for keypair + vault metadata
 *   - tools mirror @usesigil/kit's OwnerClient + SigilClient surfaces
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetVaultState } from "./tools/get-vault-state.js";

const VERSION = "0.1.0";

async function runMcpServer(): Promise<void> {
  const server = new McpServer(
    {
      name: "sigil-agent",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "Sigil for AI — bounded Solana agent toolkit. " +
        "Use `get_vault_state` to inspect the vault before proposing actions. " +
        "All mutations are sealed by Sigil's on-chain enforcement (spending caps, protocol allowlist, timelock). " +
        "If a tool returns an `isError: true` response, surface the message to the user verbatim — " +
        "Sigil errors are designed to be human-readable.",
    },
  );

  registerGetVaultState(server);
  // Day 2: registerGetPolicy, registerGetRemainingCap, registerGetActivity,
  //        registerSealSwap, registerSealLend, registerSealWithdraw, etc.

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case "setup":
      // Day 3 — onboarding wizard
      console.error(
        "[sigil-agent] `setup` not yet implemented. Coming in v0.2.\n" +
          "For now, manually create ~/.sigil/agents/<vault>.json with shape:\n" +
          "  { vaultAddress, ownerAddress, network, agent: { address, secretKey: [...] }, createdAt }\n",
      );
      process.exit(1);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      // Default: start MCP server
      await runMcpServer();
      break;
  }
}

main().catch((err: unknown) => {
  // Stderr because stdout is reserved for MCP JSON-RPC frames.
  console.error(
    `[sigil-agent] fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
