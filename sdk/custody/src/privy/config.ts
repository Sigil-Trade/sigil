/**
 * Configuration and environment variable parsing for Privy custody adapter.
 */

/**
 * Configuration for creating a PrivyWallet.
 */
export interface PrivyWalletConfig {
  /** Privy app ID (from dashboard.privy.io) */
  appId: string;
  /** Privy app secret (from dashboard.privy.io) */
  appSecret: string;
  /** Existing Privy wallet ID (UUID). Creates new wallet if omitted. */
  walletId?: string;
  /** Privy API base URL. Default: "https://api.privy.io" */
  baseUrl?: string;
}

/** Environment variable keys for Privy custody configuration. */
export const PRIVY_ENV_KEYS = {
  /** Privy app ID */
  APP_ID: "PRIVY_APP_ID",
  /** Privy app secret */
  APP_SECRET: "PRIVY_APP_SECRET",
  /** Existing wallet ID (optional — creates new wallet if omitted) */
  WALLET_ID: "PRIVY_WALLET_ID",
  /** Privy API base URL override */
  BASE_URL: "PRIVY_BASE_URL",
} as const;

/**
 * Parse PrivyWalletConfig from environment variables.
 * Throws if PRIVY_APP_ID or PRIVY_APP_SECRET are not set.
 */
export function configFromEnv(): PrivyWalletConfig {
  const appId = process.env[PRIVY_ENV_KEYS.APP_ID];
  if (!appId) {
    throw new Error(
      `Privy custody: ${PRIVY_ENV_KEYS.APP_ID} environment variable is required. ` +
        "Get your app ID from https://dashboard.privy.io",
    );
  }

  const appSecret = process.env[PRIVY_ENV_KEYS.APP_SECRET];
  if (!appSecret) {
    throw new Error(
      `Privy custody: ${PRIVY_ENV_KEYS.APP_SECRET} environment variable is required. ` +
        "Get your app secret from https://dashboard.privy.io",
    );
  }

  return {
    appId,
    appSecret,
    walletId: process.env[PRIVY_ENV_KEYS.WALLET_ID] || undefined,
    baseUrl: process.env[PRIVY_ENV_KEYS.BASE_URL] || undefined,
  };
}

/**
 * Validate a PrivyWalletConfig. Throws descriptive errors for missing/invalid fields.
 */
export function validateConfig(config: PrivyWalletConfig): void {
  if (!config.appId || config.appId.trim() === "") {
    throw new Error("Privy custody: appId is required and cannot be empty.");
  }
  if (!config.appSecret || config.appSecret.trim() === "") {
    throw new Error(
      "Privy custody: appSecret is required and cannot be empty.",
    );
  }
}
