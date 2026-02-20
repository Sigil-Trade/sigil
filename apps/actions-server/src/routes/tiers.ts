import { Hono } from "hono";
import {
  TEMPLATES,
  type TemplateName,
  type TemplateConfig,
} from "../lib/templates";

const tiers = new Hono();

/**
 * CORS headers for API endpoints (non-Action — no X-Action-Version needed).
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

interface TierInfo {
  tier: number;
  name: string;
  label: string;
  description: string;
  security: string;
  cost: string;
  setupTime: string;
  enforcement: string;
  recommended: boolean;
  features: string[];
  limitations: string[];
}

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

interface TiersResponse {
  tiers: TierInfo[];
  templates: TemplateInfo[];
  recommendation: string;
}

/**
 * GET /api/actions/tiers — Returns tier comparison and template data.
 *
 * Pure data endpoint — no heavy dependencies, no blockchain calls.
 * Suitable for marketing pages, developer portals, and integration docs.
 */
tiers.get("/api/actions/tiers", (c) => {
  const response: TiersResponse = {
    tiers: [
      {
        tier: 1,
        name: "shield",
        label: "Shield",
        description:
          "Client-side spending controls. Useful for development and testing, " +
          "but provides no protection against compromised agent software.",
        security: "Software-only — bypassable if agent runtime is compromised",
        cost: "Free",
        setupTime: "Instant",
        enforcement: "Client-side (in-memory)",
        recommended: false,
        features: [
          "Spending caps (rolling 24h window)",
          "Protocol whitelists",
          "Rate limiting",
          "Custom policy hooks",
          "Event callbacks (onDenied, onApproved, onPause)",
        ],
        limitations: [
          "No key protection — private key stored in plaintext",
          "No cryptographic guarantee — policies enforced in software only",
          "Bypassable by compromised agent code or host machine access",
          "Not suitable for production use with real funds",
        ],
      },
      {
        tier: 2,
        name: "shield_tee",
        label: "Shield + TEE",
        description:
          "Hardware enclave key protection on top of Shield controls. " +
          "Agent's private key is stored in a Trusted Execution Environment — " +
          "it cannot be extracted, even by the server operator.",
        security:
          "Hardware-backed key isolation — key never leaves the enclave",
        cost: "Free",
        setupTime: "~30 seconds",
        enforcement: "Client-side + hardware key custody",
        recommended: false,
        features: [
          "All Shield (Tier 1) features",
          "Private key stored in hardware enclave (TEE)",
          "Key cannot be extracted or copied",
          "Custody provider manages key lifecycle",
        ],
        limitations: [
          "Spending policies still enforced client-side only",
          "Relies on custody provider availability (Crossmint, Turnkey, Privy)",
          "No on-chain audit trail",
          "Compromised agent software can still exceed limits (policies not cryptographically enforced)",
        ],
      },
      {
        tier: 3,
        name: "shield_tee_vault",
        label: "Shield + TEE + Vault",
        description:
          "Full cryptographic protection. On-chain Solana program enforces " +
          "spending limits, protocol whitelists, and leverage caps. Even fully " +
          "compromised agent software cannot bypass policy — enforcement happens " +
          "at the blockchain level with owner kill-switch authority.",
        security:
          "Blockchain-enforced — policies are cryptographic guarantees, not software promises",
        cost: "~0.003 SOL (~$0.50)",
        setupTime: "~2 minutes",
        enforcement: "Client-side + hardware custody + on-chain program",
        recommended: true,
        features: [
          "All Shield + TEE features",
          "On-chain PDA vault with cryptographic policy enforcement",
          "Owner kill-switch (revoke agent instantly)",
          "Immutable fee destination (cannot be redirected)",
          "Rolling 24h spending windows enforced by Solana runtime",
          "Per-token and USD-denominated caps",
          "Dual-oracle price feeds (Pyth + Switchboard)",
          "On-chain audit trail (Anchor events + SpendTracker)",
          "Timelocked policy updates for institutional governance",
          "Ephemeral session authority (20-slot expiry, prevents replay)",
          "Multi-protocol composition (Jupiter, Flash Trade, Orca, Raydium)",
        ],
        limitations: [
          "Requires SOL for account rent (~0.003 SOL)",
          "Owner must sign vault creation transaction",
          "Funds must be deposited into vault PDA",
        ],
      },
    ],
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
    recommendation:
      "For any deployment handling real funds, use Tier 3 (Shield + TEE + Vault). " +
      "Client-side controls (Tier 1) are useful for development but provide no " +
      "cryptographic guarantees. TEE (Tier 2) protects key confidentiality but " +
      "not agent intent — a compromised agent can still exceed spending limits. " +
      "Only Tier 3 enforces policies at the blockchain level where they cannot " +
      "be bypassed regardless of agent software state.",
  };

  return c.json(response, 200, CORS_HEADERS);
});

tiers.options("/api/actions/tiers", (c) => {
  return c.body(null, 200, CORS_HEADERS);
});

export { tiers };
