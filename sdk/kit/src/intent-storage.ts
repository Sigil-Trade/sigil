/**
 * Intent Storage — Kit-native
 *
 * Provides createIntent factory and MemoryIntentStorage implementation.
 * Types (IntentAction, TransactionIntent, IntentStorage, etc.) live in intents.ts.
 *
 * Kit differences from web3.js version:
 *   - vault/agent are Address (branded strings) — no PublicKey clone needed
 *   - spread operator copies strings by value, so defensive copy is simpler
 *   - Filter by vault uses string === instead of .toBase58() comparison
 */

import type { Address } from "@solana/kit";
import { randomUUID } from "crypto";
import type {
  IntentAction,
  IntentStatus,
  TransactionIntent,
  IntentStorage,
} from "./intents.js";
import { DEFAULT_INTENT_TTL_MS, summarizeAction } from "./intents.js";

// Re-export for convenience
export { DEFAULT_INTENT_TTL_MS, summarizeAction };
export type { IntentAction, IntentStatus, TransactionIntent, IntentStorage };

// ─── createIntent ────────────────────────────────────────────────────────────

/**
 * Create a new transaction intent with "pending" status.
 * Kit-native: vault/agent are Address (strings), no PublicKey cloning needed.
 */
export function createIntent(
  action: IntentAction,
  vault: Address,
  agent: Address,
  options?: { ttlMs?: number },
): TransactionIntent {
  const now = Date.now();
  const ttl = options?.ttlMs ?? DEFAULT_INTENT_TTL_MS;

  return {
    id: randomUUID(),
    action,
    vault,
    agent,
    status: "pending",
    createdAt: now,
    expiresAt: now + ttl,
    updatedAt: now,
    summary: summarizeAction(action),
  };
}

// ─── MemoryIntentStorage ─────────────────────────────────────────────────────

/**
 * In-memory intent storage with defensive copies.
 * Kit-native: Address is a string, so spread copy is sufficient (no PublicKey clone).
 */
export class MemoryIntentStorage implements IntentStorage {
  private readonly _intents = new Map<string, TransactionIntent>();

  private _clone(intent: TransactionIntent): TransactionIntent {
    return {
      ...intent,
      action: {
        ...intent.action,
        params: { ...intent.action.params },
      } as IntentAction,
    };
  }

  async save(intent: TransactionIntent): Promise<void> {
    this._intents.set(intent.id, this._clone(intent));
  }

  async get(id: string): Promise<TransactionIntent | null> {
    const intent = this._intents.get(id);
    return intent ? this._clone(intent) : null;
  }

  async list(filter?: {
    status?: IntentStatus;
    vault?: Address;
  }): Promise<TransactionIntent[]> {
    let results = Array.from(this._intents.values());

    if (filter?.status) {
      results = results.filter((i) => i.status === filter.status);
    }
    if (filter?.vault) {
      results = results.filter((i) => i.vault === filter.vault);
    }

    return results.map((i) => this._clone(i));
  }

  async update(
    id: string,
    updates: Partial<
      Pick<TransactionIntent, "status" | "updatedAt" | "error">
    >,
  ): Promise<void> {
    const existing = this._intents.get(id);
    if (!existing) {
      throw new Error(`Intent not found: ${id}`);
    }
    if (updates.status !== undefined) existing.status = updates.status;
    if (updates.updatedAt !== undefined) existing.updatedAt = updates.updatedAt;
    if (updates.error !== undefined) existing.error = updates.error;
  }
}
