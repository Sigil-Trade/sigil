/**
 * x402 Audit Trail — Kit-native
 *
 * Structured X402PaymentEvent emitter.
 * Calls config.onPayment() if configured.
 */

import type { X402Config, X402PaymentEvent, SettleResponse } from "./types.js";

/**
 * Emit a structured payment event through the audit callback.
 */
export function emitPaymentEvent(
  config: X402Config | undefined,
  event: X402PaymentEvent,
): void {
  if (config?.onPayment) {
    config.onPayment(event);
  }
}

/**
 * Create a payment event from the flow parameters.
 */
export function createPaymentEvent(params: {
  url: string;
  payTo: string;
  asset: string;
  amount: string;
  paid: boolean;
  deniedReason?: string;
  settlement?: SettleResponse;
  startTime: number;
  nonce?: string;
}): X402PaymentEvent {
  return {
    timestamp: Date.now(),
    url: params.url,
    payTo: params.payTo,
    asset: params.asset,
    amount: params.amount,
    paid: params.paid,
    deniedReason: params.deniedReason,
    settlement: params.settlement,
    nonce: params.nonce,
    durationMs: Date.now() - params.startTime,
  };
}
