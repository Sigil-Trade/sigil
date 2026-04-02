/**
 * @usesigil/custody/turnkey
 *
 * Turnkey TEE custody adapter for Sigil.
 * Hardware-enclave signing — the private key never leaves Turnkey's secure infrastructure.
 *
 * @example One-liner with shieldWallet():
 * ```typescript
 * import { shieldWallet } from '@usesigil/kit';
 * import { turnkey } from '@usesigil/custody/turnkey';
 *
 * const wallet = shieldWallet(
 *   await turnkey({ organizationId: '...', apiKeyId: '...', apiPrivateKey: '...' }),
 *   { maxSpend: '500 USDC/day' }
 * );
 * ```
 *
 * @example Zero-config from environment:
 * ```typescript
 * import { shieldWallet } from '@usesigil/kit';
 * import { turnkeyFromEnv } from '@usesigil/custody/turnkey';
 *
 * // Reads TURNKEY_ORGANIZATION_ID + TURNKEY_API_KEY_ID + TURNKEY_API_PRIVATE_KEY from env
 * const wallet = shieldWallet(await turnkeyFromEnv(), { maxSpend: '500 USDC/day' });
 * ```
 */

export {
  TurnkeyWallet,
  TurnkeyRESTClient,
  type TurnkeySDKClient,
  type WalletLike,
} from "./adapter.js";

export {
  type TurnkeyWalletConfig,
  TURNKEY_ENV_KEYS,
  configFromEnv,
  validateConfig,
} from "./config.js";

import { TurnkeyWallet, TurnkeySDKClient } from "./adapter.js";
import { TurnkeyWalletConfig, configFromEnv } from "./config.js";

/**
 * Create a TurnkeyWallet from explicit configuration.
 *
 * If no `walletId` is provided, a new wallet is created via the Turnkey API.
 * The private key never leaves Turnkey's secure infrastructure.
 *
 * @example
 * ```typescript
 * const wallet = await turnkey({ organizationId: '...', apiKeyId: '...', apiPrivateKey: '...' });
 * console.log(wallet.publicKey.toBase58()); // Solana address
 * ```
 */
export async function turnkey(
  config: TurnkeyWalletConfig,
  client?: TurnkeySDKClient,
): Promise<TurnkeyWallet> {
  return TurnkeyWallet.create(config, client);
}

/**
 * Create a TurnkeyWallet from environment variables.
 *
 * Required: TURNKEY_ORGANIZATION_ID, TURNKEY_API_KEY_ID, TURNKEY_API_PRIVATE_KEY
 * Optional: TURNKEY_WALLET_ID, TURNKEY_BASE_URL
 *
 * @example
 * ```typescript
 * const wallet = await turnkeyFromEnv();
 * ```
 */
export async function turnkeyFromEnv(
  client?: TurnkeySDKClient,
): Promise<TurnkeyWallet> {
  const config = configFromEnv();
  return TurnkeyWallet.create(config, client);
}
