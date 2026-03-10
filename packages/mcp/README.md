# @phalnx/mcp

MCP (Model Context Protocol) server for Phalnx. Lets any MCP-compatible AI tool — Claude Desktop, Cursor, Windsurf — manage on-chain Solana vaults and enforce DeFi policies via natural language.

## Installation

```bash
npm install -g @phalnx/mcp
# or run directly
npx @phalnx/mcp
```

## Security Model

Phalnx uses a three-layer defense. A fully compromised machine **cannot extract your Solana private key**.

### Layer 1 — Private Key in TEE Enclave

Your agent's Solana private key lives exclusively in a remote hardware enclave. It never touches your filesystem.

| Provider  | Enclave   | Attestation                             |
| --------- | --------- | --------------------------------------- |
| Crossmint | Intel TDX | Provider-verified                       |
| Turnkey   | AWS Nitro | Cryptographically verified (PCR values) |
| Privy     | AWS Nitro | Provider-verified                       |

An attacker with full read access to your machine finds no key to steal — it doesn't exist there.

### Layer 2 — TEE Credentials in OS Keychain

API credentials (Crossmint API key, Turnkey API key, Privy app secret) are stored in the OS keychain:

- **macOS**: Keychain Access — requires login password or Touch ID
- **Windows**: Windows Credential Manager — requires Windows Hello / PIN
- **Linux**: GNOME Keyring / KWallet — requires session password

Credentials are never written to `config.json` or shell profiles. `shield_configure` saves them to the keychain on first run; `resolveClient()` reads from the keychain at runtime.

**If credentials are stolen**: the attacker can sign transactions through the enclave, but only up to your configured daily cap before you freeze the vault via `shield_revoke_agent`.

### Layer 3 — On-Chain Spending Caps and Vault Freeze

Even if Layers 1 and 2 are both compromised, the Phalnx vault provides a blockchain backstop:

- **Daily spending cap**: enforced by the Solana program, cannot be bypassed
- **Vault freeze**: `shield_revoke_agent` freezes the vault instantly from any machine
- **Protocol allowlist**: agent can only call pre-approved DeFi programs

### Cross-Device Design

This model works identically on any device. The Solana private key is always in the remote enclave. TEE credentials are protected by the device's biometric or PIN. On-chain caps limit the blast radius even in the worst case.

### Mainnet Requirement

**Local keypair wallets are never permitted on mainnet-beta.** `shield_configure` will return a hard error. `resolveClient()` will throw. This is enforced at both the config-load level and the tool level.

For devnet, local keypairs are allowed but every tool call prepends a visible warning.

## Quickstart

1. Install and add to your MCP client (see Configuration below)
2. Ask your AI assistant: _"What's my Phalnx setup status?"_ — it will call `shield_setup_status`
3. Follow the guided flow: _"Set up Phalnx"_ — the assistant walks you through wallet creation and policy configuration
4. For programmatic/CI deployments, use `shield_configure_from_file` with a pre-written JSON config

## Configuration

### Environment Variables

| Variable                    | Required | Default | Description                                                                                       |
| --------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `PHALNX_WALLET_PATH`        | No       | —       | Path to Solana keypair JSON (vault owner). Not required — server starts in setup mode without it. |
| `PHALNX_RPC_URL`            | No       | devnet  | Solana RPC endpoint URL                                                                           |
| `PHALNX_AGENT_KEYPAIR_PATH` | No       | —       | Path to agent keypair JSON (needed for swap/position tools)                                       |

### TEE Provisioning

When you run `shield_configure`, Phalnx provisions a TEE (Trusted Execution Environment) wallet to protect your agent's private key. It tries providers in this order:

1. **Local Privy** — if `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are set
2. **Local Turnkey** — if `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_KEY_ID`, and `TURNKEY_API_PRIVATE_KEY` are set
3. **Local Crossmint** — if `CROSSMINT_API_KEY` is set (easiest to get started)
4. **Hosted Phalnx API** — fallback; no env vars needed, but requires internet access

| Provider  | Env Vars Required                                                          |
| --------- | -------------------------------------------------------------------------- |
| Crossmint | `CROSSMINT_API_KEY`                                                        |
| Turnkey   | `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_KEY_ID`, `TURNKEY_API_PRIVATE_KEY` |
| Privy     | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`                                         |

