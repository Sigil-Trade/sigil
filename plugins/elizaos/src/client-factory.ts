import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { shieldWallet } from "@phalnx/sdk";
import type { ShieldedWallet, WalletLike } from "@phalnx/sdk";
import { ENV_KEYS, PhalnxElizaConfig, CustodyProvider } from "./types";

/** Minimal wallet wrapper around a Keypair (no Anchor dependency). */
class KeypairWallet implements WalletLike {
  publicKey: PublicKey;
  constructor(private keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    if (tx instanceof Transaction) {
      tx.partialSign(this.keypair);
    } else {
      (tx as VersionedTransaction).sign([this.keypair]);
    }
    return tx;
  }
}

const walletCache = new WeakMap<
  object,
  { wallet: ShieldedWallet; publicKey: PublicKey }
>();

/**
 * Reads Phalnx config from ElizaOS runtime settings.
 * Supports both raw keypair and TEE custody provider paths.
 */
export function getConfig(runtime: any): PhalnxElizaConfig {
  const blockRaw = runtime.getSetting(ENV_KEYS.BLOCK_UNKNOWN);
  const blockUnknown = blockRaw !== "false";

  const custodyRaw = runtime.getSetting(ENV_KEYS.CUSTODY_PROVIDER) as
    | string
    | null;
  const custodyProvider = custodyRaw
    ? (custodyRaw as CustodyProvider)
    : undefined;

  if (custodyProvider) {
    // TEE custody path — no raw private key needed
    return {
      maxSpend: runtime.getSetting(ENV_KEYS.MAX_SPEND) || undefined,
      blockUnknown,
      custodyProvider,
      crossmintApiKey:
        runtime.getSetting(ENV_KEYS.CROSSMINT_API_KEY) || undefined,
      crossmintLocator:
        runtime.getSetting(ENV_KEYS.CROSSMINT_LOCATOR) || undefined,
    };
  }

  // Legacy path — raw private key
  const walletPrivateKey = runtime.getSetting(ENV_KEYS.WALLET_PRIVATE_KEY);
  if (!walletPrivateKey) {
    throw new Error(
      `Phalnx: either set '${ENV_KEYS.CUSTODY_PROVIDER}' to a custody provider ` +
        `(crossmint, turnkey, privy) or provide '${ENV_KEYS.WALLET_PRIVATE_KEY}'.`,
    );
  }

  return {
    maxSpend: runtime.getSetting(ENV_KEYS.MAX_SPEND) || undefined,
    blockUnknown,
    walletPrivateKey,
  };
}

/**
 * Parses a private key from either base58 or JSON array format.
 */
function parseKeypair(raw: string): Keypair {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
  } catch {
    // Not JSON — try base58
  }
  const bs58 = require("bs58");
  return Keypair.fromSecretKey(bs58.decode(raw));
}

/**
 * Create a WalletLike from a TEE custody provider.
 * Dynamically imports the provider adapter to avoid hard dependencies.
 */
async function createCustodyWallet(
  config: PhalnxElizaConfig,
): Promise<WalletLike> {
  switch (config.custodyProvider) {
    case "crossmint": {
      if (!config.crossmintApiKey) {
        throw new Error(
          `Phalnx: '${ENV_KEYS.CROSSMINT_API_KEY}' is required when ` +
            `'${ENV_KEYS.CUSTODY_PROVIDER}' is set to 'crossmint'.`,
        );
      }
      // Dynamic require to avoid hard dependency on custody adapter.
      // The package is optional — only needed when PHALNX_CUSTODY=crossmint.
      let mod: any;
      try {
        mod = require("@phalnx/custody-crossmint");
      } catch {
        throw new Error(
          "Phalnx: @phalnx/custody-crossmint is not installed. " +
            "Run: npm install @phalnx/custody-crossmint",
        );
      }
      return mod.crossmint({
        apiKey: config.crossmintApiKey,
        locator: config.crossmintLocator,
      });
    }
    case "turnkey":
      throw new Error(
        "Phalnx: Turnkey custody adapter is not yet available. " +
          "Install @phalnx/custody-turnkey when released.",
      );
    case "privy":
      throw new Error(
        "Phalnx: Privy custody adapter is not yet available. " +
          "Install @phalnx/custody-privy when released.",
      );
    default:
      throw new Error(
        `Phalnx: unknown custody provider '${config.custodyProvider}'. ` +
          "Supported: crossmint, turnkey, privy.",
      );
  }
}

/**
 * Gets or creates a ShieldedWallet for the given ElizaOS runtime.
 * Cached per runtime instance via WeakMap.
 *
 * Supports two paths:
 * 1. TEE custody: PHALNX_CUSTODY=crossmint → uses Crossmint TEE adapter
 * 2. Raw keypair: SOLANA_WALLET_PRIVATE_KEY → wraps local keypair (legacy)
 */
export async function getOrCreateShieldedWallet(runtime: any): Promise<{
  wallet: ShieldedWallet;
  publicKey: PublicKey;
}> {
  const cached = walletCache.get(runtime);
  if (cached) return cached;

  const config = getConfig(runtime);
  const logger = runtime.logger ?? console;

  let innerWallet: WalletLike;

  if (config.custodyProvider) {
    // TEE custody — private key never leaves the enclave
    (logger.info ?? console.info)(
      `[Phalnx] Using TEE custody provider: ${config.custodyProvider}`,
    );
    innerWallet = await createCustodyWallet(config);
  } else {
    // Legacy: raw keypair in memory
    const keypair = parseKeypair(config.walletPrivateKey!);
    innerWallet = new KeypairWallet(keypair);
  }

  const shielded = shieldWallet(
    innerWallet,
    {
      maxSpend: config.maxSpend,
      blockUnknownPrograms: config.blockUnknown,
    },
    {
      onDenied: (error) => {
        (logger.warn ?? console.warn)(
          "[Phalnx] Transaction denied:",
          error.message,
        );
      },
      onApproved: (txHash) => {
        (logger.info ?? console.info)(
          "[Phalnx] Transaction approved",
          txHash ?? "",
        );
      },
      onPause: () => {
        (logger.info ?? console.info)("[Phalnx] Enforcement paused");
      },
      onResume: () => {
        (logger.info ?? console.info)("[Phalnx] Enforcement resumed");
      },
      onPolicyUpdate: () => {
        (logger.info ?? console.info)("[Phalnx] Policies updated");
      },
    },
  );

  const result = { wallet: shielded, publicKey: innerWallet.publicKey };
  walletCache.set(runtime, result);
  return result;
}
