/**
 * Session-mint helper — Phase 9 Batch E (ISC-16..18).
 *
 * `mintSessionForAgent` is a thin convenience wrapper around the generated
 * `registerAgent` instruction builder. It accepts all derived PDAs as
 * pre-resolved inputs (caller derives them via `dashboard/findX` helpers)
 * and produces an unsigned instruction ready to drop into a transaction.
 *
 * Sigil's V2 model treats `register_agent` as the durable session-mint
 * operation: the owner authorises a specific (agent, mint) pair with a
 * capability tier and a per-session spending limit. The on-chain handler
 * mutates the agent set on `AgentPermissions`, bumps the policy version,
 * and appends a success entry to the audit log.
 *
 * Used by the dashboard "Authorize an Agent" wizard and by the
 * agent mobile-onboarding flow. Both consume the same helper to avoid
 * drift.
 */

import type { Address, TransactionSigner } from "@solana/kit";
import {
  getRegisterAgentInstruction,
  type RegisterAgentInstruction,
} from "./generated/instructions/registerAgent.js";

/**
 * Inputs to {@link mintSessionForAgent}.
 *
 * `capability` mirrors the on-chain `AgentCapability` discriminant
 * (0=READ_ONLY, 1=OPERATOR, 2=FULL — see `programs/sigil/src/state/agent.rs`).
 * `spendingLimitUsd` is in 6-decimal USDC units (e.g. `$500 = 500_000_000n`).
 *
 * Caller derives the PDAs via the dashboard helper layer:
 * - `policy` from `findPolicyConfigPda(vault)`
 * - `agentSpendOverlay` from `findAgentSpendOverlayPda(vault, agent)`
 * - `auditLogSuccess` from `findAuditLogSuccessPda(vault)`
 */
export interface MintSessionForAgentInputs {
  owner: TransactionSigner;
  vault: Address;
  agent: Address;
  capability: number;
  spendingLimitUsd: bigint;
  policy: Address;
  agentSpendOverlay: Address;
  auditLogSuccess: Address;
  /**
   * Override the default `SysvarS1otHashes111111111111111111111111111`.
   * Almost no caller should set this — the on-chain handler hard-codes
   * the canonical address.
   */
  slotHashesSysvar?: Address;
}

/**
 * Build the unsigned `register_agent` instruction that mints a session
 * for the given (agent, mint) pair.
 *
 * @example
 * ```ts
 * import { mintSessionForAgent } from "@usesigil/kit";
 *
 * const ix = mintSessionForAgent({
 *   owner: ownerSigner,
 *   vault: vaultPubkey,
 *   agent: agentPubkey,
 *   capability: 1, // OPERATOR
 *   spendingLimitUsd: 500_000_000n, // $500/day
 *   policy: policyConfigPda,
 *   agentSpendOverlay: agentSpendOverlayPda,
 *   auditLogSuccess: auditLogSuccessPda,
 * });
 * ```
 *
 * @throws Never — pure builder; on-chain handler enforces invariants.
 */
export function mintSessionForAgent(
  inputs: MintSessionForAgentInputs,
): RegisterAgentInstruction {
  const args: Parameters<typeof getRegisterAgentInstruction>[0] = {
    owner: inputs.owner,
    vault: inputs.vault,
    policy: inputs.policy,
    agentSpendOverlay: inputs.agentSpendOverlay,
    auditLogSuccess: inputs.auditLogSuccess,
    agent: inputs.agent,
    capability: inputs.capability,
    spendingLimitUsd: inputs.spendingLimitUsd,
  } as Parameters<typeof getRegisterAgentInstruction>[0];
  if (inputs.slotHashesSysvar !== undefined) {
    (args as unknown as { slotHashesSysvar: Address }).slotHashesSysvar =
      inputs.slotHashesSysvar;
  }
  return getRegisterAgentInstruction(args) as RegisterAgentInstruction;
}
