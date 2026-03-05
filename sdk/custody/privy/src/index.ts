/**
 * @phalnx/custody-privy
 *
 * Privy TEE custody adapter for Phalnx.
 * Hardware-enclave signing — the private key never leaves the AWS Nitro Enclave.
 *
 * @example One-liner with shieldWallet():
 * ```typescript
 * import { shieldWallet } from '@phalnx/sdk';
 * import { privy } from '@phalnx/custody-privy';
 *
 * const wallet = shieldWallet(
 *   await privy({ appId: 'clx...', appSecret: 'sk_...' }),
 *   { maxSpend: '500 USDC/day' }
 * );
 * ```
 *
 * @example Zero-config from environment:
 * ```typescript
 * import { shieldWallet } from '@phalnx/sdk';
 * import { privyFromEnv } from '@phalnx/custody-privy';
 *
 * // Reads PRIVY_APP_ID + PRIVY_APP_SECRET (+ optional PRIVY_WALLET_ID) from env
 * const wallet = shieldWallet(await privyFromEnv(), { maxSpend: '500 USDC/day' });
 * ```
 */

export {
  PrivyWallet,
  PrivyRESTClient,
  type PrivySDKClient,
  type WalletLike,
} from "./adapter";

export {
  type PrivyWalletConfig,
  PRIVY_ENV_KEYS,
  configFromEnv,
  validateConfig,
} from "./config";

import { PrivyWallet, PrivySDKClient } from "./adapter";
import { PrivyWalletConfig, configFromEnv } from "./config";

/**
 * Create a PrivyWallet from explicit configuration.
 *
 * If no `walletId` is provided, a new wallet is created via the Privy API.
 * The private key lives in Privy's AWS Nitro Enclave — the agent never sees it.
 *
 * @example
 * ```typescript
 * const wallet = await privy({ appId: 'clx...', appSecret: 'sk_...' });
 * console.log(wallet.publicKey.toBase58()); // Solana address
 * ```
 */
export async function privy(
  config: PrivyWalletConfig,
  client?: PrivySDKClient,
): Promise<PrivyWallet> {
  return PrivyWallet.create(config, client);
}

/**
 * Create a PrivyWallet from environment variables.
 *
 * Required: PRIVY_APP_ID, PRIVY_APP_SECRET
 * Optional: PRIVY_WALLET_ID, PRIVY_BASE_URL
 *
 * @example
 * ```typescript
 * // Set PRIVY_APP_ID=clx... and PRIVY_APP_SECRET=sk_... in .env
 * const wallet = await privyFromEnv();
 * ```
 */
export async function privyFromEnv(
  client?: PrivySDKClient,
): Promise<PrivyWallet> {
  const config = configFromEnv();
  return PrivyWallet.create(config, client);
}
