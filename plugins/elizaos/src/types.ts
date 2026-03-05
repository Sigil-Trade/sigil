/**
 * Environment variable keys used by the Phalnx ElizaOS plugin.
 * Configure these in your ElizaOS `.env` or character settings.
 */
export const ENV_KEYS = {
  /** Spending limit, e.g. "500 USDC/day" */
  MAX_SPEND: "PHALNX_MAX_SPEND",
  /** Block unknown programs: "true" or "false" (default: true) */
  BLOCK_UNKNOWN: "PHALNX_BLOCK_UNKNOWN",
  /** Solana RPC URL */
  RPC_URL: "SOLANA_RPC_URL",
  /** Solana wallet private key (base58 or JSON array) — not needed when using custody */
  WALLET_PRIVATE_KEY: "SOLANA_WALLET_PRIVATE_KEY",
  /** Custody provider: "crossmint", "turnkey", "privy" — if set, uses TEE-backed signing */
  CUSTODY_PROVIDER: "PHALNX_CUSTODY",
  /** Crossmint server-side API key (required when CUSTODY=crossmint) */
  CROSSMINT_API_KEY: "CROSSMINT_API_KEY",
  /** Crossmint wallet locator (optional — creates new wallet if omitted) */
  CROSSMINT_LOCATOR: "CROSSMINT_WALLET_LOCATOR",
} as const;

/** Supported custody provider identifiers. */
export type CustodyProvider = "crossmint" | "turnkey" | "privy";

export interface PhalnxElizaConfig {
  maxSpend?: string;
  blockUnknown: boolean;
  /** Raw private key — used when no custody provider is set. */
  walletPrivateKey?: string;
  /** TEE custody provider — when set, walletPrivateKey is not required. */
  custodyProvider?: CustodyProvider;
  /** Crossmint API key (when custodyProvider = "crossmint") */
  crossmintApiKey?: string;
  /** Crossmint wallet locator (when custodyProvider = "crossmint") */
  crossmintLocator?: string;
}
