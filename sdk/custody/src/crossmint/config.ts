/**
 * Configuration and environment variable parsing for Crossmint custody adapter.
 */

/** Signer type for the Crossmint wallet. */
export type CrossmintSignerType = "api-key" | "evm-keypair";

/**
 * Configuration for creating a CrossmintWallet.
 */
export interface CrossmintWalletConfig {
  /** Crossmint server-side API key (requires wallets.create + wallets:transactions.sign scopes) */
  apiKey: string;
  /** Existing wallet locator (e.g. "wallet:<address>" or "email:<user>"). Creates new wallet if omitted. */
  locator?: string;
  /** Chain to use. Default: "solana" */
  chain?: string;
  /** Signer type for wallet creation. Default: "api-key" (custodial, fully headless) */
  signerType?: CrossmintSignerType;
  /** Crossmint API base URL. Default: "https://www.crossmint.com" */
  baseUrl?: string;
  /** Linked user identifier for wallet association (e.g. "email:agent@example.com") */
  linkedUser?: string;
}

/** Environment variable keys for Crossmint custody configuration. */
export const CROSSMINT_ENV_KEYS = {
  /** Crossmint server-side API key */
  API_KEY: "CROSSMINT_API_KEY",
  /** Existing wallet locator (optional — creates new wallet if omitted) */
  LOCATOR: "CROSSMINT_WALLET_LOCATOR",
  /** Signer type: "api-key" or "evm-keypair" */
  SIGNER_TYPE: "CROSSMINT_SIGNER_TYPE",
  /** Crossmint API base URL override */
  BASE_URL: "CROSSMINT_BASE_URL",
  /** Linked user for wallet association */
  LINKED_USER: "CROSSMINT_LINKED_USER",
} as const;

/**
 * Parse CrossmintWalletConfig from environment variables.
 * Throws if CROSSMINT_API_KEY is not set.
 */
export function configFromEnv(): CrossmintWalletConfig {
  const apiKey = process.env[CROSSMINT_ENV_KEYS.API_KEY];
  if (!apiKey) {
    throw new Error(
      `Crossmint custody: ${CROSSMINT_ENV_KEYS.API_KEY} environment variable is required. ` +
        "Get a server-side API key from https://crossmint.com/console with " +
        "wallets.create and wallets:transactions.sign scopes.",
    );
  }

  const signerTypeRaw = process.env[CROSSMINT_ENV_KEYS.SIGNER_TYPE];
  let signerType: CrossmintSignerType | undefined;
  if (signerTypeRaw) {
    if (signerTypeRaw !== "api-key" && signerTypeRaw !== "evm-keypair") {
      throw new Error(
        `Crossmint custody: invalid ${CROSSMINT_ENV_KEYS.SIGNER_TYPE}="${signerTypeRaw}". ` +
          'Expected "api-key" or "evm-keypair".',
      );
    }
    signerType = signerTypeRaw;
  }

  return {
    apiKey,
    locator: process.env[CROSSMINT_ENV_KEYS.LOCATOR] || undefined,
    signerType,
    baseUrl: process.env[CROSSMINT_ENV_KEYS.BASE_URL] || undefined,
    linkedUser: process.env[CROSSMINT_ENV_KEYS.LINKED_USER] || undefined,
  };
}

/**
 * Validate a CrossmintWalletConfig. Throws descriptive errors for missing/invalid fields.
 */
export function validateConfig(config: CrossmintWalletConfig): void {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error(
      "Crossmint custody: apiKey is required and cannot be empty.",
    );
  }
}
