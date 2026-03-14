# @phalnx/mcp — AI Agent Guardrails for Solana

MCP (Model Context Protocol) server for Phalnx. Lets any MCP-compatible AI tool — Claude Desktop, Cursor, Windsurf, ChatGPT — manage on-chain Solana vaults and enforce DeFi policies via natural language.

## Quick Start (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "phalnx": {
      "command": "npx",
      "args": ["@phalnx/mcp"],
      "env": {
        "PHALNX_RPC_URL": "https://api.devnet.solana.com"
      }
    }
  }
}
```

No wallet path needed — the server starts in setup mode and guides you through configuration.

## 5 Tools

### `phalnx_execute` — Execute DeFi actions with guardrails

The primary agent tool (~80% of calls). Handles swaps, perps, transfers, lending, escrow, and protocol passthrough. All actions are policy-checked and sandwiched in on-chain guardrails.

```
action: "swap" | "transfer" | "openPosition" | "closePosition" | ...
params: { inputMint, outputMint, amount, ... }
vault?: "base58 vault address"
```

### `phalnx_query` — Read vault state, prices, portfolio

Read-only queries for vault state, spending, policies, token prices, portfolio, positions, and protocol capabilities.

```
query: "vault" | "spending" | "policy" | "prices" | "searchTokens" | "protocols" | ...
params: { vault?, query?, mints?, ... }
```

### `phalnx_setup` — One-time configuration

Setup and onboarding — works even without a configured wallet.

```
step: "status" | "configure" | "configureFromFile" | "fundWallet" | "provision" | ...
params: { ... }
```

### `phalnx_manage` — Vault owner management

Owner-only vault management: create vaults, register agents, update policies, constraints, escrow, Squads governance.

```
action: "createVault" | "registerAgent" | "updatePolicy" | "freezeVault" | ...
params: { ... }
vault?: "base58 vault address"
```

### `phalnx_advise` — AI reasoning support

Returns structured JSON guidance for deciding which tool to call next, diagnosing errors, comparing protocols, and checking capabilities.

```
question: "whatCanIDo" | "bestRouteFor" | "whyDidThisFail" | "shouldIRetry" | "protocolComparison"
context: { errorCode?, inputToken?, outputToken?, vault?, ... }
```

## Resources (7) — Contextual data via URI

| URI Template | Description |
|---|---|
| `shield://vault/{address}/policy` | Current policy configuration (JSON) |
| `shield://vault/{address}/spending` | Rolling 24h spending state (JSON) |
| `shield://vault/{address}/activity` | Recent transaction history (JSON) |
| `shield://vault/{address}/agents` | Agent permissions and status (JSON) |
| `shield://protocols` | All known DeFi protocols (JSON) |
| `shield://owner/{address}/vaults` | All vaults owned by an address (JSON) |
| `shield://tokens/{query}` | Search tokens by name/symbol (JSON) |

## Prompts (3) — Guided workflows

| Prompt | Description |
|---|---|
| `setup-vault` | Structured workflow for vault initialization |
| `safe-swap` | Pre-flight checklist for swap execution |
| `emergency-freeze` | Emergency response procedure |

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PHALNX_RPC_URL` | No | devnet | Solana RPC endpoint URL |
| `PHALNX_WALLET_PATH` | No | — | Path to Solana keypair JSON (vault owner) |
| `PHALNX_AGENT_KEYPAIR_PATH` | No | — | Path to agent keypair JSON |
| `PHALNX_MCP_MODE` | No | `v2` | Tool registration mode |

### PHALNX_MCP_MODE

| Mode | Tools | Use case |
|---|---|---|
| `v2` (default) | 5 intent-based tools | Claude Desktop, ChatGPT, Codex, Cursor |
| `legacy` | 71 `shield_*` tools | Backwards compatibility |
| `dual` | 76 tools (both sets) | Migration period |

### MCP Client Setup

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "phalnx": {
      "command": "npx",
      "args": ["@phalnx/mcp"],
      "env": {
        "PHALNX_RPC_URL": "https://api.devnet.solana.com"
      }
    }
  }
}
```

## Security Model

Phalnx uses a three-layer defense. A fully compromised machine **cannot extract your Solana private key**.

1. **Private Key in TEE Enclave** — key never touches your filesystem (Crossmint/Intel TDX, Turnkey/AWS Nitro, Privy/AWS Nitro)
2. **TEE Credentials in OS Keychain** — macOS Keychain, Windows Credential Manager, GNOME Keyring
3. **On-Chain Spending Caps and Vault Freeze** — enforced by Solana program, cannot be bypassed

