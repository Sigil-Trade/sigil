import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getConfigDir,
  loadShieldConfig,
  saveShieldConfig,
  type ShieldLocalConfig,
} from "../config";

/**
 * Template definitions for configure tool.
 * Duplicated from actions-server/src/lib/templates.ts for zero-dependency use.
 * Keep in sync — see apps/actions-server/src/lib/templates.ts.
 */
const CONFIGURE_TEMPLATES = {
  conservative: {
    dailySpendingCapUsd: 500,
    protocolMode: 1 as number,
    protocols: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    maxLeverageBps: 0,
    rateLimit: 60,
  },
  moderate: {
    dailySpendingCapUsd: 2000,
    protocolMode: 1 as number,
    protocols: [
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    ],
    maxLeverageBps: 20000,
    rateLimit: 120,
  },
  aggressive: {
    dailySpendingCapUsd: 10000,
    protocolMode: 0 as number,
    protocols: [
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
      "F1aShdFvR4FHMqAjMbBiGWCHKYaUqR6sFg1MG2pPVfkz",
    ],
    maxLeverageBps: 50000,
    rateLimit: 300,
  },
} as const;

type ConfigureTemplate = keyof typeof CONFIGURE_TEMPLATES;

const ACTIONS_SERVER_URL = "https://agent-middleware.vercel.app";

export const configureSchema = z.object({
  teeProvider: z
    .enum(["crossmint", "turnkey", "privy"])
    .optional()
    .default("crossmint")
    .describe("TEE custody provider (default: crossmint)"),
  template: z
    .enum(["conservative", "moderate", "aggressive"])
    .optional()
    .default("conservative")
    .describe("Policy template (default: conservative)"),
  dailySpendingCapUsd: z
    .number()
    .optional()
    .describe("Custom daily spending cap in USD (overrides template)"),
  protocolMode: z
    .number()
    .optional()
    .describe(
      "Protocol access mode: 0 = all allowed, 1 = allowlist, 2 = denylist (overrides template)",
    ),
  protocols: z
    .array(z.string())
    .optional()
    .describe("Custom protocol program IDs (base58, overrides template)"),
  maxLeverageBps: z
    .number()
    .optional()
    .describe("Custom max leverage in basis points"),
  rateLimit: z
    .number()
    .optional()
    .describe("Custom rate limit in transactions per minute"),
  network: z
    .enum(["devnet", "mainnet-beta"])
    .optional()
    .default("devnet")
    .describe("Solana network (default: devnet)"),
  walletPath: z
    .string()
    .optional()
    .describe("Path to existing keypair JSON (generates new if omitted)"),
});

export type ConfigureInput = z.input<typeof configureSchema>;

/**
 * Set up Phalnx with full on-chain guardrails.
 * Generates keypair, provisions TEE wallet, and creates vault Blink URL.
 */
