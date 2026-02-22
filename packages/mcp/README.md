# @agent-shield/mcp

MCP (Model Context Protocol) server for AgentShield. Lets any MCP-compatible AI tool — Claude Desktop, Cursor, Windsurf — manage on-chain Solana vaults and enforce DeFi policies via natural language.

## Installation

```bash
npm install -g @agent-shield/mcp
# or run directly
npx @agent-shield/mcp
```

## Security Model

AgentShield bundles three layers of protection in a single integration:

| Layer | What It Does |
| ----- | ------------ |
| **Client-side policy checks** | Fast deny before transactions hit the network |
| **TEE key custody** | Agent private keys stored in hardware enclaves (Crossmint, Turnkey, Privy) |
| **On-chain vault enforcement** | PDA vaults with cryptographic policy guarantees enforced by Solana validators |

All three layers are set up with a single `shield_configure` call. TEE is required for production use.

## Quickstart

1. Install and add to your MCP client (see Configuration below)
2. Ask your AI assistant: _"What's my AgentShield setup status?"_ — it will call `shield_setup_status`
3. Follow the guided flow: _"Set up AgentShield"_ — the assistant walks you through wallet creation and policy configuration
4. For programmatic/CI deployments, use `shield_configure_from_file` with a pre-written JSON config

## Configuration

### Environment Variables

| Variable                         | Required | Default | Description                                                                                       |
| -------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `AGENTSHIELD_WALLET_PATH`        | No       | —       | Path to Solana keypair JSON (vault owner). Not required — server starts in setup mode without it. |
| `AGENTSHIELD_RPC_URL`            | No       | devnet  | Solana RPC endpoint URL                                                                           |
| `AGENTSHIELD_AGENT_KEYPAIR_PATH` | No       | —       | Path to agent keypair JSON (needed for swap/position tools)                                       |

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

## Tools (22)

### Setup & Onboarding (always available — no wallet required)

| Tool                         | Description                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `shield_setup_status`        | Check current setup status — which layers are active                          |
| `shield_configure`           | Set up AgentShield with full protection (Shield + TEE + Vault)                |
| `shield_configure_from_file` | Apply a pre-written JSON config file (for CI/CD and programmatic deployments) |
| `shield_fund_wallet`         | Generate funding links (Blink URL, Solana Pay, raw address)                   |

### Read-Only

| Tool                          | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `shield_check_vault`          | Check vault status, owner, agent, and policy configuration |
| `shield_check_spending`       | Check rolling 24h spending and recent transaction history  |
| `shield_check_pending_policy` | Check pending timelocked policy update status              |

### Owner-Signed (Write)

| Tool                           | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `shield_create_vault`          | Create a new vault with policy configuration                     |
| `shield_deposit`               | Deposit tokens into a vault                                      |
| `shield_withdraw`              | Withdraw tokens from a vault                                     |
| `shield_register_agent`        | Register an agent signing key                                    |
| `shield_update_policy`         | Update spending caps, token/protocol allowlists, leverage limits |
| `shield_queue_policy_update`   | Queue a timelocked policy change                                 |
| `shield_apply_pending_policy`  | Apply a queued policy change after timelock expires              |
| `shield_cancel_pending_policy` | Cancel a queued policy change                                    |
| `shield_revoke_agent`          | Emergency kill switch — freezes vault immediately                |
| `shield_reactivate_vault`      | Unfreeze a vault, optionally with a new agent                    |
| `shield_provision`             | Provision a vault via Solana Actions                             |

### Agent-Signed (Requires `AGENTSHIELD_AGENT_KEYPAIR_PATH`)

| Tool                    | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `shield_execute_swap`   | Execute a Jupiter token swap through the vault  |
| `shield_open_position`  | Open a Flash Trade leveraged perpetual position |
| `shield_close_position` | Close a Flash Trade perpetual position          |
| `shield_agent_transfer` | Transfer tokens to an allowlisted destination   |

## Resources (3)

Dynamic resources using vault address as URI parameter:

| URI Template                        | Description                         |
| ----------------------------------- | ----------------------------------- |
| `shield://vault/{address}/policy`   | Current policy configuration (JSON) |
| `shield://vault/{address}/spending` | Rolling 24h spending state (JSON)   |
| `shield://vault/{address}/activity` | Recent transaction history (JSON)   |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests (118 tests)
pnpm test

# Smoke test
AGENTSHIELD_WALLET_PATH=~/.config/solana/id.json node dist/index.js
```

## Architecture

- **Transport**: stdio only (local subprocess of the AI tool)
- **Credentials**: Environment variables (keypair file paths)
- **SDK**: Wraps `AgentShieldClient` from `@agent-shield/sdk` — every tool delegates to a client method
- **Setup mode**: Starts without a wallet — only setup/onboarding tools available until configured
- **Programmatic config**: `shield_configure_from_file` reads a JSON config matching the `ShieldLocalConfig` schema — for CI/CD pipelines and orchestrator platforms where interactive setup is not practical
- **Local config**: `~/.agentshield/config.json` stores wallet, layer status, and policy state across sessions
- **Error handling**: All 40 Anchor error codes (6000-6039) mapped to human-readable messages with actionable suggestions

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/agentshield/issues)

## License

Apache-2.0
