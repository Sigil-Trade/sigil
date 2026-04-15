/**
 * walk — recursive cause-chain traversal.
 *
 * Returns the root cause when called without a predicate, or the first error
 * matching the predicate when called with one. Handles cyclic cause chains
 * via a visited set + max-depth fuse (10) so a malformed chain can never
 * cause infinite recursion.
 */
const MAX_WALK_DEPTH = 10;

export function walk(err: unknown): Error;
export function walk(err: unknown, fn: (e: unknown) => boolean): Error | null;
export function walk(err: unknown, fn?: (e: unknown) => boolean): Error | null {
  // Predicate variant — find first match in the chain.
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
  if (!(err instanceof Error)) return null;
  if (visited.has(err)) return null;
  if (depth >= MAX_WALK_DEPTH) return null;
  visited.add(err);
  if (fn(err)) return err;
  if (err.cause !== undefined) {
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
  if (depth >= MAX_WALK_DEPTH) return err;
  visited.add(err);
  if (err.cause !== undefined && err.cause !== err) {
    return walkRoot(err.cause, visited, depth + 1);
  }
  return err;
}