**Devnet note:** TEE attestation is not enforced on devnet. For local testing, you can skip TEE entirely by using `unsafeSkipTeeCheck: true` in the SDK.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "phalnx": {
      "command": "npx",
      "args": ["@phalnx/mcp"],
      "env": {
        "PHALNX_WALLET_PATH": "~/.config/solana/id.json",
        "PHALNX_RPC_URL": "https://api.devnet.solana.com"
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
    "phalnx": {
      "command": "npx",
      "args": ["@phalnx/mcp"],
      "env": {
        "PHALNX_WALLET_PATH": "~/.config/solana/id.json"
      }
    }
  }
}
```

## Tools (49)

### Setup & Onboarding (always available — no wallet required)

| Tool                         | Description                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `shield_setup_status`        | Check current setup status — which layers are active                          |
| `shield_configure`           | Set up Phalnx with full protection (Shield + TEE + Vault)                     |
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

### Agent-Signed (Requires `PHALNX_AGENT_KEYPAIR_PATH`)

| Tool                              | Description                                     |
| --------------------------------- | ----------------------------------------------- |
| `shield_execute_swap`             | Execute a Jupiter token swap through the vault  |
| `shield_agent_transfer`           | Transfer tokens to an allowlisted destination   |
| `shield_open_position`            | Open a Flash Trade leveraged perpetual position |
| `shield_close_position`           | Close a Flash Trade perpetual position          |
| `shield_increase_size`            | Increase an existing Flash Trade position       |
| `shield_decrease_size`            | Decrease an existing Flash Trade position       |
| `shield_add_collateral`           | Add collateral to a Flash Trade position        |
| `shield_remove_collateral`        | Remove collateral from a Flash Trade position   |
| `shield_place_trigger_order`      | Place a trigger order (take-profit/stop-loss)   |
| `shield_cancel_trigger_order`     | Cancel a trigger order                          |
| `shield_place_limit_order`        | Place a limit order                             |
| `shield_cancel_limit_order`       | Cancel a limit order                            |
| `shield_sync_positions`           | Sync vault open position counter                |
| `shield_swap_and_open`            | Swap token then open a Flash Trade position     |
| `shield_close_and_swap`           | Close a Flash Trade position then swap output   |
| `shield_lend_deposit`             | Deposit into Jupiter Lend                       |
| `shield_lend_withdraw`            | Withdraw from Jupiter Lend                      |
| `shield_create_trigger_order_jup` | Create a Jupiter trigger order                  |
| `shield_cancel_trigger_order_jup` | Cancel a Jupiter trigger order                  |
| `shield_create_recurring_order`   | Create a Jupiter recurring order (DCA)          |
| `shield_cancel_recurring_order`   | Cancel a Jupiter recurring order                |

### Read-Only (Jupiter)

| Tool                            | Description                               |
| ------------------------------- | ----------------------------------------- |
| `shield_get_prices`             | Get token prices from Jupiter             |
| `shield_search_tokens`          | Search for tokens by name or symbol       |
| `shield_trending_tokens`        | Get trending tokens from Jupiter          |
| `shield_lend_tokens`            | Get available Jupiter Lend tokens/rates   |
| `shield_get_trigger_orders_jup` | Get Jupiter trigger orders for a wallet   |
| `shield_get_recurring_orders`   | Get Jupiter recurring orders for a wallet |
| `shield_jupiter_portfolio`      | Get portfolio overview from Jupiter       |

### Squads V4 Multisig Governance

| Tool                            | Description                              |
| ------------------------------- | ---------------------------------------- |
| `shield_squads_create_multisig` | Create a Squads multisig                 |
| `shield_squads_propose_action`  | Propose a vault action via multisig      |
| `shield_squads_approve`         | Approve a multisig proposal              |
| `shield_squads_reject`          | Reject a multisig proposal               |
| `shield_squads_execute`         | Execute an approved multisig transaction |
| `shield_squads_status`          | Check multisig and proposal status       |

### Utility

| Tool                | Description                                         |
| ------------------- | --------------------------------------------------- |
| `shield_x402_fetch` | Fetch a URL with automatic x402 payment negotiation |

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

# Run tests (355 tests)
pnpm test

# Smoke test
PHALNX_WALLET_PATH=~/.config/solana/id.json node dist/index.js
```

## Architecture

- **Transport**: stdio only (local subprocess of the AI tool)
- **Credentials**: Environment variables (keypair file paths)
- **SDK**: Wraps `PhalnxClient` from `@phalnx/sdk` — every tool delegates to a client method
- **Setup mode**: Starts without a wallet — only setup/onboarding tools available until configured
- **Programmatic config**: `shield_configure_from_file` reads a JSON config matching the `ShieldLocalConfig` schema — for CI/CD pipelines and orchestrator platforms where interactive setup is not practical
- **Local config**: `~/.phalnx/config.json` stores wallet, layer status, and policy state across sessions
- **Error handling**: All 46 Anchor error codes (6000-6045) mapped to human-readable messages with actionable suggestions

## Support

- X/Twitter: [@MightieMags](https://x.com/MightieMags)
- Telegram: [MightyMags](https://t.me/MightyMags)
- Issues: [GitHub Issues](https://github.com/Kaleb-Rupe/phalnx/issues)

## License

Apache-2.0
