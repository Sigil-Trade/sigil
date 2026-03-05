import type {
  ShieldedWallet,
  WalletLike,
  ShieldPolicies,
  ShieldOptions,
} from "@phalnx/sdk";
import { createShieldedWallet } from "./factory";

/**
 * Plugin configuration — accepts either a pre-created ShieldedWallet
 * or a raw wallet + policies for auto-creation via the factory.
 */
export interface PhalnxPluginConfig {
  /** A pre-created ShieldedWallet (from shieldWallet()). Mutually exclusive with rawWallet. */
  wallet?: ShieldedWallet;
  /** A raw WalletLike to wrap with shieldWallet(). Mutually exclusive with wallet. */
  rawWallet?: WalletLike;
  /** Shield policies (used when rawWallet is provided). */
  policies?: ShieldPolicies;
  /** Logger for shield event callbacks (used when rawWallet is provided). */
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
  /** Additional ShieldOptions (used when rawWallet is provided). */
  options?: ShieldOptions;
}

/** Resolved config that always has a ShieldedWallet. */
export interface ResolvedConfig {
  wallet: ShieldedWallet;
}

/**
 * Resolves plugin config to always have a ShieldedWallet.
 * If a rawWallet is provided, uses the factory to create one.
 */
export function resolveWallet(config: PhalnxPluginConfig): ResolvedConfig {
  if (config.wallet) {
    return { wallet: config.wallet };
  }

  if (config.rawWallet) {
    const wallet = createShieldedWallet({
      wallet: config.rawWallet,
      policies: config.policies,
      logger: config.logger,
      options: config.options,
    });
    return { wallet };
  }

  throw new Error(
    "Phalnx: config must provide either 'wallet' (ShieldedWallet) or 'rawWallet' (WalletLike).",
  );
}
