/**
 * x402 Types — Kit-native
 *
 * Types for the x402 HTTP 402 Payment Required protocol.
 * Zero dependency on @solana/web3.js. Uses Kit's Address type.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import type { ShieldedContext } from "../shield.js";

// ─── x402 Protocol Types ────────────────────────────────────────────────────

/** Decoded from base64 PAYMENT-REQUIRED response header. */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** A single payment option offered by the API server. */
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

/** Signed payment payload sent back via PAYMENT-SIGNATURE header. */
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

// ─── Kit-native Configuration ───────────────────────────────────────────────

/** Configuration for x402 payment handling. */
export interface X402Config {
  /** payTo destination allowlisting — SECURITY-CRITICAL against prompt injection */
  allowedDestinations?: Set<Address>;
  /** Token filter — only pay with these tokens */
  allowedTokens?: Set<Address>;
  /** Per-payment ceiling in token base units */
  maxPaymentPerRequest?: bigint;
  /** Rolling window cumulative spending limit */
  maxCumulativeSpend?: bigint;
  /** Cumulative window duration in ms (default: 86_400_000 = 24h) */
  cumulativeWindowMs?: number;
  /** Settlement retries if non-2xx (default: 1, max: 3) */
  maxRetries?: number;
  /** Enable nonce-based replay protection (default: true) */
  enableReplayProtection?: boolean;
  /** Audit callback — called on every payment attempt */
  onPayment?: (event: X402PaymentEvent) => void;
  /** Allow http:// URLs (testing only — NEVER in production) */
  allowInsecureUrls?: boolean;
  /** Verify payment TX on-chain before recording spend (default: true).
   *  When true, calls getSignatureStatuses() after settlement to confirm
   *  the TX landed. Falls back to recording on timeout (defense-in-depth). */
  confirmPayment?: boolean;
  /** On-chain confirmation timeout in ms (default: 10_000) */
  confirmPaymentTimeoutMs?: number;
}

/** Options for shieldedFetch(). */
export interface ShieldedFetchOptions extends RequestInit {
  /** Solana RPC for blockhash + ATA resolution */
  rpc?: Rpc<SolanaRpcApi>;
  /** If true, evaluate policies but don't pay */
  dryRun?: boolean;
  /** Max payment in token base units — reject if server asks more */
  maxPayment?: bigint;
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

// ─── Audit Trail ────────────────────────────────────────────────────────────

/** Structured event emitted for every x402 payment attempt. */
export interface X402PaymentEvent {
  timestamp: number;
  url: string;
  payTo: string;
  asset: string;
  amount: string;
  paid: boolean;
  deniedReason?: string;
  settlement?: SettleResponse;
  nonce?: string;
  durationMs: number;
}
