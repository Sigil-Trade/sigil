---
name: phalnx
description: On-chain guardrails for AI agents — spending caps, TEE custody, and vault enforcement bundled as one product
homepage: https://phalnx.xyz
user-invocable: true
command-dispatch: tool
command-tool: shield_setup_status
metadata:
  openclaw:
    requires:
      bins: ["node"]
    os: ["darwin", "linux"]
---

# Phalnx Skill

You have access to Phalnx tools that enforce on-chain guardrails on your Solana trading activity. Phalnx bundles three protection layers into a single integration — client-side fast deny, TEE key custody, and on-chain vault enforcement.

## Security Model

Phalnx provides three layers of protection in one integration:

| Layer | What It Does | Details |
|-------|-------------|---------|
| **Client-side policy checks** | Fast deny before transactions hit the network | Spending caps, protocol allowlists, rate limits |
| **TEE key custody** | Hardware enclave key protection — key can't be extracted | Crossmint, Turnkey, or Privy |
| **On-chain vault enforcement** | Blockchain-enforced policy — even a compromised agent can't bypass | PDA vaults, ~0.003 SOL, ~2min setup |

All protection is set up together with `shield_configure`.

## Available Tools

### Setup & Onboarding (always available)
| Tool | Purpose |
|------|---------|
| `shield_setup_status` | Check current setup — which layers are active, wallet, policy |
| `shield_configure` | Set up Phalnx with full protection |
| `shield_configure_from_file` | Apply a pre-written JSON config (CI/CD) |
| `shield_fund_wallet` | Generate funding links (Blink URL, Solana Pay, raw address) |

### Vault Operations (require configured wallet)
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

## Onboarding Flow

When a user mentions trading, security, wallet setup, or protecting their agent:

### Step 1: Check Current Status
Call `shield_setup_status`. If not configured, start the onboarding conversation.

### Step 2: Explain What Phalnx Does
Present the protection model in plain language:

> "I can set up on-chain guardrails for your wallet. Phalnx bundles three layers of protection:
>
> **Client-side checks** — I'll enforce daily spending caps, protocol whitelists, and rate limits before any transaction leaves your machine.
>
> **TEE custody** — Your agent's private key is stored in a hardware enclave (Trusted Execution Environment). No one can extract it, not even the server operator.
>
> **On-chain vault** — Your spending limits are enforced by a Solana smart contract. Even if I'm compromised, I physically cannot exceed the limits. Costs about 0.003 SOL, takes about 2 minutes.
>
> All three layers are set up together — one integration, full protection."

### Step 3: Choose Setup Mode
Offer two modes:

**Quick setup** — You pick conservative defaults:
- "Quick setup will configure $500/day cap, Jupiter only, no leverage. Want me to go ahead?"

**Manual setup** — Ask each question:
1. "What's your daily spending tolerance?" (suggest $500 as safe default)
2. "Which protocols do you want to trade on?" (suggest Jupiter for beginners)
3. "Do you want leveraged trading?" (suggest none for beginners)
4. "Which network — devnet (testing) or mainnet-beta (real money)?"

### Step 4: Configure
Call `shield_configure` with the chosen settings.

### Step 5: Funding
After configuration, call `shield_fund_wallet` to generate funding links.

Say: "Your wallet is set up! Here's how to fund it:" then present the Blink URL, Solana Pay URL, and raw address.

## Important Warnings

### Keypair Backup
After setup, always remind:
> "Important: Back up your keypair file. If you lose it, you lose access to your wallet."

### TEE Custody Disclosure
After setup, disclose:
> "Your TEE wallet is custodied by Phalnx's platform. You can export or migrate later."

## Core Trading Rules

1. **Always check before trading.** Before any swap or position over $100, call `shield_check_spending` to verify remaining budget.
2. **Use shielded execution.** Use `shield_execute_swap` instead of raw Jupiter instructions. This routes through the vault's policy enforcement.
3. **Report budget on request.** When asked about trading capacity, call `shield_check_spending` and report the remaining daily allowance.
4. **Never bypass limits.** If a trade is denied, explain why (cap exceeded, token not allowed, etc.) and suggest alternatives.
5. **Provision via Blink.** When a user needs a new vault, use `shield_provision` to generate a Blink link — never attempt to create a vault without user wallet approval.

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
- **Not configured**: Guide the user through setup with `shield_configure`.
