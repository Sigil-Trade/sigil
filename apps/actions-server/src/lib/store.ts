export interface ProvisionRecord {
  status: "pending" | "confirmed" | "not_found";
  vaultAddress?: string;
  agentPubkey?: string;
  template?: string;
  createdAt: number;
}

/**
 * In-memory store for tracking provision requests.
 * Entries expire after 10 minutes to avoid unbounded growth.
 */
const store = new Map<string, ProvisionRecord>();
const EXPIRY_MS = 10 * 60 * 1000;

export function setProvision(
  txSignature: string,
  record: ProvisionRecord,
): void {
  store.set(txSignature, record);
}

export function getProvision(
  txSignature: string,
): ProvisionRecord | undefined {
  const record = store.get(txSignature);
  if (record && Date.now() - record.createdAt > EXPIRY_MS) {
    store.delete(txSignature);
    return undefined;
  }
  return record;
}

/** Periodic cleanup of expired entries */
export function cleanExpired(): void {
  const now = Date.now();
  for (const [key, record] of store) {
    if (now - record.createdAt > EXPIRY_MS) {
      store.delete(key);
    }
  }
}
