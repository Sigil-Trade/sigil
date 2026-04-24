/**
 * `@usesigil/kit/agent-bootstrap` — Handoff-prompt composition.
 *
 * FE↔BE contract v2.2 commitment C5. Produces the canonical prompt text
 * that gets pasted into Claude Desktop / ChatGPT / CLI agents after a
 * vault is created. Centralizing the template here means the CLI, the
 * MCP server, and the dashboard `/onboard/complete` screen all emit
 * WORD-IDENTICAL handoff text — no drift, no re-interpretation.
 *
 * FE is free to render the prompt in any format (plain text paste, JSON
 * bundle with MCP endpoint, Claude Desktop deep-link). This module only
 * owns the prompt STRING; formatting is the caller's responsibility.
 *
 * @see FRONTEND-BACKEND-CONTRACT.md §3.4 — handoff prompt UX
 * @see FRONTEND-BACKEND-CONTRACT.md §5a C5 — commitment text
 */

import type { Network } from "./types.js";

/**
 * Canonical handoff-prompt template. Uses `${placeholder}` slots for the
 * vault-specific data. Consumers either call `composeAgentBootstrap()`
 * (which fills the slots from a VaultConfig) or call
 * `getHandoffPromptTemplate()` and do their own substitution.
 *
 * The template is intentionally plain prose — it's going into an LLM's
 * context window, and structured markup like JSON front-matter or
 * XML-style tags adds noise without improving comprehension. The
 * imperative voice ("Use the Sigil MCP tool...") is deliberate: it
 * primes the model to reach for the right tool without being verbose.
 *
 * `${placeholder}` names:
 *   - network          — "devnet" | "mainnet-beta"
 *   - agentAddress     — the agent wallet's base58 pubkey
 *   - vaultAddress     — the vault PDA base58 pubkey
 *   - ownerAddress     — the owner wallet's base58 pubkey
 *   - dailyLimitUsd    — human-readable USD amount (e.g., "$500")
 *   - protocolNames    — comma-separated friendly names
 *   - capabilityNames  — comma-separated capability labels
 */
const HANDOFF_PROMPT_TEMPLATE = `You are an autonomous agent operating a Sigil vault on \${network}.

Your wallet: \${agentAddress}
The vault you control: \${vaultAddress}
Your owner's wallet (read-only reference): \${ownerAddress}

Daily spending limit: \${dailyLimitUsd}
Approved protocols: \${protocolNames}
Permissions: \${capabilityNames}

Use the Sigil MCP tool \`seal_transaction\` to execute any on-chain action.
The vault will reject any tx that exceeds the rules above — this is by design.

If you need help, use \`request_help\` to surface a question to your owner.`;

/**
 * Return the canonical handoff-prompt template string with
 * `${placeholder}` slots intact. Consumers that want to do their own
 * substitution (e.g., localize the template, inject extra context) call
 * this and interpolate themselves. Most consumers should use
 * `composeAgentBootstrap()` instead.
 *
 * Return value is a stable string — calling this multiple times returns
 * the exact same text.
 */
export function getHandoffPromptTemplate(): string {
  return HANDOFF_PROMPT_TEMPLATE;
}

/**
 * Map a Sigil capability tier (0 / 1 / 2) to the friendly names used in
 * the handoff prompt. Mirrors the internal `CAPABILITY_GRANTS` table at
 * `src/advanced-analytics.ts:490`.
 *
 *  - `0` = Disabled (no permissions; agent shouldn't be registered)
 *  - `1` = Observer (NonSpending actions only)
 *  - `2` = Operator (Spending + NonSpending)
 *
 * Invalid tiers return an empty array — the caller sees "Permissions: "
 * (empty) rather than a crash. That's still a failure signal but a
 * non-blocking one.
 */
export function capabilityTierToNames(tier: number): readonly string[] {
  switch (tier) {
    case 0:
      return [];
    case 1:
      return ["NonSpending"];
    case 2:
      return ["Spending", "NonSpending"];
    default:
      return [];
  }
}

/**
 * Input to `composeAgentBootstrap()`. Shape matches what the FE already
 * has in scope at the `/onboard/complete` handoff screen (per §3.4):
 *
 *   - `vaultAddress` / `agentAddress` / `ownerAddress` — base58 pubkeys.
 *   - `network` — cluster the vault was deployed to.
 *   - `dailyLimitUsd` — 6-decimal USD bigint (e.g., 500_000_000n for $500).
 *     Formatted into "$X" in the prompt.
 *   - `approvedProtocols` — array of friendly protocol names (caller
 *     resolves via `resolveProtocolName()` or the new
 *     `lookupProtocolAnnotation()`).
 *   - `capabilityTier` — the agent's capability number (0/1/2).
 */
