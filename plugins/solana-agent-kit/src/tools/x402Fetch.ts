import { z } from "zod";
import type { ResolvedConfig } from "../types";

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
    .describe("Additional HTTP headers"),
  body: z.string().optional().describe("Request body (for POST/PUT)"),
});

export type X402FetchInput = z.input<typeof x402FetchSchema>;

/** H3: SSRF protection — block localhost, private IPs, non-HTTPS */
function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(hostname)
  ) {
    throw new Error("Requests to localhost/loopback addresses are not allowed");
  }
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    ) {
      throw new Error("Requests to private IP addresses are not allowed");
    }
  }
}

export async function x402Fetch(
  agent: any,
  config: ResolvedConfig,
  input: X402FetchInput,
): Promise<string> {
  try {
    validateUrl(input.url);
    const { shieldedFetch } = await import("@phalnx/sdk");

    const fetchInit: RequestInit = {
      method: input.method ?? "GET",
    };
    if (input.headers) {
      fetchInit.headers = input.headers as Record<string, string>;
    }
    if (input.body) {
      fetchInit.body = input.body;
    }

    // Get connection from agent (SolanaAgentKit) or fall back to undefined
    const connection = agent?.connection;

    const res = await shieldedFetch(config.wallet, input.url, {
      ...fetchInit,
      connection,
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
        if (x402.settlement?.transaction) {
          lines.push(`Transaction: ${x402.settlement.transaction}`);
        }
      }
    }

    lines.push(`Response: ${body.slice(0, 1000)}`);
    return lines.join("\n");
  } catch (error: any) {
    return `x402 fetch failed: ${error.message ?? error}`;
  }
}
