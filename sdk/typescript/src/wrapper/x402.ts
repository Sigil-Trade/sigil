/**
 * x402 — HTTP 402 Payment Required support for shielded wallets.
 *
 * Implements the x402 V2 protocol (coinbase/x402) for machine-to-machine
 * crypto payments. The client signs a payment, retries with PAYMENT-SIGNATURE
 * header, and the API server settles via a facilitator.
 *
 * @see https://x402.org
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import type { ShieldedWallet } from "./shield";
import type { ResolvedPolicies, TransactionAnalysis } from "./policies";
import { evaluatePolicy, recordTransaction } from "./engine";
import { ShieldDeniedError } from "./errors";
import type { ShieldState } from "./state";
import { getTokenInfo } from "./registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * x402 V2 PaymentRequired — decoded from PAYMENT-REQUIRED header.
 * Mirrors @x402/core/types PaymentRequired.
 */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** A single payment option offered by the server. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Resource metadata embedded in PaymentRequired. */
export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

/** The signed payment payload sent back to the server. */
export interface PaymentPayload {
  x402Version: number;
  resource: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Settlement response decoded from PAYMENT-RESPONSE header. */
export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

/** Options for shieldedFetch(). */
export interface ShieldedFetchOptions extends RequestInit {
  /** Solana RPC connection for blockhash + ATA resolution. */
  connection?: Connection;
  /** If true, evaluate policies but don't pay. */
  dryRun?: boolean;
  /** Max payment in token base units — reject if server asks more. */
  maxPayment?: string;
  /** Number of extra settlement retries if non-2xx (default: 1, max: 3).
   *  Re-sends the same PAYMENT-SIGNATURE header. */
  maxRetries?: number;
}

/** Extended response with x402 payment metadata. */
export interface ShieldedFetchResponse extends Response {
  x402?: X402PaymentResult;
}

/** Payment metadata attached to a ShieldedFetchResponse. */
export interface X402PaymentResult {
  paid: boolean;
  amountPaid: string;
  asset: string;
  payTo: string;
  settlement?: SettleResponse;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class X402ParseError extends Error {
  constructor(message: string) {
    super(`x402 parse error: ${message}`);
    this.name = "X402ParseError";
  }
}

export class X402PaymentError extends Error {
  constructor(message: string) {
    super(`x402 payment error: ${message}`);
    this.name = "X402PaymentError";
  }
}

export class X402UnsupportedError extends Error {
  constructor(message: string) {
    super(`x402 unsupported: ${message}`);
    this.name = "X402UnsupportedError";
  }
}

// ---------------------------------------------------------------------------
// Header encoding / decoding
// ---------------------------------------------------------------------------

function base64Encode(data: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data, "utf-8").toString("base64");
  }
  return btoa(data);
}

function base64Decode(encoded: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(encoded, "base64").toString("utf-8");
  }
  return atob(encoded);
}

/**
 * Decode a base64-encoded PAYMENT-REQUIRED header value.
 */
export function decodePaymentRequiredHeader(header: string): PaymentRequired {
  try {
    const json = base64Decode(header);
    const parsed = JSON.parse(json) as PaymentRequired;
    if (!parsed.accepts || !Array.isArray(parsed.accepts)) {
      throw new Error("missing accepts array");
    }
    return parsed;
  } catch (err: any) {
    throw new X402ParseError(
      `Failed to decode PAYMENT-REQUIRED header: ${err.message}`,
    );
  }
}

/**
 * Encode a PaymentPayload as a base64 string for PAYMENT-SIGNATURE header.
 */
export function encodePaymentSignatureHeader(payload: PaymentPayload): string {
  return base64Encode(JSON.stringify(payload));
}

/**
 * Decode a base64-encoded PAYMENT-RESPONSE header value.
 */
