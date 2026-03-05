import {
  evaluatePolicy as coreEvaluatePolicy,
  recordTransaction as coreRecordTransaction,
} from "@phalnx/core";
import type { PolicyViolation } from "@phalnx/core";
import { ShieldDeniedError } from "./errors";
import {
  ResolvedPolicies,
  TransactionAnalysis,
  toCoreAnalysis,
} from "./policies";
import { ShieldState } from "./state";

/**
 * Evaluate a transaction against resolved policies and current state.
 * Returns an array of violations (empty = transaction allowed).
 */
export function evaluatePolicy(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  state: ShieldState,
): PolicyViolation[] {
  const coreAnalysis = toCoreAnalysis(analysis);
  const violations = coreEvaluatePolicy(coreAnalysis, policies, state);

  // Handle wrapper-specific customCheck (receives PublicKey-based analysis)
  if (policies.customCheck) {
    const result = policies.customCheck(analysis);
    if (!result.allowed) {
      violations.push({
        rule: "unknown_program",
        message: result.reason ?? "Blocked by custom policy check",
        suggestion: "Review the custom policy configuration.",
      });
    }
  }

  return violations;
}

/**
 * Evaluate policies and throw ShieldDeniedError if any violations found.
 */
export function enforcePolicy(
  analysis: TransactionAnalysis,
  policies: ResolvedPolicies,
  state: ShieldState,
): void {
  const violations = evaluatePolicy(analysis, policies, state);
  if (violations.length > 0) {
    throw new ShieldDeniedError(violations);
  }
}

/**
 * After a transaction is signed, record the spend and transaction in state.
 */
export function recordTransaction(
  analysis: TransactionAnalysis,
  state: ShieldState,
): void {
  const coreAnalysis = toCoreAnalysis(analysis);
  coreRecordTransaction(coreAnalysis, state);
}
