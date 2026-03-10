/**
 * IntentEngine — Agent-Facing Facade
 *
 * Wraps PhalnxClient's intent execution into a clean,
 * agent-optimized workflow: validate → precheck → execute.
 *
 * All delegation, no duplication — uses PhalnxClient under the hood.
 */

import type { PublicKey } from "@solana/web3.js";
import type { Signer } from "@solana/web3.js";
import type { PhalnxClient } from "./client";
import type {
  IntentAction,
  IntentActionType,
  PrecheckResult,
  ExecuteResult,
} from "./intents";
import type { AgentError } from "./agent-errors";
import type {
  ProtocolHandlerMetadata,
  ProtocolActionDescriptor,
} from "./integrations/protocol-handler";
import { validateIntentInput, type ValidationResult } from "./intent-validator";
import { toAgentError, protocolEscalationError } from "./agent-errors";
import { resolveProtocol, ProtocolTier } from "./protocol-resolver";
import type { ProtocolRegistry } from "./integrations/protocol-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of IntentEngine.explain() — transaction plan without execution */
export interface ExplainResult {
  /** Human-readable summary of what the transaction will do */
  summary: string;
  /** The intent action type */
  actionType: IntentActionType;
  /** Whether this action counts against spending cap */
  isSpending: boolean;
  /** Precheck result (spending capacity, permissions, etc.) */
  precheck: PrecheckResult;
}

/** Protocol info for discovery */
export interface ProtocolInfo {
  protocolId: string;
  displayName: string;
  programIds: string[];
  actionCount: number;
}

/** Action info for protocol exploration */
export interface ActionInfo {
  name: string;
  isSpending: boolean;
}

// ---------------------------------------------------------------------------
// IntentEngine
// ---------------------------------------------------------------------------

export class IntentEngine {
  constructor(private readonly client: PhalnxClient) {}

  // ─── Core Agent Workflow ─────────────────────────────────────────────

  /**
   * Full agent workflow: validate → precheck → execute.
   *
   * Returns ExecuteResult on success or AgentError on failure at any stage.
   * This is the primary method agents should call.
   */
  async run(
    intent: IntentAction,
    vault: PublicKey,
    options?: { skipPrecheck?: boolean; signers?: Signer[] },
  ): Promise<ExecuteResult | AgentError> {
    // 1. Validate inputs
    const validation = this.validate(intent);
    if (!validation.valid) {
      return validation.errors[0];
    }

    // 2. Protocol resolution (for protocol/passthrough intents — short-circuits before precheck)
    if (intent.type === "protocol" || intent.type === "passthrough") {
      try {
        const resolution = await this._resolveProtocolTier(intent, vault);
        if (resolution && resolution.tier === ProtocolTier.NOT_SUPPORTED && resolution.escalation) {
          return protocolEscalationError(resolution.escalation);
        }
      } catch (err) {
        return toAgentError(err, { phase: "protocol_resolution" });
      }
    }

    // 3. Precheck (unless skipped)
    if (!options?.skipPrecheck) {
      try {
        const precheck = await this.precheck(intent, vault);
        if (!precheck.allowed) {
          return toAgentError(
            new Error(
              `Precheck failed: ${precheck.reason ?? precheck.summary}`,
            ),
            {
              precheck_details: precheck.details,
              risk_flags: precheck.riskFlags,
            },
          );
        }
      } catch (err) {
        return toAgentError(err, { phase: "precheck" });
      }
    }

    // 4. Execute
    try {
      return await this.client.execute(intent, vault, options);
    } catch (err) {
      return toAgentError(err, { phase: "execute", intent_type: intent.type });
    }
  }

  // ─── Individual Steps ────────────────────────────────────────────────

  /**
   * Validate intent parameters without hitting RPC.
   * Catches hallucinated inputs (negative amounts, invalid addresses, etc.).
   */
  validate(intent: IntentAction): ValidationResult {
    return validateIntentInput(intent);
  }

  /**
   * Check if the intent would succeed given current vault state.
   * Verifies permissions, spending caps, protocol allowlist, etc.
   */
  async precheck(
    intent: IntentAction,
    vault: PublicKey,
  ): Promise<PrecheckResult> {
    return this.client.precheck(intent, vault);
  }

