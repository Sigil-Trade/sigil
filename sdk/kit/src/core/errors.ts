export interface PolicyViolation {
  /** Which policy rule was violated */
  rule:
    | "spending_cap"
    | "transaction_size"
    | "protocol_not_allowed"
    | "token_not_allowed"
    | "rate_limit"
    | "unknown_program";
  /** Human-readable description of the violation */
  message: string;
  /** Actionable suggestion for the developer */
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

export class ShieldDeniedError extends Error {
  readonly violations: PolicyViolation[];

  constructor(violations: PolicyViolation[]) {
    const summary = violations.map((v) => v.message).join("; ");
    super(`Transaction denied by Sigil: ${summary}`);
    this.name = "ShieldDeniedError";
    this.violations = violations;
  }
}

export class ShieldConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShieldConfigError";
  }
}
