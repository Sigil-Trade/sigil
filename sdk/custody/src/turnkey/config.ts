/**
 * Configuration and environment variable parsing for Turnkey custody adapter.
 */

/**
 * Configuration for creating a TurnkeyWallet.
 */
export interface TurnkeyWalletConfig {
  /** Turnkey organization ID (from app.turnkey.com) */
  organizationId: string;
  /** Turnkey API key ID (from app.turnkey.com) */
  apiKeyId: string;
  /** Turnkey API private key — PEM-encoded P-256 ECDSA key */
  apiPrivateKey: string;
  /** Existing Turnkey wallet ID. Creates new wallet if omitted. */
  walletId?: string;
  /** Turnkey API base URL. Default: "https://api.turnkey.com" */
  baseUrl?: string;
}

/** Environment variable keys for Turnkey custody configuration. */
export const TURNKEY_ENV_KEYS = {
  /** Turnkey organization ID */
  ORGANIZATION_ID: "TURNKEY_ORGANIZATION_ID",
  /** Turnkey API key ID */
  API_KEY_ID: "TURNKEY_API_KEY_ID",
  /** Turnkey API private key (PEM-encoded) */
  API_PRIVATE_KEY: "TURNKEY_API_PRIVATE_KEY",
  /** Existing wallet ID (optional — creates new wallet if omitted) */
  WALLET_ID: "TURNKEY_WALLET_ID",
  /** Turnkey API base URL override */
  BASE_URL: "TURNKEY_BASE_URL",
} as const;

/**
 * Parse TurnkeyWalletConfig from environment variables.
 * Throws if required env vars are not set.
 */
export function configFromEnv(): TurnkeyWalletConfig {
  const organizationId = process.env[TURNKEY_ENV_KEYS.ORGANIZATION_ID];
  if (!organizationId) {
    throw new Error(
      `Turnkey custody: ${TURNKEY_ENV_KEYS.ORGANIZATION_ID} environment variable is required. ` +
        "Get your organization ID from https://app.turnkey.com",
    );
  }

  const apiKeyId = process.env[TURNKEY_ENV_KEYS.API_KEY_ID];
  if (!apiKeyId) {
    throw new Error(
      `Turnkey custody: ${TURNKEY_ENV_KEYS.API_KEY_ID} environment variable is required. ` +
        "Create an API key at https://app.turnkey.com",
    );
  }

  const apiPrivateKey = process.env[TURNKEY_ENV_KEYS.API_PRIVATE_KEY];
  if (!apiPrivateKey) {
    throw new Error(
      `Turnkey custody: ${TURNKEY_ENV_KEYS.API_PRIVATE_KEY} environment variable is required. ` +
        "This is the PEM-encoded P-256 private key from your API key pair.",
    );
  }

  return {
    organizationId,
    apiKeyId,
    apiPrivateKey,
    walletId: process.env[TURNKEY_ENV_KEYS.WALLET_ID] || undefined,
    baseUrl: process.env[TURNKEY_ENV_KEYS.BASE_URL] || undefined,
  };
}

/**
 * Validate a TurnkeyWalletConfig. Throws descriptive errors for missing/invalid fields.
 */
export function validateConfig(config: TurnkeyWalletConfig): void {
  if (!config.organizationId || config.organizationId.trim() === "") {
    throw new Error(
      "Turnkey custody: organizationId is required and cannot be empty.",
    );
  }
  if (!config.apiKeyId || config.apiKeyId.trim() === "") {
    throw new Error(
      "Turnkey custody: apiKeyId is required and cannot be empty.",
    );
  }
  if (!config.apiPrivateKey || config.apiPrivateKey.trim() === "") {
    throw new Error(
      "Turnkey custody: apiPrivateKey is required and cannot be empty.",
    );
  }
}
