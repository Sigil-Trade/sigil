/**
 * x402 shieldedFetch — Kit-native
 *
 * Core 17-step flow for HTTP 402 Payment Required support.
 * Uses Kit TransactionSigner, zero web3.js dependency.
 *
 * x402 payments are simple SPL transfers — NOT Phalnx-composed transactions.
 * Shield enforcement happens at the policy-bridge level, not the signer level.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  getBase58Decoder,
} from "@solana/kit";
import type { ShieldedContext } from "../shield.js";
import type {
  X402Config,
  ShieldedFetchOptions,
  ShieldedFetchResponse,
  SettleResponse,
} from "./types.js";
import { X402PaymentError } from "./errors.js";
import { signAndEncode } from "../rpc-helpers.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from "./codec.js";
import { selectPaymentOption } from "./payment-selector.js";
import { NonceTracker } from "./nonce-tracker.js";
import { validatePaymentAmount, recordPaymentAmount } from "./amount-guard.js";
import { evaluateX402Payment, recordX402Spend } from "./policy-bridge.js";
import { validateSettlement } from "./facilitator-verify.js";
import { emitPaymentEvent, createPaymentEvent } from "./audit-trail.js";
import { buildX402TransferInstruction } from "./transfer-builder.js";
import { resolveToken } from "../tokens.js";

// Global nonce tracker instance
const globalNonceTracker = new NonceTracker();

/**
 * Poll getSignatureStatuses() to confirm a payment TX landed on-chain.
 * Returns 3-state result:
 *   'confirmed' — TX confirmed/finalized on-chain
 *   'failed'    — TX explicitly errored on-chain (definitive failure)
 *   'timeout'   — No definitive answer within timeout
 * Pattern reused from rpc-helpers.ts sendAndConfirmTransaction polling.
 */
async function confirmSettlementOnChain(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: string,
  timeoutMs: number,
): Promise<"confirmed" | "failed" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (Date.now() < deadline) {
    const result = await rpc.getSignatureStatuses([txSignature as unknown as Parameters<typeof rpc.getSignatureStatuses>[0][0]]).send();
    const statuses = (result as unknown as { value: readonly (unknown | null)[] }).value;
    if (statuses?.[0]) {
      const status = statuses[0] as { err?: unknown; confirmationStatus?: string };
      if (status.err) return "failed";
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return "confirmed";
      }
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  return "timeout";
}

/**
 * Fetch a URL with automatic x402 payment support — Kit-native.
 *
 * 17-step flow:
 * 1. URL protocol validation
 * 2. Initial fetch
 * 3. Non-402 passthrough
 * 4. Extract PAYMENT-REQUIRED header
 * 5. Non-x402 402 passthrough
 * 6. Infinite loop guard
 * 7. Decode + validate header
 * 8. Select payment option with payTo allowlisting
 * 9. Replay check
 * 10. Amount sanity
 * 11. Policy pre-check (does NOT record spend)
 * 12. Dry-run exit point
 * 13. Build TransferChecked instruction
 * 14. Compose + sign transaction
 * 15. Retry with PAYMENT-SIGNATURE header
 * 16. Validate settlement response
 * 17. Record spend, emit audit event, return response
 */
