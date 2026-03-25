/**
 * Protocol Resolver — Kit-native
 *
 * Determines protocol tier for allowlist/constraint enforcement:
 *   KNOWN: Program is in the known protocols registry
 *   DEFAULT: Passthrough with on-chain constraints
 *   NOT_ALLOWED: Blocked by policy
 */

import type { Address } from "@solana/kit";
import * as Core from "@phalnx/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum ProtocolTier {
  KNOWN = 1,
  DEFAULT = 2,
  NOT_ALLOWED = 3,
}

export interface ProtocolResolution {
  tier: ProtocolTier;
  protocolId: string;
  programId: Address;
  displayName: string;
  reason: string;
  constraintsConfigured?: boolean;
  escalation?: EscalationInfo;
}

export interface EscalationInfo {
  type:
    | "not_in_allowlist"
    | "no_handler_no_constraints"
    | "no_handler_has_constraints"
    | "not_in_allowlist_and_no_handler";
  message: string;
  requiredActions: string[];
}

// ---------------------------------------------------------------------------
// Core Logic
// ---------------------------------------------------------------------------

/**
 * Check if a program is in the vault's protocol allowlist/denylist.
 *
 * @param programId - Program address to check
 * @param policy - Vault policy with protocolMode and protocols list
 * @returns true if the program is allowed by the policy
 */
export function isProtocolAllowed(
  programId: Address,
  policy: { protocolMode: number; protocols: Address[] },
): boolean {
  if (policy.protocolMode === 0) return true; // mode 0: all allowed
  const isInList = policy.protocols.some((p) => p === programId);
  if (policy.protocolMode === 1) return isInList; // allowlist
  return !isInList; // denylist
}

/**
 * Resolve the tier and escalation info for a given protocol.
 *
 * Resolution logic:
 * 1. Known program + in allowlist -> KNOWN
 * 2. Known program + NOT in allowlist -> NOT_ALLOWED
 * 3. Unknown program + in allowlist + constraints -> DEFAULT (passthrough)
 * 4. Unknown program + in allowlist + NO constraints -> NOT_ALLOWED (escalation)
 * 5. Unknown program + NOT in allowlist -> NOT_ALLOWED (escalation)
 */
export function resolveProtocol(
  programId: Address,
  policy: { protocolMode: number; protocols: Address[] },
  constraintsConfigured: boolean,
): ProtocolResolution {
  const allowed = isProtocolAllowed(programId, policy);
  const knownName = Core.KNOWN_PROTOCOLS.get(programId as string);

  if (knownName) {
    if (!allowed) {
      // Path 2: Known but not in allowlist
      return {
        tier: ProtocolTier.NOT_ALLOWED,
        protocolId: programId,
        programId,
        displayName: knownName,
        reason: `${knownName} is not in the vault's protocol allowlist`,
        escalation: {
          type: "not_in_allowlist",
          message: `${knownName} (${programId}) is not in your vault's protocol allowlist.`,
          requiredActions: [
            `Add program ${programId} to the vault's protocol allowlist`,
          ],
        },
      };
    }

    // Path 1: Known + allowed
    return {
      tier: ProtocolTier.KNOWN,
      protocolId: programId,
      programId,
      displayName: knownName,
      reason: `${knownName} is a known protocol`,
    };
  }

  // Unknown protocol
  if (allowed && constraintsConfigured) {
    // Path 3: Unknown + allowed + constraints -> passthrough
    return {
      tier: ProtocolTier.DEFAULT,
      protocolId: programId,
      programId,
      displayName: programId,
      reason:
        "Unknown protocol — using on-chain constraint validation (passthrough)",
      constraintsConfigured: true,
    };
  }

  if (allowed && !constraintsConfigured) {
    // Path 4: Unknown + allowed + no constraints
    return {
      tier: ProtocolTier.NOT_ALLOWED,
      protocolId: programId,
      programId,
      displayName: programId,
      reason:
        "Protocol is allowed but no constraints are configured for validation",
      escalation: {
        type: "no_handler_no_constraints",
        message: `Program ${programId} is in the allowlist but has no on-chain instruction constraints configured.`,
        requiredActions: [
          `Configure instruction constraints for program ${programId} using createConstraints`,
        ],
      },
    };
  }

  // Path 5: Unknown + not in allowlist
  return {
    tier: ProtocolTier.NOT_ALLOWED,
    protocolId: programId,
    programId,
    displayName: programId,
    reason: "Protocol is not in the vault's allowlist",
    escalation: {
      type: "not_in_allowlist_and_no_handler",
      message: `Program ${programId} is not in the vault's protocol allowlist.`,
      requiredActions: [
        `Add program ${programId} to the vault's protocol allowlist`,
        `Configure instruction constraints for program ${programId}`,
      ],
    },
  };
}
