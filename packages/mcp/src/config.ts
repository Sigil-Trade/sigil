import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { PhalnxClient } from "@phalnx/sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Supported custody providers for MCP server. */
export type McpCustodyProvider = "crossmint" | "turnkey" | "privy";

// ── Local Config ────────────────────────────────────────────────

export interface ShieldLayerConfig {
  shield: {
    enabled: boolean;
    dailySpendingCapUsd: number;
    /** Protocol mode: 0=all allowed, 1=allowlist, 2=denylist */
    protocolMode: number;
    protocols: string[];
    maxLeverageBps: number;
    rateLimit: number;
  };
  tee: {
    enabled: boolean;
    locator: string | null;
    publicKey: string | null;
  };
  vault: {
    enabled: boolean;
    address: string | null;
    owner: string | null;
    vaultId: string | null;
  };
}

export interface ShieldLocalConfig {
  version: 1;
  layers: ShieldLayerConfig;
  wallet: {
    type: "keypair" | "crossmint" | "privy" | "turnkey";
    path: string | null;
    publicKey: string;
  };
  network: "devnet" | "mainnet-beta";
  template: "conservative" | "moderate" | "aggressive";
  configuredAt: string;
}

/** Canonical config directory. */
export function getConfigDir(): string {
  return path.join(os.homedir(), ".phalnx");
}

/** Canonical config file path. */
export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/** Runtime guard — rejects corrupted or incompatible config files. */
function isValidConfig(obj: any): obj is ShieldLocalConfig {
  return (
    typeof obj === "object" &&
    obj !== null &&
    obj.version === 1 &&
    typeof obj.layers?.shield?.enabled === "boolean" &&
    typeof obj.layers?.shield?.dailySpendingCapUsd === "number" &&
    typeof obj.layers?.tee === "object" &&
    typeof obj.layers?.vault === "object" &&
    typeof obj.wallet?.publicKey === "string" &&
    (obj.network === "devnet" || obj.network === "mainnet-beta")
  );
}

/**
 * Load local shield config from ~/.phalnx/config.json.
 * Falls back to env vars for backwards compatibility with existing MCP installs.
 * Returns null if neither config file nor env vars exist.
 */
