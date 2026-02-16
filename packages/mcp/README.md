# @agent-shield/mcp

MCP (Model Context Protocol) server for AgentShield. Lets any MCP-compatible AI tool — Claude Desktop, Cursor, Windsurf — manage on-chain Solana vaults and enforce DeFi policies via natural language.

## Installation

```bash
npm install -g @agent-shield/mcp
# or run directly
npx @agent-shield/mcp
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTSHIELD_WALLET_PATH` | Yes | — | Path to Solana keypair JSON (vault owner) |
| `AGENTSHIELD_RPC_URL` | No | devnet | Solana RPC endpoint URL |
| `AGENTSHIELD_AGENT_KEYPAIR_PATH` | No | — | Path to agent keypair JSON (needed for swap/position tools) |

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-shield": {
      "command": "npx",
      "args": ["@agent-shield/mcp"],
      "env": {
        "AGENTSHIELD_WALLET_PATH": "~/.config/solana/id.json",
        "AGENTSHIELD_RPC_URL": "https://api.devnet.solana.com"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "agent-shield": {
      "command": "npx",
      "args": ["@agent-shield/mcp"],
      "env": {
        "AGENTSHIELD_WALLET_PATH": "~/.config/solana/id.json"
      }
    }
  }
}
```

## Tools (12)

### Read-Only

| Tool | Description |
|------|-------------|
| `shield_check_vault` | Check vault status, owner, agent, and policy configuration |
| `shield_check_spending` | Check rolling 24h spending and recent transaction history |

### Owner-Signed (Write)

| Tool | Description |
|------|-------------|
| `shield_create_vault` | Create a new vault with policy configuration |
| `shield_deposit` | Deposit tokens into a vault |
| `shield_withdraw` | Withdraw tokens from a vault |
| `shield_register_agent` | Register an agent signing key |
| `shield_update_policy` | Update spending caps, token/protocol allowlists, leverage limits |
| `shield_revoke_agent` | Emergency kill switch — freezes vault immediately |
| `shield_reactivate_vault` | Unfreeze a vault, optionally with a new agent |

### Agent-Signed (Requires `AGENTSHIELD_AGENT_KEYPAIR_PATH`)

| Tool | Description |
|------|-------------|
| `shield_execute_swap` | Execute a Jupiter token swap through the vault |
| `shield_open_position` | Open a Flash Trade leveraged perpetual position |
| `shield_close_position` | Close a Flash Trade perpetual position |

## Resources (3)

Dynamic resources using vault address as URI parameter:

| URI Template | Description |
|-------------|-------------|
| `shield://vault/{address}/policy` | Current policy configuration (JSON) |
| `shield://vault/{address}/spending` | Rolling 24h spending state (JSON) |
| `shield://vault/{address}/activity` | Recent transaction history (JSON) |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests (78 tests)
pnpm test

# Smoke test
AGENTSHIELD_WALLET_PATH=~/.config/solana/id.json node dist/index.js
```

## Architecture

- **Transport**: stdio only (local subprocess of the AI tool)
- **Credentials**: Environment variables (keypair file paths)
- **SDK**: Wraps `AgentShieldClient` from `@agent-shield/sdk` — every tool delegates to a client method
- **Error handling**: All 28 Anchor error codes mapped to human-readable messages with actionable suggestions

## License

MIT