export interface AgentBootstrapConfig {
  readonly vaultAddress: string;
  readonly agentAddress: string;
  readonly ownerAddress: string;
  readonly network: Network;
  readonly dailyLimitUsd: bigint;
  readonly approvedProtocols: readonly string[];
  readonly capabilityTier: number;
}

/**
 * Output of `composeAgentBootstrap()`. Same identifiers the FE already
 * has in scope — the interesting additions are:
 *
 *   - `onboardingPrompt` — fully-substituted template, ready to paste
 *     into Claude Desktop / ChatGPT / CLI.
 *   - `capabilities` — friendly capability names (derived from the
 *     `capabilityTier`), surfaced separately so FE can render a chip
 *     list alongside the raw prompt.
 */
export interface AgentBootstrap {
  readonly agentWallet: string;
  readonly vaultPubkey: string;
  readonly onboardingPrompt: string;
  readonly capabilities: readonly string[];
}

/**
 * Format a 6-decimal USD bigint as `"$X"` for the prompt.
 *
 *   500_000_000n → "$500"
 *   750_000_000n → "$750"
 *     100_500_000n → "$100.50"
 *
 * Keeps fractional cents only when non-zero; avoids `"$500.00"` visual
 * noise for round amounts. Not a general-purpose formatter — caller
 * should use `formatUsd()` elsewhere.
 */
function formatDailyLimitUsd(amount: bigint): string {
  const dollars = amount / 1_000_000n;
  const fractional = amount % 1_000_000n;
  if (fractional === 0n) return `$${dollars.toString()}`;
  // 6-decimal USD — cents are the leading two digits of the micro remainder.
  // Trim trailing zeros from the fractional representation so $100.50 stays
  // readable but $100.500000 doesn't happen.
  const fracStr = fractional.toString().padStart(6, "0").replace(/0+$/, "");
  return `$${dollars.toString()}.${fracStr}`;
}

/**
 * Compose the handoff-prompt bundle for a freshly-created vault.
 *
 * Fills the template's `${placeholder}` slots with vault-specific data
 * and returns both the rendered prompt AND the structured fields the FE
 * wants to display separately (capability chips, pubkey truncation, etc.).
 *
 * ## Determinism
 *
 * Given identical input, the output is byte-identical across calls. The
 * prompt string has no timestamps, no random suffixes, no whitespace
 * drift — pasting into two separate LLM contexts produces the same
 * conversation seed.
 *
 * ## What it does NOT do
 *
 * - No RPC fetch. Input is already in FE scope by the time this runs.
 * - No capability-bitmask decoding. `capabilityTier` is a small int
 *   (0/1/2); the FE provides it from `AgentEntry.capability`.
 * - No localization. Prompt text is English-only — LLMs handle
 *   translation downstream if needed.
 *
 * @example
 * ```ts
 * const bootstrap = composeAgentBootstrap({
 *   vaultAddress: "VAULT...",
 *   agentAddress: "AGENT...",
 *   ownerAddress: "OWNER...",
 *   network: "devnet",
 *   dailyLimitUsd: 500_000_000n,
 *   approvedProtocols: ["Jupiter", "Flash Trade"],
 *   capabilityTier: 2,
 * });
 * console.log(bootstrap.onboardingPrompt); // full prompt for Claude Desktop
 * ```
 */
export function composeAgentBootstrap(
  config: AgentBootstrapConfig,
): AgentBootstrap {
  const capabilities = capabilityTierToNames(config.capabilityTier);
  const dailyLimitUsd = formatDailyLimitUsd(config.dailyLimitUsd);
  const protocolNames = config.approvedProtocols.join(", ");
  const capabilityNames = capabilities.join(", ");

  const onboardingPrompt = HANDOFF_PROMPT_TEMPLATE.replace(
    /\$\{network\}/g,
    config.network,
  )
    .replace(/\$\{agentAddress\}/g, config.agentAddress)
    .replace(/\$\{vaultAddress\}/g, config.vaultAddress)
    .replace(/\$\{ownerAddress\}/g, config.ownerAddress)
    .replace(/\$\{dailyLimitUsd\}/g, dailyLimitUsd)
    .replace(/\$\{protocolNames\}/g, protocolNames)
    .replace(/\$\{capabilityNames\}/g, capabilityNames);

  return {
    agentWallet: config.agentAddress,
    vaultPubkey: config.vaultAddress,
    onboardingPrompt,
    capabilities,
  };
}