export async function shieldedFetch(
  signer: TransactionSigner,
  url: string | URL,
  config?: X402Config,
  shieldCtx?: ShieldedContext,
  rpc?: Rpc<SolanaRpcApi>,
  fetchOptions?: ShieldedFetchOptions,
): Promise<ShieldedFetchResponse> {
  const startTime = Date.now();
  const urlStr = url.toString();
  const maxRetries = Math.min(Math.max(config?.maxRetries ?? 1, 1), 3);
  const effectiveRpc = fetchOptions?.rpc ?? rpc;

  // Step 0: Config warnings
  if (!config?.allowedDestinations || config.allowedDestinations.size === 0) {
    console.warn(
      "[x402] No allowedDestinations configured — accepting all payTo destinations. " +
        "Set X402Config.allowedDestinations for production use.",
    );
  }

  // Step 1: URL protocol validation (HTTPS only unless test override)
  if (!config?.allowInsecureUrls) {
    if (!urlStr.startsWith("https://")) {
      throw new X402PaymentError(
        "Only HTTPS URLs are supported for x402 payments. " +
          "Set allowInsecureUrls in X402Config for testing only.",
      );
    }
  } else {
    if (!urlStr.startsWith("https://") && !urlStr.startsWith("http://")) {
      throw new X402PaymentError(
        "Only HTTP/HTTPS URLs are supported for x402 payments",
      );
    }
  }

  // Build fetch init, stripping custom options
  const init: RequestInit = { ...fetchOptions };
  delete (init as Record<string, unknown>).rpc;
  delete (init as Record<string, unknown>).dryRun;
  delete (init as Record<string, unknown>).maxPayment;

  // Step 2: Initial fetch
  const response = await globalThis.fetch(urlStr, init);

  // Step 3: Non-402 passthrough
  if (response.status !== 402) {
    return response as ShieldedFetchResponse;
  }

  // Step 4: Extract PAYMENT-REQUIRED header (case-insensitive)
  const paymentRequiredHeader =
    response.headers.get("payment-required") ??
    response.headers.get("PAYMENT-REQUIRED");

  // Step 5: Non-x402 402 passthrough
  if (!paymentRequiredHeader) {
    return response as ShieldedFetchResponse;
  }

  // Step 6: Infinite loop guard — reject if PAYMENT-SIGNATURE already sent
  if (hasPaymentSignatureHeader(init.headers)) {
    throw new X402PaymentError(
      "Payment already attempted — refusing to retry to prevent infinite loops",
    );
  }

  // Step 7: Decode + validate header
  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

  // Step 8: Select payment option with payTo allowlisting
  const selected = selectPaymentOption(paymentRequired, config);

  // Step 9: Replay check
  if (config?.enableReplayProtection !== false) {
    await globalNonceTracker.checkOrThrow(urlStr, selected.payTo, selected.amount);
  }

  // Step 10: Amount sanity
  const parsedAmount = validatePaymentAmount(selected.amount, config);

  // Override maxPayment from fetch options
  if (
    fetchOptions?.maxPayment !== undefined &&
    parsedAmount > fetchOptions.maxPayment
  ) {
    throw new X402PaymentError(
      `Server requires ${selected.amount} but maxPayment is ${fetchOptions.maxPayment}`,
    );
  }

  // Step 11: Policy pre-check (does NOT record spend)
  if (shieldCtx) {
    const violations = evaluateX402Payment(
      selected,
      shieldCtx,
      config,
      signer.address,
    );
    if (violations.length > 0) {
      const event = createPaymentEvent({
        url: urlStr,
        payTo: selected.payTo,
        asset: selected.asset,
        amount: selected.amount,
        paid: false,
        deniedReason: violations.join("; "),
        startTime,
      });
      emitPaymentEvent(config, event);

      throw new X402PaymentError(
        `x402 payment denied by policy: ${violations.join("; ")}`,
      );
    }
  }

  // Step 12: Dry-run exit point
  if (fetchOptions?.dryRun) {
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

  // Step 13: Build TransferChecked instruction
  if (!effectiveRpc) {
    throw new X402PaymentError(
      "RPC connection required for x402 payments. Pass rpc in options.",
    );
  }

  const tokenInfo = resolveToken(selected.asset, "mainnet-beta");
  const decimals = tokenInfo?.decimals ?? 6;

  const transferIx = await buildX402TransferInstruction({
    from: signer.address,
    payTo: selected.payTo as Address,
    asset: selected.asset as Address,
    amount: parsedAmount,
    decimals,
  });

  // Step 14: Compose + sign transaction using Kit pipe()
  const { value: blockhashInfo } = await effectiveRpc
    .getLatestBlockhash()
    .send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        blockhashInfo as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0],
        tx,
      ),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
  );

  const compiledTx = compileTransaction(
    txMessage as Parameters<typeof compileTransaction>[0]
  );

  // Sign + encode using shared utility
  const wireBase64 = await signAndEncode(signer, compiledTx);

  // Extract client's expected TX signature from wire format
  // Wire format: 1 byte (compact-u16 sig count) + 64 bytes (first signature)
  let expectedTxSig: string | undefined;
  try {
    const wireBinary = atob(wireBase64);
    if (wireBinary.length > 64) {
      const sigBytes = new Uint8Array(64);
      for (let i = 0; i < 64; i++) sigBytes[i] = wireBinary.charCodeAt(i + 1);
      expectedTxSig = getBase58Decoder().decode(sigBytes);
    }
  } catch {
    // Non-fatal — sig extraction is for audit, not blocking
  }

  // Encode x402 payload
  const encodedPayload = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: selected,
    payload: { transaction: wireBase64 },
  });

  // Step 15: Retry with PAYMENT-SIGNATURE header
  const retryHeaders = new Headers(init.headers as Record<string, string>);
  retryHeaders.set("PAYMENT-SIGNATURE", encodedPayload);

  let retryResponse = (await globalThis.fetch(urlStr, {
    ...init,
    headers: retryHeaders,
  })) as ShieldedFetchResponse;

  for (
    let attempt = 1;
    attempt < maxRetries &&
    !(retryResponse.status >= 200 && retryResponse.status < 300);
    attempt++
  ) {
    retryResponse = (await globalThis.fetch(urlStr, {
      ...init,
      headers: retryHeaders,
    })) as ShieldedFetchResponse;
  }

  // Step 16: Validate settlement response
  const paymentResponseHeader =
    retryResponse.headers.get("payment-response") ??
    retryResponse.headers.get("PAYMENT-RESPONSE");

  let settlement: SettleResponse | undefined;
  if (paymentResponseHeader) {
    try {
      settlement = decodePaymentResponseHeader(paymentResponseHeader);
      const verification = await validateSettlement(settlement);
      if (verification.warnings.length > 0) {
        console.warn("[x402] Settlement warnings:", verification.warnings);
      }
    } catch {
      // Non-fatal — settlement data is optional
    }
  }

  // Settlement signature verification (D1: signature comparison)
  if (
    expectedTxSig &&
    settlement?.transaction &&
    settlement.transaction !== expectedTxSig
  ) {
    emitPaymentEvent(
      config,
      createPaymentEvent({
        url: urlStr,
        payTo: selected.payTo,
        asset: selected.asset,
        amount: selected.amount,
        paid: true,
        deniedReason: `Settlement signature mismatch: expected ${expectedTxSig}, got ${settlement.transaction}`,
        startTime,
      }),
    );
  }

  // Step 17: Record spend after on-chain confirmation (2.9.2 fix)
  if (retryResponse.ok) {
    if (config?.enableReplayProtection !== false) {
      await globalNonceTracker.record(urlStr, selected.payTo, selected.amount);
    }
    recordPaymentAmount(parsedAmount);

    // On-chain confirmation gate (2.9.2):
    //   confirmed → record spend
    //   failed    → DON'T record (TX errored on-chain)
    //   timeout   → record spend (defense-in-depth, can't confirm either way)
    //   disabled  → record spend (confirmPayment: false)
    let shouldRecordSpend = true;
    if (
      config?.confirmPayment !== false &&
      settlement?.transaction &&
      effectiveRpc
    ) {
      const timeout = config?.confirmPaymentTimeoutMs ?? 10_000;
      const status = await confirmSettlementOnChain(
        effectiveRpc, settlement.transaction, timeout,
      );
      if (status === "failed") {
        shouldRecordSpend = false;
        console.warn(
          `[x402] Payment TX ${settlement.transaction} failed on-chain — spend NOT recorded`,
        );
      } else if (status === "timeout") {
        console.warn(
          `[x402] Payment TX ${settlement.transaction} not confirmed within ${timeout}ms — recording spend (defense-in-depth)`,
        );
      }
    }

    if (shieldCtx && shouldRecordSpend) {
      recordX402Spend(shieldCtx, selected.asset, parsedAmount);
    }

    const event = createPaymentEvent({
      url: urlStr,
      payTo: selected.payTo,
      asset: selected.asset,
      amount: selected.amount,
      paid: true,
      settlement,
      startTime,
      nonce: NonceTracker.buildKey(urlStr, selected.payTo, selected.amount),
    });
    emitPaymentEvent(config, event);

    retryResponse.x402 = {
      paid: true,
      amountPaid: selected.amount,
      asset: selected.asset,
      payTo: selected.payTo,
      settlement,
    };
  } else {
    const failEvent = createPaymentEvent({
      url: urlStr,
      payTo: selected.payTo,
      asset: selected.asset,
      amount: selected.amount,
      paid: false,
      deniedReason: `Server returned ${retryResponse.status} after payment attempt`,
      startTime,
    });
    emitPaymentEvent(config, failEvent);

    retryResponse.x402 = {
      paid: false,
      amountPaid: selected.amount,
      asset: selected.asset,
      payTo: selected.payTo,
      settlement,
    };
  }

  return retryResponse;
}

/**
 * Create a wallet-bound fetch function with automatic x402 payment support.
 *
 * @example
 * ```typescript
 * const fetch402 = createShieldedFetch(signer, config, shieldCtx, rpc);
 * const res = await fetch402('https://api.example.com/paid-endpoint');
 * ```
 */
export function createShieldedFetch(
  signer: TransactionSigner,
  config?: X402Config,
  shieldCtx?: ShieldedContext,
  rpc?: Rpc<SolanaRpcApi>,
): (
  url: string | URL,
  init?: ShieldedFetchOptions,
) => Promise<ShieldedFetchResponse> {
  return (url: string | URL, init?: ShieldedFetchOptions) =>
    shieldedFetch(signer, url, config, shieldCtx, rpc, init);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function hasPaymentSignatureHeader(headers: RequestInit["headers"]): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) {
    return headers.has("PAYMENT-SIGNATURE") || headers.has("payment-signature");
  }
  if (Array.isArray(headers)) {
    return headers.some(([k]) => k.toLowerCase() === "payment-signature");
  }
  const rec = headers as Record<string, string>;
  return Object.keys(rec).some((k) => k.toLowerCase() === "payment-signature");
}
