/**
 * walk — recursive cause-chain traversal.
 *
 * Returns the root cause when called without a predicate, or the first error
 * matching the predicate when called with one. Handles cyclic cause chains
 * via a visited set + max-depth fuse so a malformed chain can never cause
 * infinite recursion.
 *
 * PR 2.A silent-failure-hunter fix (Finding 1):
 *   - MAX_WALK_DEPTH raised from 10 → 32 (matches viem's BaseError
 *     behavior; real-world chains routinely exceed 10 when SDK + Solana +
 *     Anchor + custody layers stack). Emits a one-shot console.warn when
 *     the fuse triggers so chain-truncation is observable.
 *   - Predicate variant now also tests non-Error causes (e.g., undici's
 *     `cause: { code: "ECONNRESET" }` shape) by passing them to fn before
 *     bailing. Previously these were silently dropped from the search.
 */
const MAX_WALK_DEPTH = 32;
let depthFuseWarned = false;

/**
 * Reset the depth-fuse warning flag. Call in test `beforeEach` to ensure
 * each test can independently verify fuse behavior without cross-test
 * suppression. (H2 audit fix — silent-failure-hunter.)
 *
 * @internal Exported for testing only. Not part of the public API.
 */
export function resetWalkFuse(): void {
  depthFuseWarned = false;
}

function warnFuseTrip(): void {
  if (depthFuseWarned) return;
  depthFuseWarned = true;
  console.warn(
    `[@usesigil/kit/walk] cause-chain depth exceeded ${MAX_WALK_DEPTH} levels — ` +
      `chain truncated. If this is a real chain (not a cycle), file an issue at ` +
      `https://github.com/Sigil-Trade/sigil/issues with reproduction.`,
  );
}

export function walk(err: unknown): Error;
export function walk(err: unknown, fn: (e: unknown) => boolean): Error | null;
export function walk(err: unknown, fn?: (e: unknown) => boolean): Error | null {
  // Predicate variant — find first match in the chain (including non-Error causes).
  if (fn) {
    return walkPredicate(err, fn, new Set(), 0);
  }
  // No-arg variant — find root cause.
  return walkRoot(err, new Set(), 0);
}

function walkPredicate(
  err: unknown,
  fn: (e: unknown) => boolean,
  visited: Set<unknown>,
  depth: number,
): Error | null {
  if (depth >= MAX_WALK_DEPTH) {
    warnFuseTrip();
    return null;
  }
  if (visited.has(err)) return null;
  visited.add(err);
  // Run predicate on ANY cause (including non-Error values like undici's
  // `cause: { code: "ECONNRESET" }`). Only Error instances may have a
  // further `.cause` chain to descend into.
  if (fn(err)) return err instanceof Error ? err : new Error(String(err));
  if (err instanceof Error && err.cause !== undefined) {
    return walkPredicate(err.cause, fn, visited, depth + 1);
  }
  return null;
}

function walkRoot(err: unknown, visited: Set<unknown>, depth: number): Error {
  // For non-Error inputs, wrap so the contract (returns Error) holds.
  if (!(err instanceof Error)) {
    return new Error(typeof err === "string" ? err : "non-Error cause");
  }
  if (visited.has(err)) return err;
  if (depth >= MAX_WALK_DEPTH) {
    warnFuseTrip();
    return err;
  }
  visited.add(err);
  if (err.cause !== undefined && err.cause !== err) {
    return walkRoot(err.cause, visited, depth + 1);
  }
  return err;
}
