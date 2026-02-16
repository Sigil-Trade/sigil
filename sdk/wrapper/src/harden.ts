import { PublicKey, Connection } from "@solana/web3.js";
import { ShieldedWallet, WalletLike } from "./shield";

/**
 * Configuration for hardening a shielded wallet to on-chain enforcement.
 * Requires @agent-shield/sdk as a peer dependency.
 */
export interface HardenOptions {
  /** Solana RPC connection */
  connection: Connection;
  /** Vault ID (auto-incremented if not provided) */
  vaultId?: number;
  /** Fee destination for the vault */
  feeDestination?: PublicKey;
  /** Developer fee rate in basis points (0-500) */
  developerFeeRate?: number;
}

/**
 * Upgrade a shielded wallet from client-side enforcement (Tier 1)
 * to on-chain vault enforcement (Tier 2).
 *
 * This creates an on-chain AgentShield vault, registers the wallet
 * as an agent, and configures policies matching the wrapper config.
 *
 * Requires @agent-shield/sdk to be installed:
 * ```
 * npm install @agent-shield/sdk
 * ```
 *
 * @example
 * ```typescript
 * import { shield } from '@agent-shield/solana';
 * import { harden } from '@agent-shield/solana/harden';
 *
 * const protected = shield(wallet, { maxSpend: '500 USDC/day' });
 * const hardened = await harden(protected, {
 *   connection,
 *   feeDestination: myFeeWallet,
 * });
 * ```
 */
export async function harden(
  _shieldedWallet: ShieldedWallet,
  _options: HardenOptions,
): Promise<ShieldedWallet> {
  // Dynamic import to keep @agent-shield/sdk as an optional peer dep
  let sdk: typeof import("@agent-shield/sdk");
  try {
    sdk = await import("@agent-shield/sdk");
  } catch {
    throw new Error(
      "shield.harden() requires @agent-shield/sdk. Install it with: npm install @agent-shield/sdk",
    );
  }

  // TODO: Phase A.2 — implement full harden flow:
  // 1. Create AgentShieldClient from connection + owner wallet
  // 2. Initialize vault with policies matching wrapper config
  // 3. Register the agent key
  // 4. Return a new ShieldedWallet that routes through on-chain validation
  //
  // For now, throw a descriptive error since the vault SDK integration
  // requires careful mapping between wrapper policies and on-chain policy config.
  void sdk;
  throw new Error(
    "shield.harden() is not yet implemented. Use shield() for client-side protection. " +
    "On-chain vault enforcement will be available in a future release.",
  );
}