export function loadShieldConfig(): ShieldLocalConfig | null {
  const configPath = getConfigPath();

  // Config file takes precedence
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return isValidConfig(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Fall back to env vars (backwards compatible with existing installs)
  const walletPath = process.env.PHALNX_WALLET_PATH;
  if (walletPath) {
    try {
      const kp = loadKeypair(walletPath);
      return {
        version: 1,
        layers: {
          shield: {
            enabled: true,
            dailySpendingCapUsd: 500,
            protocolMode: 0,
            protocols: [],
            maxLeverageBps: 0,
            rateLimit: 60,
          },
          tee: { enabled: false, locator: null, publicKey: null },
          vault: { enabled: false, address: null, owner: null, vaultId: null },
        },
        wallet: {
          type: "keypair",
          path: walletPath,
          publicKey: kp.publicKey.toBase58(),
        },
        network: (process.env.PHALNX_RPC_URL?.includes("mainnet")
          ? "mainnet-beta"
          : "devnet") as "devnet" | "mainnet-beta",
        template: "conservative",
        configuredAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Save local shield config to ~/.phalnx/config.json.
 * Creates the directory if needed. Sets file permissions to 0600.
 */
export function saveShieldConfig(config: ShieldLocalConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/**
 * Returns true if Phalnx is configured (config file exists or env vars set).
 */
export function isConfigured(): boolean {
  return loadShieldConfig() !== null;
}

/**
 * Returns true if Phalnx is fully configured (all three layers enabled).
 */
export function isFullyConfigured(config: ShieldLocalConfig): boolean {
  return (
    config.layers.shield.enabled &&
    config.layers.tee.enabled &&
    config.layers.vault.enabled
  );
}

export interface McpConfig {
  /** Path to owner wallet keypair JSON. Not needed when using custody. */
  walletPath?: string;
  rpcUrl: string;
  agentKeypairPath?: string;
  /** TEE custody provider — when set, walletPath is not required. */
  custodyProvider?: McpCustodyProvider;
  /** Crossmint API key (when custodyProvider = "crossmint"). */
  crossmintApiKey?: string;
  /** Crossmint wallet locator (optional — creates new wallet if omitted). */
  crossmintLocator?: string;
  /** Privy app ID (when custodyProvider = "privy"). */
  privyAppId?: string;
  /** Privy app secret (when custodyProvider = "privy"). */
  privyAppSecret?: string;
  /** Privy wallet ID (optional — creates new wallet if omitted). */
  privyWalletId?: string;
  /** Turnkey organization ID (when custodyProvider = "turnkey"). */
  turnkeyOrganizationId?: string;
  /** Turnkey API key ID (when custodyProvider = "turnkey"). */
  turnkeyApiKeyId?: string;
  /** Turnkey API private key — PEM-encoded P-256 (when custodyProvider = "turnkey"). */
  turnkeyApiPrivateKey?: string;
  /** Turnkey wallet ID (optional — creates new wallet if omitted). */
  turnkeyWalletId?: string;
}

export function loadConfig(): McpConfig {
  const rpcUrl = process.env.PHALNX_RPC_URL || clusterApiUrl("devnet");

  const agentKeypairPath = process.env.PHALNX_AGENT_KEYPAIR_PATH || undefined;

  const custodyProvider = process.env.PHALNX_CUSTODY as
    | McpCustodyProvider
    | undefined;

  if (custodyProvider) {
    // TEE custody path — no wallet file needed
    return {
      rpcUrl,
      agentKeypairPath,
      custodyProvider,
      crossmintApiKey: process.env.CROSSMINT_API_KEY || undefined,
      crossmintLocator: process.env.CROSSMINT_WALLET_LOCATOR || undefined,
      privyAppId: process.env.PRIVY_APP_ID || undefined,
      privyAppSecret: process.env.PRIVY_APP_SECRET || undefined,
      privyWalletId: process.env.PRIVY_WALLET_ID || undefined,
      turnkeyOrganizationId: process.env.TURNKEY_ORGANIZATION_ID || undefined,
      turnkeyApiKeyId: process.env.TURNKEY_API_KEY_ID || undefined,
      turnkeyApiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY || undefined,
      turnkeyWalletId: process.env.TURNKEY_WALLET_ID || undefined,
    };
  }

  // Legacy path — keypair file required
  const walletPath = process.env.PHALNX_WALLET_PATH;
  if (!walletPath) {
    throw new Error(
      "PHALNX_WALLET_PATH is required (or set PHALNX_CUSTODY " +
        "to a custody provider: crossmint, turnkey, privy). " +
        "Set PHALNX_WALLET_PATH to the path of your Solana keypair JSON file.",
    );
  }

  return { walletPath, rpcUrl, agentKeypairPath };
}

export function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.startsWith("~")
    ? filePath.replace("~", os.homedir())
    : filePath;
  const raw = fs.readFileSync(resolved, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

export function createClient(config: McpConfig): PhalnxClient {
  if (!config.walletPath) {
    throw new Error(
      "createClient requires walletPath. " +
        "For custody-based wallets, use createCustodyClient() instead.",
    );
  }
  const keypair = loadKeypair(config.walletPath);
  const wallet = new Wallet(keypair);
  const connection = new Connection(config.rpcUrl, "confirmed");
  return new PhalnxClient(connection, wallet);
}

/**
 * Create a WalletLike from a TEE custody provider.
 * Dynamically imports the provider adapter to avoid hard dependencies.
 */
export async function createCustodyWallet(config: McpConfig): Promise<{
  publicKey: import("@solana/web3.js").PublicKey;
  signTransaction: Function;
}> {
  switch (config.custodyProvider) {
    case "crossmint": {
      if (!config.crossmintApiKey) {
        throw new Error(
          "CROSSMINT_API_KEY is required when PHALNX_CUSTODY=crossmint.",
        );
      }
      // Dynamic require to avoid hard dependency on custody adapter.
      let mod: any;
      try {
        mod = require("@phalnx/custody-crossmint");
      } catch {
        throw new Error(
          "@phalnx/custody-crossmint is not installed. " +
            "Run: npm install @phalnx/custody-crossmint",
        );
      }
      return mod.crossmint({
        apiKey: config.crossmintApiKey,
        locator: config.crossmintLocator,
      });
    }
    case "privy": {
      if (!config.privyAppId || !config.privyAppSecret) {
        throw new Error(
          "PRIVY_APP_ID and PRIVY_APP_SECRET are required when PHALNX_CUSTODY=privy.",
        );
      }
      let privyMod: any;
      try {
        privyMod = require("@phalnx/custody-privy");
      } catch {
        throw new Error(
          "@phalnx/custody-privy is not installed. " +
            "Run: npm install @phalnx/custody-privy",
        );
      }
      return privyMod.privy({
        appId: config.privyAppId,
        appSecret: config.privyAppSecret,
        walletId: config.privyWalletId,
      });
    }
    case "turnkey": {
      if (
        !config.turnkeyOrganizationId ||
        !config.turnkeyApiKeyId ||
        !config.turnkeyApiPrivateKey
      ) {
        throw new Error(
          "TURNKEY_ORGANIZATION_ID, TURNKEY_API_KEY_ID, and TURNKEY_API_PRIVATE_KEY " +
            "are required when PHALNX_CUSTODY=turnkey.",
        );
      }
      let turnkeyMod: any;
      try {
        turnkeyMod = require("@phalnx/custody-turnkey");
      } catch {
        throw new Error(
          "@phalnx/custody-turnkey is not installed. " +
            "Run: npm install @phalnx/custody-turnkey",
        );
      }
      return turnkeyMod.turnkey({
        organizationId: config.turnkeyOrganizationId,
        apiKeyId: config.turnkeyApiKeyId,
        apiPrivateKey: config.turnkeyApiPrivateKey,
        walletId: config.turnkeyWalletId,
      });
    }
    default:
      throw new Error(
        `Unknown custody provider '${config.custodyProvider}'. ` +
          "Supported: crossmint, turnkey, privy.",
      );
  }
}

/** Minimal interface for custody wallets (avoids hard dep on adapter types). */
export interface CustodyWalletLike {
  publicKey: import("@solana/web3.js").PublicKey;
  signTransaction: <T>(tx: T) => Promise<T>;
  signAllTransactions?: <T>(txs: T[]) => Promise<T[]>;
}

/** RPC URL helper: env override or clusterApiUrl fallback. */
export function rpcUrlForNetwork(network: "devnet" | "mainnet-beta"): string {
  return process.env.PHALNX_RPC_URL || clusterApiUrl(network);
}

/**
 * Create an PhalnxClient backed by a custody wallet.
 * Duck-typed: CrossmintWallet has publicKey, signTransaction, signAllTransactions.
 */
export async function createCustodyClient(
  config: McpConfig,
): Promise<{ client: PhalnxClient; custodyWallet: CustodyWalletLike }> {
  const custodyWallet = (await createCustodyWallet(
    config,
  )) as CustodyWalletLike;
  const connection = new Connection(config.rpcUrl, "confirmed");
  const client = new PhalnxClient(
    connection,
    custodyWallet as any as import("@coral-xyz/anchor").Wallet,
  );
  return { client, custodyWallet };
}

/**
 * Resolve an PhalnxClient from the best available config source.
 *
 * Priority:
 * 1. File-based config (from shield_configure)
 *    - crossmint type → needs CROSSMINT_API_KEY + locator → createCustodyClient
 *    - keypair type → createClient
 * 2. Env-var config (backwards compatible)
 *    - custodyProvider set → createCustodyClient
 *    - else → createClient (keypair)
 * 3. null if nothing works
 */
export async function resolveClient(): Promise<{
  client: PhalnxClient;
  config: McpConfig;
  custodyWallet: CustodyWalletLike | null;
} | null> {
  // Priority 1: File-based config
  const fileConfig = loadShieldConfig();
  if (fileConfig) {
    if (
      fileConfig.wallet.type === "crossmint" &&
      fileConfig.layers.tee.enabled
    ) {
      const apiKey = process.env.CROSSMINT_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Crossmint wallet configured but CROSSMINT_API_KEY is not set. " +
            "Set CROSSMINT_API_KEY in your environment to use your custody wallet.",
        );
      }
      const mcpConfig: McpConfig = {
        rpcUrl: rpcUrlForNetwork(fileConfig.network),
        custodyProvider: "crossmint",
        crossmintApiKey: apiKey,
        crossmintLocator: fileConfig.layers.tee.locator ?? undefined,
      };
      const { client, custodyWallet } = await createCustodyClient(mcpConfig);
      return { client, config: mcpConfig, custodyWallet };
    }

    if (fileConfig.wallet.type === "privy" && fileConfig.layers.tee.enabled) {
      const appId = process.env.PRIVY_APP_ID;
      const appSecret = process.env.PRIVY_APP_SECRET;
      if (!appId || !appSecret) {
        throw new Error(
          "Privy wallet configured but PRIVY_APP_ID and PRIVY_APP_SECRET are not set. " +
            "Set both environment variables to use your custody wallet.",
        );
      }
      const mcpConfig: McpConfig = {
        rpcUrl: rpcUrlForNetwork(fileConfig.network),
        custodyProvider: "privy",
        privyAppId: appId,
        privyAppSecret: appSecret,
        privyWalletId: fileConfig.layers.tee.locator ?? undefined,
      };
      const { client, custodyWallet } = await createCustodyClient(mcpConfig);
      return { client, config: mcpConfig, custodyWallet };
    }

    if (fileConfig.wallet.type === "turnkey" && fileConfig.layers.tee.enabled) {
      const orgId = process.env.TURNKEY_ORGANIZATION_ID;
      const apiKeyId = process.env.TURNKEY_API_KEY_ID;
      const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
      if (!orgId || !apiKeyId || !apiPrivateKey) {
        throw new Error(
          "Turnkey wallet configured but TURNKEY_ORGANIZATION_ID, TURNKEY_API_KEY_ID, " +
            "and TURNKEY_API_PRIVATE_KEY are not all set. " +
            "Set all three environment variables to use your custody wallet.",
        );
      }
      const mcpConfig: McpConfig = {
        rpcUrl: rpcUrlForNetwork(fileConfig.network),
        custodyProvider: "turnkey",
        turnkeyOrganizationId: orgId,
        turnkeyApiKeyId: apiKeyId,
        turnkeyApiPrivateKey: apiPrivateKey,
        turnkeyWalletId: fileConfig.layers.tee.locator ?? undefined,
      };
      const { client, custodyWallet } = await createCustodyClient(mcpConfig);
      return { client, config: mcpConfig, custodyWallet };
    }

    if (fileConfig.wallet.type === "keypair" && fileConfig.wallet.path) {
      const mcpConfig: McpConfig = {
        walletPath: fileConfig.wallet.path,
        rpcUrl: rpcUrlForNetwork(fileConfig.network),
        agentKeypairPath: fileConfig.wallet.path,
      };
      const client = createClient(mcpConfig);
      return { client, config: mcpConfig, custodyWallet: null };
    }
  }

  // Priority 2: Env-var config
  try {
    const envConfig = loadConfig();
    if (envConfig.custodyProvider) {
      const { client, custodyWallet } = await createCustodyClient(envConfig);
      return { client, config: envConfig, custodyWallet };
    }
    const client = createClient(envConfig);
    return { client, config: envConfig, custodyWallet: null };
  } catch {
    // loadConfig throws when no wallet path — that's fine, fall through
  }

  return null;
}

export function loadAgentKeypair(config: McpConfig): Keypair {
  if (!config.agentKeypairPath) {
    throw new Error(
      "PHALNX_AGENT_KEYPAIR_PATH is required for agent-signed operations. " +
        "Set it to the path of the agent's Solana keypair JSON file.",
    );
  }
  return loadKeypair(config.agentKeypairPath);
}

export function loadOwnerKeypair(config: McpConfig): Keypair {
  if (!config.walletPath) {
    throw new Error(
      "Wallet path is required for Squads multisig operations. " +
        "Configure with shield_configure or set PHALNX_WALLET_PATH.",
    );
  }
  return loadKeypair(config.walletPath);
}
