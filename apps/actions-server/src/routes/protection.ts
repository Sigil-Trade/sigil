import { Hono } from "hono";
import {
  TEMPLATES,
  type TemplateName,
  type TemplateConfig,
} from "../lib/templates";

const protection = new Hono();

/**
 * CORS headers for API endpoints (non-Action — no X-Action-Version needed).
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

interface TemplateInfo {
  name: string;
  label: string;
  description: string;
  dailyCapUsd: number;
  maxTxUsd: number;
  protocols: string[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
}

interface ProtectionResponse {
  protection: {
    name: string;
    description: string;
    layers: string[];
    cost: string;
    setupTime: string;
    features: string[];
  };
  templates: TemplateInfo[];
}

/**
 * GET /api/actions/protection — Returns Phalnx protection model and templates.
 *
 * Pure data endpoint — no heavy dependencies, no blockchain calls.
 * Suitable for marketing pages, developer portals, and integration docs.
 */
protection.get("/api/actions/protection", (c) => {
  const response: ProtectionResponse = {
    protection: {
      name: "Phalnx",
      description:
        "On-chain guardrails for AI agents on Solana. Your policies are " +
        "enforced by Solana validators, not software promises. Even fully " +
        "compromised agent software cannot bypass policy — enforcement happens " +
        "at the blockchain level with owner kill-switch authority.",
      layers: [
        "Client-side policy checks (fast deny)",
        "TEE key custody (hardware enclave protection)",
        "On-chain vault enforcement (blockchain-enforced policies)",
      ],
      cost: "~0.003 SOL (~$0.50)",
      setupTime: "~2 minutes",
      features: [
        "On-chain PDA vault with cryptographic policy enforcement",
        "TEE key custody (Crossmint, Turnkey, Privy)",
        "Spending caps (rolling 24h window, USD-denominated)",
        "Protocol whitelists (Jupiter, Flash Trade, Orca, Raydium)",
        "Owner kill-switch (revoke agent instantly)",
        "Immutable fee destination (cannot be redirected)",
        "Stablecoin-only USD tracking with on-chain slippage enforcement",
        "On-chain audit trail (Anchor events + SpendTracker)",
        "Timelocked policy updates for institutional guardrails",
        "Ephemeral session authority (20-slot expiry, prevents replay)",
        "Rate limiting and custom policy hooks",
        "Event callbacks (onDenied, onApproved, onPause)",
      ],
    },
    templates: Object.entries(TEMPLATES).map(
      ([name, config]: [string, TemplateConfig]) => ({
        name,
        label: config.label,
        description: config.description,
        dailyCapUsd: config.dailyCapUsd,
        maxTxUsd: config.maxTxUsd,
        protocols: config.protocols,
        maxLeverageBps: config.maxLeverageBps,
        maxConcurrentPositions: config.maxConcurrentPositions,
      }),
    ),
  };

  return c.json(response, 200, CORS_HEADERS);
});

protection.options("/api/actions/protection", (c) => {
  return c.body(null, 200, CORS_HEADERS);
});

export { protection };
