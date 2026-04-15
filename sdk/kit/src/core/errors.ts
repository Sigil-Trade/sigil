import { SigilShieldError } from "../errors/shield.js";
import {
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__SHIELD__CONFIG_INVALID,
} from "../errors/codes.js";

/**
 * Common policy rule identifiers. The canonical type intentionally widens
 * to `string` via the `(string & {})` escape hatch because shield.ts +
 * velocity-tracker.ts use a rich set that exceeds any closed enum.
 * Use one of these values when raising a violation; new rule names are
 * permitted but should follow the snake_case convention for grep-discoverability.
 *
 * PR 2.A silent-failure-hunter fix (Finding 7): exhaustive list of every
 * `rule:` string actually used in-tree. Each addition here ALSO requires
 * a contributor to confirm the new rule string isn't a typo of an existing
 * one — the open `(string & {})` does not guard against typos.
 */
export type PolicyRule =
  | "spending_cap"
  | "transaction_size"
  | "protocol_not_allowed"
  | "token_not_allowed"
  | "rate_limit"
  | "unknown_program"
  | "simulation"
  | "velocity_ceiling"
  | "session_binding"
  | "program_allowlist"
  | "spend_limit"
  | "on_chain_tx_size"
  | "on_chain_vault_cap"
  | "on_chain_agent_cap"
  | "paused"
  | "custom"
  // velocity-tracker.ts rule names
  | "velocity_cooldown"
  | "velocity_tx_per_minute"
  | "velocity_tx_per_hour"
  | "velocity_usd_per_hour"
  | "velocity_on_chain_cap"
  | "velocity_rapid_fire"
  | (string & {});

export interface PolicyViolation {
  /** Which policy rule was violated. See `PolicyRule` for common values. */
  rule: PolicyRule;
  /** Human-readable description of the violation */
  message: string;
  /** Actionable suggestion for the developer. Required per UD4 (Path A). */
  suggestion: string;
  /** Additional context */
  details?: {
    limit?: bigint;
    attempted?: bigint;
    remaining?: bigint;
    programId?: string;
    tokenMint?: string;
  };
}

/**
 * Thrown when Shield policy denies a transaction.
 *
 * Canonical (single) definition. The historical duplicate at `src/shield.ts`
 * re-exports this class to preserve the import path.
 *
 * Per UD2 (Engineer-reorder via Council): rebased on `SigilShieldError` which
 * extends `SigilError`. `instanceof ShieldDeniedError` checks survive (class
 * name + .violations preserved); `instanceof SigilShieldError` and
 * `instanceof SigilError` checks now also work.
 */
export class ShieldDeniedError extends SigilShieldError<
  typeof SIGIL_ERROR__SHIELD__POLICY_DENIED
> {
  readonly violations: PolicyViolation[];

  constructor(violations: PolicyViolation[]) {
    const summary = violations.map((v) => v.message).join("; ");
    super(
      SIGIL_ERROR__SHIELD__POLICY_DENIED,
      `Transaction denied by Sigil: ${summary}`,
      {
        context: { violations },
      },
    );
    this.name = "ShieldDeniedError";
    this.violations = violations;
  }
}

/**
 * Thrown for Shield configuration errors (invalid policy / config inputs).
 *
 * Per UD2: rebased on `SigilShieldError`. `instanceof ShieldConfigError`
 * checks survive.
 */
export class ShieldConfigError extends SigilShieldError<
  typeof SIGIL_ERROR__SHIELD__CONFIG_INVALID
> {
  constructor(message: string) {
    super(SIGIL_ERROR__SHIELD__CONFIG_INVALID, message);
    this.name = "ShieldConfigError";
  }
}