export async function configure(
  _client: any,
  input: ConfigureInput,
): Promise<string> {
  try {
    const templateName = input.template ?? "conservative";
    const network = input.network ?? "devnet";
    const template =
      CONFIGURE_TEMPLATES[templateName as ConfigureTemplate] ??
      CONFIGURE_TEMPLATES.conservative;

    const dailySpendingCapUsd =
      input.dailySpendingCapUsd ?? template.dailySpendingCapUsd;
    const protocolMode = input.protocolMode ?? template.protocolMode;
    const protocols = input.protocols ?? [...template.protocols];
    const maxLeverageBps = input.maxLeverageBps ?? template.maxLeverageBps;
    const rateLimit = input.rateLimit ?? template.rateLimit;

    // ── Step 1: Generate/load keypair ──────────────────────────────
    let walletPath = input.walletPath || null;
    let walletPublicKey: string;

    if (walletPath) {
      const { Keypair } = await import("@solana/web3.js");
      const resolved = walletPath.startsWith("~")
        ? walletPath.replace("~", os.homedir())
        : walletPath;
      const raw = fs.readFileSync(resolved, "utf-8");
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
      walletPublicKey = kp.publicKey.toBase58();
    } else {
      const { Keypair } = await import("@solana/web3.js");
      const kp = Keypair.generate();
      const walletsDir = path.join(getConfigDir(), "wallets");
      if (!fs.existsSync(walletsDir)) {
        fs.mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
      }
      walletPath = path.join(walletsDir, "agent.json");
      fs.writeFileSync(walletPath, JSON.stringify(Array.from(kp.secretKey)), {
        mode: 0o600,
      });
      walletPublicKey = kp.publicKey.toBase58();
    }

    const config: ShieldLocalConfig = {
      version: 1,
      layers: {
        shield: {
          enabled: true,
          dailySpendingCapUsd,
          protocolMode,
          protocols,
          maxLeverageBps,
          rateLimit,
        },
        tee: { enabled: false, locator: null, publicKey: null },
        vault: {
          enabled: false,
          address: null,
          owner: null,
          vaultId: null,
        },
      },
      wallet: {
        type: "keypair",
        path: walletPath,
        publicKey: walletPublicKey,
      },
      network: network as "devnet" | "mainnet-beta",
      template: templateName as ConfigureTemplate,
      configuredAt: new Date().toISOString(),
    };

    const lines: string[] = [
      "## Phalnx Configured",
      "",
      `**Wallet:** ${walletPublicKey}`,
      `**Network:** ${config.network}`,
      `**Template:** ${templateName}`,
      `**Daily Cap:** $${dailySpendingCapUsd}`,
      `**Protocol Mode:** ${protocolMode === 0 ? "All Allowed" : protocolMode === 1 ? "Allowlist" : "Denylist"}`,
      `**Protocols:** ${protocols.length}`,
      `**Max Leverage:** ${maxLeverageBps} BPS`,
    ];

    // ── Step 2: Provision TEE wallet ──────────────────────────────
    const teeProvider = input.teeProvider ?? "crossmint";

    // Dedup guard: if we already have a TEE wallet from a previous run, reuse it
    const existingConfig = loadShieldConfig();
    if (
      existingConfig?.layers.tee.enabled &&
      existingConfig.layers.tee.locator
    ) {
      config.layers.tee = { ...existingConfig.layers.tee };
      config.wallet.type = existingConfig.wallet.type as
        | "keypair"
        | "crossmint"
        | "privy"
        | "turnkey";
      config.wallet.publicKey =
        existingConfig.layers.tee.publicKey ?? walletPublicKey;

      lines.push("");
      lines.push("### TEE Custody (reused existing)");
      lines.push(`- **TEE Public Key:** ${config.wallet.publicKey}`);
      lines.push(`- **Locator:** ${config.layers.tee.locator}`);
      lines.push(
        "- Your agent's private key is protected in a hardware enclave.",
      );
    } else if (
      teeProvider === "privy" &&
      process.env.PRIVY_APP_ID &&
      process.env.PRIVY_APP_SECRET
    ) {
      // Local Privy creation — dev has their own API credentials
      try {
        let mod: any;
        try {
          mod = require("@phalnx/custody-privy");
        } catch {
          return (
            "Error: @phalnx/custody-privy is not installed.\n" +
            "Run: npm install @phalnx/custody-privy"
          );
        }
        const custodyWallet = await mod.privy({
          appId: process.env.PRIVY_APP_ID,
          appSecret: process.env.PRIVY_APP_SECRET,
        });

        config.layers.tee = {
          enabled: true,
          locator: custodyWallet.walletId,
          publicKey: custodyWallet.publicKey.toBase58(),
        };
        config.wallet.type = "privy";
        config.wallet.publicKey = custodyWallet.publicKey.toBase58();

        lines.push("");
        lines.push("### TEE Custody (Privy)");
        lines.push(`- **TEE Public Key:** ${config.wallet.publicKey}`);
        lines.push(`- **Wallet ID:** ${config.layers.tee.locator}`);
        lines.push(
          "- Your agent's private key is protected in a Privy AWS Nitro Enclave.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error creating Privy wallet locally: ${msg}`;
      }
    } else if (
      teeProvider === "turnkey" &&
      process.env.TURNKEY_ORGANIZATION_ID &&
      process.env.TURNKEY_API_KEY_ID &&
      process.env.TURNKEY_API_PRIVATE_KEY
    ) {
      // Local Turnkey creation — dev has their own API credentials
      try {
        let mod: any;
        try {
          mod = require("@phalnx/custody-turnkey");
        } catch {
          return (
            "Error: @phalnx/custody-turnkey is not installed.\n" +
            "Run: npm install @phalnx/custody-turnkey"
          );
        }
        const custodyWallet = await mod.turnkey({
          organizationId: process.env.TURNKEY_ORGANIZATION_ID,
          apiKeyId: process.env.TURNKEY_API_KEY_ID,
          apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
        });

        config.layers.tee = {
          enabled: true,
          locator: custodyWallet.walletId,
          publicKey: custodyWallet.publicKey.toBase58(),
        };
        config.wallet.type = "turnkey";
        config.wallet.publicKey = custodyWallet.publicKey.toBase58();

        lines.push("");
        lines.push("### TEE Custody (Turnkey)");
        lines.push(`- **TEE Public Key:** ${config.wallet.publicKey}`);
        lines.push(`- **Wallet ID:** ${config.layers.tee.locator}`);
        lines.push(
          "- Your agent's private key is protected in Turnkey's secure infrastructure.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error creating Turnkey wallet locally: ${msg}`;
      }
    } else if (
      (teeProvider === "crossmint" || teeProvider === undefined) &&
      process.env.CROSSMINT_API_KEY
    ) {
      // Local Crossmint creation — dev has their own API key
      try {
        let mod: any;
        try {
          mod = require("@phalnx/custody-crossmint");
        } catch {
          return (
            "Error: @phalnx/custody-crossmint is not installed.\n" +
            "Run: npm install @phalnx/custody-crossmint"
          );
        }
        const baseUrl =
          network === "mainnet-beta"
            ? "https://crossmint.com"
            : "https://staging.crossmint.com";
        const custodyWallet = await mod.crossmint({
          apiKey: process.env.CROSSMINT_API_KEY,
          baseUrl,
          linkedUser: `userId:phalnx-${walletPublicKey}`,
        });

        config.layers.tee = {
          enabled: true,
          locator: `userId:phalnx-${walletPublicKey}`,
          publicKey: custodyWallet.publicKey.toBase58(),
        };
        config.wallet.type = "crossmint";
        config.wallet.publicKey = custodyWallet.publicKey.toBase58();

        lines.push("");
        lines.push("### TEE Custody (local Crossmint)");
        lines.push(`- **TEE Public Key:** ${config.wallet.publicKey}`);
        lines.push(`- **Locator:** ${config.layers.tee.locator}`);
        lines.push(
          "- Your agent's private key is protected in a hardware enclave.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error creating Crossmint wallet locally: ${msg}`;
      }
    } else {
      // Fall back to hosted Actions Server
      try {
        const response = await fetch(
          `${ACTIONS_SERVER_URL}/api/actions/provision-tee`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              network,
              publicKey: walletPublicKey,
              provider: teeProvider,
            }),
          },
        );

        if (!response.ok) {
          const errorBody = await response.text();
          return `Error provisioning TEE wallet: ${response.status} ${errorBody}`;
        }

        const teeResult = (await response.json()) as {
          publicKey: string;
          locator: string;
        };
        config.layers.tee = {
          enabled: true,
          locator: teeResult.locator,
          publicKey: teeResult.publicKey,
        };
        config.wallet.type = teeProvider as "crossmint" | "privy" | "turnkey";
        config.wallet.publicKey = teeResult.publicKey;

        lines.push("");
        lines.push(`### TEE Custody (${teeProvider})`);
        lines.push(`- **TEE Public Key:** ${teeResult.publicKey}`);
        lines.push(`- **Locator:** ${teeResult.locator}`);
        lines.push(
          "- Your agent's private key is protected in a hardware enclave.",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Error connecting to Phalnx platform for TEE provisioning: ${msg}`;
      }
    }

    // ── Step 3: Generate vault Blink URL ──────────────────────────
    const params = new URLSearchParams();
    params.set("template", templateName);
    if (input.dailySpendingCapUsd) {
      params.set("dailyCap", input.dailySpendingCapUsd.toString());
    }
    params.set("agentPubkey", config.wallet.publicKey);

    const actionUrl = `${ACTIONS_SERVER_URL}/api/actions/provision?${params.toString()}`;
    const blinkUrl = `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;

    config.layers.vault.enabled = true;

    lines.push("");
    lines.push("### On-Chain Vault");
    lines.push(
      "Your vault needs one more step — sign the creation transaction:",
    );
    lines.push(`1. **Blink URL:** ${blinkUrl}`);
    lines.push(`2. **Action URL:** ${actionUrl}`);
    lines.push("");
    lines.push(
      "After signing, your vault address will be saved automatically.",
    );

    // Save config
    saveShieldConfig(config);

    lines.push("");
    lines.push("### Next Steps");
    lines.push("1. Sign the vault creation transaction using the link above");
    lines.push(
      "2. After signing, run `shield_confirm_vault` to save your vault address",
    );
    lines.push("3. Fund your vault with SOL and tokens");
    lines.push("4. You're ready to trade with full on-chain protection!");

    return lines.join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error configuring Phalnx: ${msg}`;
  }
}

export const configureTool = {
  name: "shield_configure",
  description:
    "Set up Phalnx with full on-chain guardrails. " +
    "Generates keypair, provisions TEE wallet, and creates vault Blink URL.",
  schema: configureSchema,
  handler: configure,
};
