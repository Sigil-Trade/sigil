/**
 * @usesigil/custody/crossmint
 *
 * Crossmint TEE custody adapter for Sigil.
 * Hardware-enclave signing — the private key never leaves the TEE.
 *
 * @example One-liner with shieldWallet():
 * ```typescript
 * import { shieldWallet } from '@usesigil/kit';
 * import { crossmint } from '@usesigil/custody/crossmint';
 *
 * const wallet = shieldWallet(
 *   await crossmint({ apiKey: 'sk_...' }),
 *   { maxSpend: '500 USDC/day' }
 * );
 * ```
 *
 * @example Zero-config from environment:
 * ```typescript
 * import { shieldWallet } from '@usesigil/kit';
 * import { crossmintFromEnv } from '@usesigil/custody/crossmint';
 *
 * // Reads CROSSMINT_API_KEY (+ optional CROSSMINT_WALLET_LOCATOR) from env
 * const wallet = shieldWallet(await crossmintFromEnv(), { maxSpend: '500 USDC/day' });
 * ```
 */

export {
  CrossmintWallet,
  CrossmintRESTClient,
  type CrossmintSDKClient,
  type WalletLike,
} from "./adapter.js";

export {
  type CrossmintWalletConfig,
  type CrossmintSignerType,
  CROSSMINT_ENV_KEYS,
  configFromEnv,
  validateConfig,
} from "./config.js";

import { CrossmintWallet, CrossmintSDKClient } from "./adapter.js";
import { CrossmintWalletConfig, configFromEnv } from "./config.js";

/**
 * Create a CrossmintWallet from explicit configuration.
 *
 * If no `locator` is provided, a new wallet is created via the Crossmint API.
 * The private key lives in Crossmint's Intel TDX enclave — the agent never sees it.
 *
 * @example
 * ```typescript
 * const wallet = await crossmint({ apiKey: 'sk_production_...' });
 * console.log(wallet.publicKey.toBase58()); // Solana address
 * ```
 */
export async function crossmint(
  config: CrossmintWalletConfig,
  client?: CrossmintSDKClient,
): Promise<CrossmintWallet> {
  return CrossmintWallet.create(config, client);
}

/**
 * Create a CrossmintWallet from environment variables.
 *
 * Required: CROSSMINT_API_KEY
 * Optional: CROSSMINT_WALLET_LOCATOR, CROSSMINT_SIGNER_TYPE, CROSSMINT_BASE_URL
 *
 * @example
 * ```typescript
 * // Set CROSSMINT_API_KEY=sk_production_... in .env
 * const wallet = await crossmintFromEnv();
 * ```
 */
export async function crossmintFromEnv(
  client?: CrossmintSDKClient,
): Promise<CrossmintWallet> {
  const config = configFromEnv();
  return CrossmintWallet.create(config, client);
}