**Mainnet Requirement:** Local keypair wallets are never permitted on mainnet-beta. TEE custody is required.

<details>
<summary>71 legacy shield_* tools (for backwards compatibility)</summary>

### Setup & Onboarding

| Tool | Description |
|---|---|
| `shield_setup_status` | Check current setup status |
| `shield_configure` | Set up Phalnx with full protection |
| `shield_configure_from_file` | Apply a pre-written JSON config file |
| `shield_fund_wallet` | Generate funding links |

### Read-Only

| Tool | Description |
|---|---|
| `shield_check_vault` | Check vault status and configuration |
| `shield_check_spending` | Check rolling 24h spending |
| `shield_check_pending_policy` | Check pending timelocked policy update |

### Owner-Signed (Write)

| Tool | Description |
|---|---|
| `shield_create_vault` | Create a new vault |
| `shield_deposit` | Deposit tokens into a vault |
| `shield_withdraw` | Withdraw tokens from a vault |
| `shield_register_agent` | Register an agent signing key |
| `shield_update_policy` | Update spending caps and allowlists |
| `shield_queue_policy_update` | Queue a timelocked policy change |
| `shield_apply_pending_policy` | Apply a queued policy change |
| `shield_cancel_pending_policy` | Cancel a queued policy change |
| `shield_revoke_agent` | Emergency kill switch |
| `shield_reactivate_vault` | Unfreeze a vault |
| `shield_provision` | Provision a vault via Solana Actions |

### Agent-Signed

| Tool | Description |
|---|---|
| `shield_execute_swap` | Execute a Jupiter token swap |
| `shield_agent_transfer` | Transfer tokens to allowlisted destination |
| `shield_open_position` | Open a Flash Trade perp position |
| `shield_close_position` | Close a Flash Trade perp position |
| `shield_increase_size` | Increase an existing position |
| `shield_decrease_size` | Decrease an existing position |
| `shield_add_collateral` | Add collateral to a position |
| `shield_remove_collateral` | Remove collateral from a position |
| `shield_place_trigger_order` | Place a trigger order |
| `shield_cancel_trigger_order` | Cancel a trigger order |
| `shield_place_limit_order` | Place a limit order |
| `shield_cancel_limit_order` | Cancel a limit order |
| `shield_sync_positions` | Sync vault open position counter |
| `shield_swap_and_open` | Swap token then open a position |
| `shield_close_and_swap` | Close position then swap output |
| `shield_lend_deposit` | Deposit into Jupiter Lend |
| `shield_lend_withdraw` | Withdraw from Jupiter Lend |
| `shield_create_trigger_order_jup` | Create a Jupiter trigger order |
| `shield_cancel_trigger_order_jup` | Cancel a Jupiter trigger order |
| `shield_create_recurring_order` | Create a Jupiter recurring order (DCA) |
| `shield_cancel_recurring_order` | Cancel a Jupiter recurring order |

### Read-Only (Jupiter)

| Tool | Description |
|---|---|
| `shield_get_prices` | Get token prices |
| `shield_search_tokens` | Search for tokens |
| `shield_trending_tokens` | Get trending tokens |
| `shield_lend_tokens` | Get available lend tokens/rates |
| `shield_get_trigger_orders_jup` | Get Jupiter trigger orders |
| `shield_get_recurring_orders` | Get Jupiter recurring orders |
| `shield_jupiter_portfolio` | Get portfolio overview |

### Squads V4 Multisig

| Tool | Description |
|---|---|
| `shield_squads_create_multisig` | Create a Squads multisig |
| `shield_squads_propose_action` | Propose a vault action |
| `shield_squads_approve` | Approve a proposal |
| `shield_squads_reject` | Reject a proposal |
| `shield_squads_execute` | Execute an approved transaction |
| `shield_squads_status` | Check multisig status |

### Utility

| Tool | Description |
|---|---|
| `shield_x402_fetch` | Fetch URL with x402 payment |

</details>

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests (472 tests)
pnpm test

# Smoke test
PHALNX_WALLET_PATH=~/.config/solana/id.json node dist/index.js
```

## Architecture

- **Transport**: stdio only (local subprocess of the AI tool)
- **SDK**: Wraps `PhalnxClient` from `@phalnx/sdk` — V2 tools delegate to intent engine, legacy tools delegate to individual handlers
- **Setup mode**: Starts without a wallet — `phalnx_setup` available until configured
- **Error handling**: All 77 Anchor error codes (6000-6076) mapped to human-readable messages with V2 tool name suggestions

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/phalnx/issues)

## License

Apache-2.0
