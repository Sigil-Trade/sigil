# @usesigil/agent

**Sigil for AI** — bounded Solana agent toolkit. An MCP server that gives any AI runtime typed tools to operate on a Sigil-policy-protected vault.

## Install

Pasted once into your AI runtime's MCP config:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "npx",
      "args": ["-y", "@usesigil/agent"]
    }
  }
}
```

Works in Claude Desktop, Claude Code, Cursor, Continue, Cline, Goose, and any other MCP-aware client.

## First-time setup

> **Day-3 status:** the `setup` subcommand is the next thing landing. For v0.1 you manually drop a config at `~/.sigil/agents/<vault>.json`:
>
> ```json
> {
>   "vaultAddress": "BoGepFQLEk4ngixTLXjjg7bnzyitz6mS6c5A5DSmYP4Y",
>   "ownerAddress": "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
>   "network": "devnet",
>   "agent": {
>     "address": "DwmYTNLnncoQVMyWHr7yYYx86kkEsCp7NJSjKhDBKshS",
>     "secretKey": [/* 64-byte Solana CLI keypair format */]
>   },
>   "createdAt": "2026-05-10T00:00:00.000Z"
> }
> ```

## Available tools (v0.1)

- `get_vault_state` — current on-chain state: owner, status, balance, P&L, health checks

Coming in v0.2:
- `get_policy`, `get_remaining_cap`, `get_recent_activity`
- `seal_swap`, `seal_lend`, `seal_withdraw`, `seal_transfer`
- `npx @usesigil/agent setup` first-run wizard

## How it relates to the rest of the stack

- **`@usesigil/kit`** — the Solana SDK that builds and seals transactions
- **`@usesigil/agent`** — this package, an MCP server wrapping the kit for AI runtimes
- **app.sigil.trade** — the dashboard where vault owners create vaults, set policies, and authorize agents

The agent operates within the bounds the owner sets in the dashboard. The on-chain Sigil program enforces the bounds — this MCP server is just the runtime contract between the AI and the chain.

## License

MIT