export function decodePaymentResponseHeader(header: string): SettleResponse {
  try {
    return JSON.parse(base64Decode(header)) as SettleResponse;
  } catch (err: any) {
    throw new X402ParseError(
      `Failed to decode PAYMENT-RESPONSE header: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Payment option selection
// ---------------------------------------------------------------------------

/**
 * Select a Solana-compatible payment option from the accepts array.
 *
 * @param paymentRequired The decoded PAYMENT-REQUIRED payload
 * @param allowedTokens   Optional set of token mint addresses to accept
 * @returns The first matching PaymentRequirements, or throws
 */
export function selectPaymentOption(
  paymentRequired: PaymentRequired,
  allowedTokens?: Set<string>,
): PaymentRequirements {
  for (const option of paymentRequired.accepts) {
    // Network must start with "solana:" (CAIP-2 format)
    if (!option.network.startsWith("solana:")) {
      continue;
    }
    // If token filter provided, asset must be in the allowlist
    if (allowedTokens && !allowedTokens.has(option.asset)) {
      continue;
    }
    return option;
  }
  throw new X402UnsupportedError(
    "No compatible Solana payment option found in accepts array",
  );
}

// ---------------------------------------------------------------------------
// Policy evaluation (pre-check only — does NOT record spend)
// ---------------------------------------------------------------------------

/**
 * Evaluate an x402 payment against shield policies without recording spend.
 *
 * Creates a synthetic TransactionAnalysis from the payment requirements
 * and runs it through the existing policy engine.
 */
export function evaluateX402Payment(
  selected: PaymentRequirements,
  policies: ResolvedPolicies,
  state: ShieldState,
): import("./errors").PolicyViolation[] {
  const analysis: TransactionAnalysis = {
    programIds: [TOKEN_PROGRAM_ID],
    transfers: [
      {
        mint: new PublicKey(selected.asset),
        amount: BigInt(selected.amount),
        direction: "outgoing" as const,
        destination: new PublicKey(selected.payTo),
      },
    ],
    estimatedValueLamports: BigInt(selected.amount),
  };
  return evaluatePolicy(analysis, policies, state);
}

// ---------------------------------------------------------------------------
// Transfer instruction builder
// ---------------------------------------------------------------------------

/**
 * Build an SPL TransferChecked instruction for an x402 payment.
 */
export function buildX402TransferInstruction(params: {
  from: PublicKey;
  payTo: PublicKey;
  asset: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  const sourceAta = getAssociatedTokenAddressSync(params.asset, params.from);
  const destAta = getAssociatedTokenAddressSync(params.asset, params.payTo);

  return createTransferCheckedInstruction(
    sourceAta,
    params.asset,
    destAta,
    params.from,
    params.amount,
    params.decimals,
  );
}

// ---------------------------------------------------------------------------
// Payload encoding
// ---------------------------------------------------------------------------

/**
 * Encode a signed transaction into a full x402 V2 PaymentPayload.
 */
export function encodeX402Payload(
  signedTx: Uint8Array,
  resource: ResourceInfo,
  accepted: PaymentRequirements,
): string {
  const txBase64 = base64Encode(String.fromCharCode(...signedTx));
  const payload: PaymentPayload = {
    x402Version: 2,
    resource,
    accepted,
    payload: { transaction: txBase64 },
    extensions: {},
  };
  return encodePaymentSignatureHeader(payload);
}

// ---------------------------------------------------------------------------
// Core: shieldedFetch
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with automatic x402 payment support.
 *
 * Flow:
 * 1. Make the initial HTTP request
 * 2. If 402, parse PAYMENT-REQUIRED header
 * 3. Select a Solana payment option
 * 4. Evaluate against shield policies (fast deny)
 * 5. Build, sign, and encode payment transaction
 * 6. Retry with PAYMENT-SIGNATURE header
 * 7. Return response with x402 metadata
 *
 * The client NEVER settles — the API server calls the facilitator.
 */
export async function shieldedFetch(
  wallet: ShieldedWallet,
  url: string | URL,
  options?: ShieldedFetchOptions,
): Promise<ShieldedFetchResponse> {
  // H3: Protocol check — reject non-HTTP(S) URLs
  const urlStr = url.toString();
  if (!urlStr.startsWith("https://") && !urlStr.startsWith("http://")) {
    throw new X402PaymentError(
      "Only HTTP/HTTPS URLs are supported for x402 payments",
    );
  }

  const init: RequestInit = { ...options };
  const connection = options?.connection;
  const dryRun = options?.dryRun ?? false;
  const maxRetries = Math.min(Math.max(options?.maxRetries ?? 1, 1), 3);

  // Strip our custom options from the fetch init
  delete (init as any).connection;
  delete (init as any).dryRun;
  delete (init as any).maxPayment;
  delete (init as any).maxRetries;

  // Step 1: Initial request
  const response = await globalThis.fetch(url.toString(), init);

  // Non-402 responses pass through unchanged
  if (response.status !== 402) {
    return response as ShieldedFetchResponse;
  }

  // Step 2: Extract PAYMENT-REQUIRED header (case-insensitive)
  const paymentRequiredHeader =
    response.headers.get("payment-required") ??
    response.headers.get("PAYMENT-REQUIRED");

  if (!paymentRequiredHeader) {
    // Non-x402 402 response — return as-is
    return response as ShieldedFetchResponse;
  }

  // Step 3: Prevent infinite retry loops — reject if already attempted
  const hasPaymentHeader = (() => {
    if (!init.headers) return false;
    if (init.headers instanceof Headers) {
      return (
        init.headers.has("PAYMENT-SIGNATURE") ||
        init.headers.has("payment-signature")
      );
    }
    if (Array.isArray(init.headers)) {
      return init.headers.some(
        ([k]) => k.toLowerCase() === "payment-signature",
      );
    }
    const rec = init.headers as Record<string, string>;
    return "PAYMENT-SIGNATURE" in rec || "payment-signature" in rec;
  })();
  if (hasPaymentHeader) {
    throw new X402PaymentError(
      "Payment already attempted — refusing to retry to prevent infinite loops",
    );
  }

  // Step 4: Decode header
  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

  // Step 5: Select a Solana payment option
  const allowedTokens = wallet.resolvedPolicies.allowedTokens
    ? new Set(wallet.resolvedPolicies.allowedTokens)
    : undefined;
  const selected = selectPaymentOption(paymentRequired, allowedTokens);

  // Enforce maxPayment ceiling if set
  if (options?.maxPayment) {
    try {
      const maxAmount = BigInt(options.maxPayment);
      const requestedAmount = BigInt(selected.amount);
      if (requestedAmount > maxAmount) {
        throw new X402PaymentError(
          `Server requires ${selected.amount} but maxPayment is ${options.maxPayment}`,
        );
      }
    } catch (e) {
      if (e instanceof X402PaymentError) throw e;
      throw new X402PaymentError(
        `Invalid maxPayment value: "${options.maxPayment}" (must be a non-negative integer string)`,
      );
    }
  }

  // Step 5: Policy pre-check (does NOT record spend)
  const violations = evaluateX402Payment(
    selected,
    wallet.resolvedPolicies,
    wallet.shieldState,
  );
  if (violations.length > 0) {
    throw new ShieldDeniedError(violations);
  }

  // Step 6: Dry run — return metadata without paying
  if (dryRun) {
    const dryResponse = new Response(null, {
      status: 402,
    }) as ShieldedFetchResponse;
    dryResponse.x402 = {
      paid: false,
      amountPaid: selected.amount,
      asset: selected.asset,
      payTo: selected.payTo,
    };
    return dryResponse;
  }

  // Step 7: Build and sign the payment transaction
  const assetPubkey = new PublicKey(selected.asset);
  const tokenInfo = getTokenInfo(assetPubkey);
  const decimals = tokenInfo?.decimals ?? 6; // USDC default

  if (!connection) {
    throw new X402PaymentError(
      "Connection required for x402 payments. Pass connection in ShieldedFetchOptions.",
    );
  }

  const transferIx = buildX402TransferInstruction({
    from: wallet.publicKey,
    payTo: new PublicKey(selected.payTo),
    asset: assetPubkey,
    amount: BigInt(selected.amount),
    decimals,
  });

  const tx = new Transaction();
  tx.add(transferIx);

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  // For client-side wallets: signTransaction runs through the policy interceptor
  // which evaluates policies AND records the spend.
  // For hardened wallets: the policy interceptor wraps in vault composition.
  const signedTx = await wallet.signTransaction(tx);
  const serialized = (signedTx as Transaction).serialize({
    verifySignatures: false,
  });

  // Step 8: Encode the payment payload
  const encodedPayload = encodeX402Payload(
    serialized,
    paymentRequired.resource,
    selected,
  );

  // Step 10: Retry with PAYMENT-SIGNATURE header (with settlement retries)
  const retryHeaders = new Headers(init.headers as any);
  retryHeaders.set("PAYMENT-SIGNATURE", encodedPayload);

  let retryResponse = (await globalThis.fetch(url.toString(), {
    ...init,
    headers: retryHeaders,
  })) as ShieldedFetchResponse;

  // Retry settlement if non-2xx (up to maxRetries total attempts)
  for (
    let attempt = 1;
    attempt < maxRetries &&
    !(retryResponse.status >= 200 && retryResponse.status < 300);
    attempt++
  ) {
    retryResponse = (await globalThis.fetch(url.toString(), {
      ...init,
      headers: retryHeaders,
    })) as ShieldedFetchResponse;
  }

  // Parse PAYMENT-RESPONSE header if present
  const paymentResponseHeader =
    retryResponse.headers.get("payment-response") ??
    retryResponse.headers.get("PAYMENT-RESPONSE");

  let settlement: SettleResponse | undefined;
  if (paymentResponseHeader) {
    try {
      settlement = decodePaymentResponseHeader(paymentResponseHeader);
    } catch {
      // Non-fatal — settlement data is optional
    }
  }

  // Attach x402 metadata
  retryResponse.x402 = {
    paid: true,
    amountPaid: selected.amount,
    asset: selected.asset,
    payTo: selected.payTo,
    settlement,
  };

  return retryResponse;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a wallet-bound fetch function with automatic x402 payment support.
 *
 * @example
 * ```typescript
 * const fetch = createShieldedFetchForWallet(shieldedWallet, { connection });
 * const res = await fetch('https://api.example.com/paid-endpoint');
 * ```
 */
export function createShieldedFetchForWallet(
  wallet: ShieldedWallet,
  defaults?: Omit<ShieldedFetchOptions, "body" | "method">,
): (url: string | URL, init?: RequestInit) => Promise<ShieldedFetchResponse> {
  return (url: string | URL, init?: RequestInit) =>
    shieldedFetch(wallet, url, { ...defaults, ...init });
}
