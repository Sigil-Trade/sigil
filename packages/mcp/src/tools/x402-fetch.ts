import { z } from "zod";
import type { AgentShieldClient } from "@agent-shield/sdk";
import { formatError } from "../errors";
import type { McpConfig } from "../config";

export const x402FetchSchema = z.object({
  url: z.string().describe("URL of the x402-protected API endpoint"),
  method: z
    .string()
    .optional()
    .default("GET")
    .describe("HTTP method (default: GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Additional HTTP headers as key-value pairs"),
  body: z.string().optional().describe("Request body (for POST/PUT)"),
  maxPayment: z
    .string()
    .regex(/^\d+$/, "Must be a non-negative integer in token base units")
    .optional()
    .describe(
      "Maximum payment amount in token base units (rejects if server asks for more)",
    ),
});

export type X402FetchInput = z.input<typeof x402FetchSchema>;

// Module-level cache: persistent wallet + config fingerprint
// Use ShieldedWallet type from SDK (V2: shield function is internal, type is public)
import type { ShieldedWallet } from "@agent-shield/sdk";
let _cachedWallet: ShieldedWallet | null = null;
let _cachedConfigKey: string | null = null;

function getConfigKey(config: McpConfig): string {
  const cfgAny = config as unknown as Record<string, unknown>;
  return `${config.rpcUrl}|${config.walletPath ?? ""}|${config.agentKeypairPath ?? ""}|${typeof cfgAny.keypair === "string" ? cfgAny.keypair : ""}`;
}

export async function x402Fetch(
  _client: AgentShieldClient,
  config: McpConfig,
  input: X402FetchInput,
): Promise<string> {
  try {
    const { shieldedFetch } = await import("@agent-shield/sdk");
    // V2: shield() is internal to the wrapper. We access it from the compiled
    // dist output since the MCP server runs in the same monorepo.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wrapperMod = require("@agent-shield/sdk/dist/wrapper/index");
    const shieldWallet: (w: any, p?: any, o?: any) => ShieldedWallet =
      wrapperMod.shieldWallet;
    const { Connection, Keypair } = await import("@solana/web3.js");

    const configKey = getConfigKey(config);

    // Create or refresh cached wallet when config changes
    if (!_cachedWallet || configKey !== _cachedConfigKey) {
      // Load keypair (preserve ALL existing paths including cfgAny.keypair for tests)
      let keypair: InstanceType<typeof Keypair>;
      const cfgAny = config as unknown as Record<string, unknown>;
      if (typeof cfgAny.keypair === "string") {
        // Direct keypair bytes (JSON array string) — programmatic/test usage
        keypair = Keypair.fromSecretKey(
          new Uint8Array(JSON.parse(cfgAny.keypair as string)),
        );
      } else if (config.walletPath) {
        const { loadKeypair } = await import("../config");
        keypair = loadKeypair(config.walletPath);
      } else if (config.agentKeypairPath) {
        const { loadKeypair } = await import("../config");
        keypair = loadKeypair(config.agentKeypairPath);
      } else {
        return "## Error\n\nNo agent keypair configured. Run `shield_configure` first.";
      }

      const wallet = {
        publicKey: keypair.publicKey,
        signTransaction: async <T>(tx: T): Promise<T> => {
          (tx as any).partialSign?.(keypair);
          return tx;
        },
      };
      const connection = new Connection(config.rpcUrl, "confirmed");
      // undefined policies → secure defaults (1000 USDC/day, 1000 USDT/day, 10 SOL/day)
      _cachedWallet = shieldWallet(wallet as any, undefined, { connection });
      _cachedConfigKey = configKey;
    }

    // Use cached wallet (persistent ShieldState across calls)
    const connection = new Connection(config.rpcUrl, "confirmed");
    const fetchInit: RequestInit = {
      method: input.method ?? "GET",
    };
    if (input.headers) {
      fetchInit.headers = input.headers as Record<string, string>;
    }
    if (input.body) {
      fetchInit.body = input.body;
    }

    const res = await shieldedFetch(_cachedWallet, input.url, {
      ...fetchInit,
      connection,
      maxPayment: input.maxPayment,
    });

    const body = await res.text();
    const x402 = (res as any).x402;

    const lines = [`=== x402 Fetch Result ===`];
    lines.push(`URL: ${input.url}`);
    lines.push(`Status: ${res.status}`);

    if (x402) {
      lines.push(`Paid: ${x402.paid}`);
      if (x402.paid) {
        lines.push(`Amount: ${x402.amountPaid}`);
        lines.push(`Asset: ${x402.asset}`);
        lines.push(`Pay To: ${x402.payTo}`);
        if (x402.settlement?.transaction) {
          lines.push(`Tx: ${x402.settlement.transaction}`);
        }
      }
    }

    lines.push(`Response: ${body.slice(0, 2000)}`);

    return lines.join("\n");
  } catch (error) {
    return formatError(error);
  }
}

export const x402FetchTool = {
  name: "shield_x402_fetch",
  description:
    "Fetch a URL with automatic x402 (HTTP 402 Payment Required) support. " +
    "If the server returns 402 with payment requirements, the agent wallet " +
    "signs a payment transaction (enforced by shield policies) and retries.",
  schema: x402FetchSchema,
  handler: x402Fetch,
};