  /**
   * Execute the intent (build, sign, send transaction).
   * Call validate() and precheck() first, or use run() for the full workflow.
   */
  async execute(
    intent: IntentAction,
    vault: PublicKey,
    options?: { skipPrecheck?: boolean; signers?: Signer[] },
  ): Promise<ExecuteResult> {
    return this.client.execute(intent, vault, options);
  }

  // ─── Transaction Plan Inspection ─────────────────────────────────────

  /**
   * Explain what a transaction would do without executing it.
   * Like SQL EXPLAIN — shows the plan, not the result.
   */
  async explain(
    intent: IntentAction,
    vault: PublicKey,
  ): Promise<ExplainResult | AgentError> {
    // Validate first
    const validation = this.validate(intent);
    if (!validation.valid) {
      return validation.errors[0];
    }

    try {
      const precheck = await this.client.precheck(intent, vault);

      // Import ACTION_TYPE_MAP dynamically to avoid circular deps at module level
      const { ACTION_TYPE_MAP, summarizeAction } = await import("./intents");

      const mapping = ACTION_TYPE_MAP[intent.type];

      return {
        summary: summarizeAction(intent),
        actionType: intent.type,
        isSpending: mapping?.isSpending ?? false,
        precheck,
      };
    } catch (err) {
      return toAgentError(err, { phase: "explain" });
    }
  }

  // ─── Discovery ──────────────────────────────────────────────────────

  /**
   * List all registered protocols and their capabilities.
   */
  listProtocols(): ProtocolInfo[] {
    const registry = this._getRegistry();
    return registry.listAll().map((meta) => ({
      protocolId: meta.protocolId,
      displayName: meta.displayName,
      programIds: meta.programIds.map((p) => p.toBase58()),
      actionCount: meta.supportedActions.size,
    }));
  }

  // ─── Protocol Resolution (Internal) ────────────────────────────────

  /**
   * Resolve protocol tier for protocol/passthrough intents.
   * Short-circuits before precheck if the protocol is NOT_SUPPORTED.
   */
  private async _resolveProtocolTier(
    intent: IntentAction,
    vault: PublicKey,
  ): Promise<import("./protocol-resolver").ProtocolResolution | null> {
    const { PublicKey: PK } = await import("@solana/web3.js");

    // Extract program ID from intent
    let programId: PublicKey | null = null;
    if (intent.type === "protocol") {
      const protocolId = (intent.params as any).protocolId as string | undefined;
      if (protocolId) {
        const registry = this._getRegistry();
        const handler = registry.getByProtocolId(protocolId);
        if (handler?.metadata.programIds[0]) {
          programId = handler.metadata.programIds[0];
        }
      }
    } else if (intent.type === "passthrough") {
      const pid = (intent.params as any).programId as string | undefined;
      if (pid) {
        try {
          programId = new PK(pid);
        } catch {
          // Invalid pubkey — will fail at execute
        }
      }
    }

    if (!programId) return null;

    // Fetch policy + constraints
    const [policy, constraints] = await Promise.all([
      this.client.fetchPolicy(vault),
      this.client.fetchConstraints(vault).catch(() => null),
    ]);

    return resolveProtocol(
      programId,
      this._getRegistry(),
      { protocolMode: policy.protocolMode, protocols: policy.protocols },
      constraints !== null && policy.hasConstraints,
    );
  }

  private _getRegistry(): ProtocolRegistry {
    return (
      this.client as unknown as { _protocolRegistry: ProtocolRegistry }
    )._protocolRegistry;
  }

  /**
   * List supported actions for a specific protocol.
   */
  listActions(protocolId: string): ActionInfo[] {
    const registry = this._getRegistry();
    const handler = registry.getByProtocolId(protocolId);
    if (!handler) return [];

    const actions: ActionInfo[] = [];
    handler.metadata.supportedActions.forEach(
      (descriptor: ProtocolActionDescriptor, name: string) => {
        actions.push({
          name,
          isSpending: descriptor.isSpending,
        });
      },
    );
    return actions;
  }
}
