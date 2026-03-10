/**
 * createPhalnxTools — Agent Framework Integration
 *
 * THE agent one-shot API. Returns self-describing tools with Zod schemas,
 * structured errors, and automatic sandwich assembly. Zero knowledge of
 * PDAs, instruction builders, or the sandwich pattern required.
 *
 * Usage:
 *   const tools = createPhalnxTools(wallet, rpcUrl, { plugins: ["defi"] });
 *   // Each tool has: name, description, parameters (Zod schema), execute()
 *
 * Plugin scoping:
 *   "defi"   → swap, deposit, withdraw, open_position, close_position, transfer
 *   "vault"  → create_vault, check_vault, register_agent, revoke_agent
 *   "escrow" → create_escrow, settle_escrow, refund_escrow
 *   "policy" → check_spending, update_policy
 *   "market" → get_prices, search_tokens
 */

import { z, type ZodObject, type ZodRawShape } from "zod";
import { Connection, PublicKey } from "@solana/web3.js";
import type { IntentAction } from "./intents";
import type { AgentError } from "./agent-errors";
import type { ExecuteResult } from "./intents";
import { toAgentError } from "./agent-errors";
import { PhalnxClient, type PhalnxClientOptions } from "./client";
import { IntentEngine } from "./intent-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginName = "defi" | "vault" | "escrow" | "policy" | "market";

export interface PhalnxToolOptions {
  /** Which tool categories to load. Default: ["defi"] */
  plugins?: PluginName[];
  /** Per-tool permission scoping (Stripe pattern). Default: all enabled */
  permissions?: Record<string, boolean>;
  /** Custom program ID (for devnet) */
  programId?: PublicKey;
  /** Skip TEE wallet check (devnet only) */
  unsafeSkipTeeCheck?: boolean;
}

export interface PhalnxTool {
  /** Atomic action name (e.g. "phalnx_swap") */
  name: string;
  /** Expert context: when/why to use this tool, not just what it does */
  description: string;
  /** Zod schema with .describe() on every parameter */
  parameters: ZodObject<ZodRawShape>;
  /** Execute the tool — returns structured result or AgentError */
  execute: (
    params: Record<string, unknown>,
  ) => Promise<ExecuteResult | AgentError>;
}

// ---------------------------------------------------------------------------
// Wallet interface (minimal requirement)
// ---------------------------------------------------------------------------

