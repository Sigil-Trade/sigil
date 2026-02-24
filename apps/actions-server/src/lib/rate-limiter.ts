/**
 * IP-based in-memory rate limiter.
 * Canonical copy — api/actions/provision-tee.ts has a simplified inline version (no lazy eviction).
 * 5 requests per IP per hour. Imperfect on serverless (fresh Map per cold start)
 * but catches warm-instance spam. Real defense is Crossmint linkedUser idempotency.
 */

const MAX_REQUESTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();

/** Evict expired entries periodically to prevent unbounded memory growth. */
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key);
  }
}

export function checkRateLimit(ip: string): {
  allowed: boolean;
  retryAfterMs?: number;
} {
  maybeCleanup();
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now >= entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count += 1;
  return { allowed: true };
}

/** Extract client IP from request headers (Vercel / standard proxies). */
export function getClientIp(headers: {
  get(name: string): string | null;
}): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") || "unknown";
}

/** Reset all rate limit state. For testing only. */
export function _resetForTesting(): void {
  store.clear();
  lastCleanup = Date.now();
}
