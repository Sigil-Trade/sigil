---
name: agent-shield
description: Financial guardrails for AI agents — spending caps, protocol whitelists, real-time monitoring
homepage: https://agentshield.xyz
user-invocable: true
command-dispatch: tool
command-tool: shield_status
metadata:
  openclaw:
    requires:
      bins: ["node"]
      env: ["AGENTSHIELD_WALLET_PATH"]
    os: ["darwin", "linux"]
---

# AgentShield Skill

You have access to AgentShield tools that enforce financial guardrails on your Solana trading activity. These tools ensure you never exceed spending limits, only trade on approved protocols, and maintain a full audit trail.

## Available Tools

| Tool | Purpose |
|------|---------|
| `shield_check_vault` | Check vault status and current policy |
| `shield_check_spending` | View rolling 24h spend and remaining budget |
| `shield_create_vault` | Create a new vault with policy |
| `shield_update_policy` | Update vault policy (immediate if no timelock) |
| `shield_register_agent` | Register your signing key to a vault |
| `shield_deposit` | Deposit tokens into a vault |
| `shield_withdraw` | Withdraw tokens (owner-only) |
| `shield_revoke_agent` | Emergency kill switch — revoke agent and freeze vault |
| `shield_reactivate_vault` | Reactivate a frozen vault |
| `shield_execute_swap` | Execute a Jupiter swap through the vault |
| `shield_open_position` | Open a leveraged position via Flash Trade |
| `shield_close_position` | Close a leveraged position |
| `shield_provision` | Generate a Blink URL for one-click vault creation |
| `shield_queue_policy_update` | Queue a timelocked policy change |
| `shield_apply_pending_policy` | Execute a queued policy after timelock expires |
| `shield_cancel_pending_policy` | Cancel a pending policy change |
| `shield_check_pending_policy` | View current pending policy state |
| `shield_agent_transfer` | Transfer tokens from vault to an allowed destination |

## Core Rules

1. **Always check before trading.** Before any swap or position over $100, call `shield_check_spending` to verify remaining budget.
2. **Use shielded execution.** Use `shield_execute_swap` instead of raw Jupiter instructions. This routes through the vault's policy enforcement.
3. **Report budget on request.** When asked about trading capacity, call `shield_check_spending` and report the remaining daily allowance.
4. **Never bypass limits.** If a trade is denied, explain why (cap exceeded, token not allowed, etc.) and suggest alternatives.
5. **Provision via Blink.** When a user needs a new vault, use `shield_provision` to generate a Blink link — never attempt to create a vault without user wallet approval.

## Vault Onboarding Flow

When a user wants to set up trading or mentions they need a protected wallet:

1. Check if a vault already exists: call `shield_check_vault`
2. If no vault, start the conversation:
   - Ask about daily spending tolerance (suggest $500 as safe default)
   - Ask which protocols they want (suggest Jupiter for beginners)
   - Ask about leverage (suggest none for beginners)
3. Map their answers to a template or custom params:
   - "keep it safe" / "conservative" → conservative template ($500/day, Jupiter only, no leverage)
   - "moderate" / "balanced" → moderate template ($2,000/day, Jupiter + Orca + Raydium + Meteora, 2x leverage)
   - "aggressive" / "all in" → aggressive template ($10,000/day, all protocols, 5x leverage)
4. Call `shield_provision` with the right template + your agent pubkey
5. Present the Blink URL with a clear summary of what they are approving
6. After they sign, poll status until confirmed
7. Confirm the vault is ready and explain next steps (funding)

Always ask about risk tolerance before generating the Blink. Never generate a Blink without user confirmation of the settings.

## Policy Updates with Timelock

If the vault has a timelock configured (timelock_duration > 0):
1. Call `shield_queue_policy_update` instead of `shield_update_policy`
2. Tell the user: "Policy change queued. It will take effect in [X hours]."
3. If the user wants to cancel: call `shield_cancel_pending_policy`
4. When the timelock expires: call `shield_apply_pending_policy`
5. Check status anytime: call `shield_check_pending_policy`

Never attempt to bypass the timelock — it exists to protect the user.

## Agent Transfers

Use `shield_agent_transfer` to send tokens from the vault to a destination address. The destination must be in the vault's allowed destinations list (if configured). This is useful for paying bills, funding other wallets, or moving profits out of the vault.

## Error Handling

When a tool returns an error:
- **DailyCapExceeded**: Tell the user their daily limit is reached. Show remaining time until reset.
- **TokenNotAllowed**: Suggest adding the token via policy update, or use an allowed token.
- **ProtocolNotAllowed**: Suggest adding the protocol, or route through an allowed one.
- **TransactionTooLarge**: Suggest splitting into smaller amounts.
- **LeverageTooHigh**: Suggest reducing leverage or updating the policy.
- **VaultNotActive**: The vault is frozen. Suggest using `shield_reactivate_vault`.