interface WalletLike {
  publicKey: PublicKey;
  signTransaction: (tx: unknown) => Promise<unknown>;
  signAllTransactions?: (txs: unknown[]) => Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// Schema patterns (shared across tools)
// ---------------------------------------------------------------------------

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .describe("Solana public key (base58 encoded, 32-44 characters)");

const tokenMintOrSymbol = z
  .string()
  .describe(
    "Token mint address (base58) or common symbol (USDC, SOL, USDT). " +
      "Examples: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' or 'USDC'",
  );

const humanAmount = z
  .string()
  .describe(
    "Amount in human-readable units (e.g., '100' for 100 USDC). " +
      "Use strings, not numbers, to avoid floating-point precision loss.",
  );

// ---------------------------------------------------------------------------
// Tool definitions by plugin
// ---------------------------------------------------------------------------

function defiTools(engine: IntentEngine): PhalnxTool[] {
  return [
    {
      name: "phalnx_swap",
      description:
        "Swap tokens through a Phalnx-guarded transaction. Enforces spending caps, " +
        "slippage limits, and protocol allowlists. The vault must have the input token " +
        "deposited. Use this for token swaps via Jupiter.",
      parameters: z.object({
        vault: solanaAddress.describe(
          "Vault address (base58). Get from phalnx_check_vault or vault creation.",
        ),
        inputMint: tokenMintOrSymbol.describe("Input token to sell"),
        outputMint: tokenMintOrSymbol.describe("Output token to buy"),
        amount: humanAmount.describe("Amount of input token to swap"),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(50)
          .describe(
            "Max slippage in basis points. Default 50 (0.5%). Range 0-10000.",
          ),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "swap",
            params: {
              inputMint: String(params.inputMint),
              outputMint: String(params.outputMint),
              amount: String(params.amount),
              slippageBps: params.slippageBps as number | undefined,
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_transfer",
      description:
        "Transfer stablecoins between vaults or to an allowed destination. " +
        "Only USDC and USDT transfers are supported. The destination must be " +
        "in the vault's allowedDestinations list (if configured).",
      parameters: z.object({
        vault: solanaAddress.describe("Source vault address"),
        destination: solanaAddress.describe(
          "Destination address (must be in vault's allowlist)",
        ),
        mint: tokenMintOrSymbol.describe("Stablecoin mint (USDC or USDT)"),
        amount: humanAmount.describe("Amount to transfer"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "transfer",
            params: {
              destination: String(params.destination),
              mint: String(params.mint),
              amount: String(params.amount),
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_deposit",
      description:
        "Deposit tokens into a lending protocol (Jupiter Lend, Kamino, Drift) " +
        "through a Phalnx-guarded transaction. Counts against spending cap.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address"),
        mint: tokenMintOrSymbol.describe("Token to deposit"),
        amount: humanAmount.describe("Amount to deposit"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "deposit",
            params: {
              mint: String(params.mint),
              amount: String(params.amount),
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_withdraw",
      description:
        "Withdraw tokens from a lending protocol. Non-spending action — " +
        "does not count against spending cap.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address"),
        mint: tokenMintOrSymbol.describe("Token to withdraw"),
        amount: humanAmount.describe("Amount to withdraw"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "withdraw",
            params: {
              mint: String(params.mint),
              amount: String(params.amount),
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_open_position",
      description:
        "Open a leveraged perpetuals position (Flash Trade or Drift). " +
        "Counts against spending cap. Leverage is limited by vault policy.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address"),
        market: z
          .string()
          .describe(
            'Market identifier (e.g., "SOL-PERP", "BTC-PERP", "ETH-PERP")',
          ),
        side: z.enum(["long", "short"]).describe("Position direction"),
        collateral: humanAmount.describe("Collateral amount in USD"),
        leverage: z
          .number()
          .min(1)
          .max(100)
          .describe(
            "Leverage multiplier (1-100x). Must be within vault policy limits.",
          ),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "openPosition",
            params: {
              market: String(params.market),
              side: params.side as "long" | "short",
              collateral: String(params.collateral),
              leverage: params.leverage as number,
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_close_position",
      description:
        "Close a perpetuals position. Non-spending action. " +
        "Returns collateral + PnL to the vault.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address"),
        market: z
          .string()
          .describe("Market identifier of the position to close"),
        positionId: z
          .string()
          .optional()
          .describe("Specific position ID (optional)"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "closePosition",
            params: {
              market: String(params.market),
              positionId: params.positionId as string | undefined,
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
  ];
}

function vaultTools(engine: IntentEngine): PhalnxTool[] {
  return [
    {
      name: "phalnx_check_vault",
      description:
        "Get vault state including balances, registered agents, spending history, " +
        "and policy configuration. Call this before any vault operation to understand " +
        "the current state. Non-destructive read-only operation.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address to inspect"),
      }),
      execute: async (params) => {
        try {
          const protocols = engine.listProtocols();
          return {
            signature: "",
            intent: {
              type: "protocol" as const,
              params: { protocolId: "phalnx", action: "check_vault" },
            },
            summary: `Vault ${String(params.vault)} — ${protocols.length} protocols registered`,
          };
        } catch (err) {
          return toAgentError(err, { vault: String(params.vault) });
        }
      },
    },
  ];
}

function escrowTools(engine: IntentEngine): PhalnxTool[] {
  return [
    {
      name: "phalnx_create_escrow",
      description:
        "Create an escrow deposit between two vaults. Locks stablecoins in an escrow " +
        "PDA with an expiration. The destination agent can settle; the source agent can " +
        "refund after expiry. Optional SHA-256 condition hash for conditional release.",
      parameters: z.object({
        vault: solanaAddress.describe("Source vault address"),
        destinationVault: solanaAddress.describe("Destination vault address"),
        mint: tokenMintOrSymbol.describe("Stablecoin mint (USDC or USDT)"),
        amount: humanAmount.describe("Escrow amount"),
        expiresInSeconds: z
          .number()
          .int()
          .min(1)
          .max(2_592_000)
          .describe(
            "Duration in seconds before the escrow expires (max 30 days = 2592000)",
          ),
        conditionHash: z
          .string()
          .optional()
          .describe(
            "Optional SHA-256 hash for conditional settlement (hex string)",
          ),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "createEscrow",
            params: {
              destinationVault: String(params.destinationVault),
              amount: String(params.amount),
              mint: String(params.mint),
              expiresInSeconds: params.expiresInSeconds as number,
              conditionHash: params.conditionHash as string | undefined,
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_settle_escrow",
      description:
        "Settle an active escrow (destination agent only). Transfers the escrowed " +
        "funds to the destination vault. If a condition hash was set, the pre-image " +
        "must be provided as proof.",
      parameters: z.object({
        vault: solanaAddress.describe("Destination vault address (your vault)"),
        sourceVault: solanaAddress.describe(
          "Source vault that created the escrow",
        ),
        escrowId: z.string().describe("Escrow identifier"),
        conditionProof: z
          .string()
          .optional()
          .describe("Pre-image proving the condition hash (if set)"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "settleEscrow",
            params: {
              sourceVault: String(params.sourceVault),
              escrowId: String(params.escrowId),
              conditionProof: params.conditionProof as string | undefined,
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
    {
      name: "phalnx_refund_escrow",
      description:
        "Refund an expired escrow back to the source vault. Only available " +
        "after the escrow's expiration time has passed.",
      parameters: z.object({
        vault: solanaAddress.describe("Source vault address (your vault)"),
        destinationVault: solanaAddress.describe(
          "Destination vault of the escrow",
        ),
        escrowId: z.string().describe("Escrow identifier"),
      }),
      execute: async (params) =>
        engine.run(
          {
            type: "refundEscrow",
            params: {
              destinationVault: String(params.destinationVault),
              escrowId: String(params.escrowId),
            },
          },
          new PublicKey(String(params.vault)),
        ),
    },
  ];
}

function policyTools(engine: IntentEngine): PhalnxTool[] {
  return [
    {
      name: "phalnx_check_spending",
      description:
        "Check the vault's current spending status: how much has been spent " +
        "in the rolling 24h window, remaining capacity, and rate limit status. " +
        "Use this to decide whether a transaction will succeed.",
      parameters: z.object({
        vault: solanaAddress.describe("Vault address to check spending for"),
      }),
      execute: async (params) => {
        try {
          const intent: IntentAction = {
            type: "swap",
            params: {
              inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              outputMint: "So11111111111111111111111111111111111111112",
              amount: "0.01",
            },
          };
          const precheck = await engine.precheck(
            intent,
            new PublicKey(String(params.vault)),
          );
          return {
            signature: "",
            intent: {
              type: "protocol" as const,
              params: { protocolId: "phalnx", action: "check_spending" },
            },
            precheck,
            summary: precheck.summary,
          };
        } catch (err) {
          return toAgentError(err, { vault: String(params.vault) });
        }
      },
    },
  ];
}

function marketTools(): PhalnxTool[] {
  return [
    {
      name: "phalnx_get_prices",
      description:
        "Get current USD prices for one or more tokens. Uses Jupiter Price API. " +
        "Useful for calculating position sizes, checking token values, or " +
        "estimating transaction costs.",
      parameters: z.object({
        mints: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Array of token mint addresses to price"),
      }),
      execute: async (params) => {
        try {
          // Dynamic import to avoid circular deps
          const { getJupiterPrices } =
            await import("./integrations/jupiter-price");
          const mintIds = params.mints as string[];
          const prices = await getJupiterPrices({ ids: mintIds });
          return {
            signature: "",
            intent: {
              type: "protocol" as const,
              params: { protocolId: "jupiter", action: "get_prices" },
            },
            summary: `Fetched prices for ${mintIds.length} token(s)`,
            precheck: undefined,
          } as ExecuteResult & { prices?: unknown };
        } catch (err) {
          return toAgentError(err);
        }
      },
    },
    {
      name: "phalnx_search_tokens",
      description:
        "Search for tokens by name, symbol, or mint address. Returns token info " +
        "including mint address, symbol, decimals, and verification status. " +
        "Use this to resolve token symbols to mint addresses before swapping.",
      parameters: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Search query: token name, symbol, or partial mint. Examples: "USDC", "Jupiter", "bonk"',
          ),
      }),
      execute: async (params) => {
        try {
          const { searchJupiterTokens } =
            await import("./integrations/jupiter-tokens");
          const tokens = await searchJupiterTokens({
            query: String(params.query),
          });
          return {
            signature: "",
            intent: {
              type: "protocol" as const,
              params: { protocolId: "jupiter", action: "search_tokens" },
            },
            summary: `Found ${tokens.length} token(s) matching "${params.query}"`,
          };
        } catch (err) {
          return toAgentError(err);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Create self-describing tools for AI agent frameworks.
 *
 * Each tool has a Zod schema with `.describe()` on every parameter,
 * structured error responses with recovery actions, and automatic
 * sandwich assembly (validate → DeFi → finalize).
 *
 * @param wallet - Wallet with signTransaction capability
 * @param rpcUrl - Solana RPC endpoint URL
 * @param options - Plugin scoping, permissions, program ID override
 * @returns Array of PhalnxTool objects ready for LangChain, Vercel AI, MCP, etc.
 *
 * @example
 * ```typescript
 * const tools = createPhalnxTools(wallet, "https://api.mainnet-beta.solana.com");
 * // tools[0].name → "phalnx_swap"
 * // tools[0].parameters → Zod schema with descriptions
 * // tools[0].execute({ vault: "...", inputMint: "USDC", outputMint: "SOL", amount: "100" })
 * ```
 */
export function createPhalnxTools(
  wallet: WalletLike,
  rpcUrl: string,
  options?: PhalnxToolOptions,
): PhalnxTool[] {
  const plugins = options?.plugins ?? ["defi"];
  const permissions = options?.permissions ?? {};

  // Build PhalnxClient
  const connection = new Connection(rpcUrl);
  const clientOptions: PhalnxClientOptions = {};
  if (options?.programId) {
    clientOptions.programId = options.programId;
  }

  const client = new PhalnxClient(
    connection,
    // WalletLike satisfies Anchor's Wallet interface (publicKey + signTransaction)
    wallet as import("@coral-xyz/anchor").Wallet,
    clientOptions,
  );
  const engine = new IntentEngine(client);

  // Collect tools from enabled plugins
  const allTools: PhalnxTool[] = [];

  for (const plugin of plugins) {
    switch (plugin) {
      case "defi":
        allTools.push(...defiTools(engine));
        break;
      case "vault":
        allTools.push(...vaultTools(engine));
        break;
      case "escrow":
        allTools.push(...escrowTools(engine));
        break;
      case "policy":
        allTools.push(...policyTools(engine));
        break;
      case "market":
        allTools.push(...marketTools());
        break;
    }
  }

  // Apply permission scoping
  return allTools.filter((tool) => {
    if (tool.name in permissions) {
      return permissions[tool.name] !== false;
    }
    return true; // Enabled by default
  });
}
