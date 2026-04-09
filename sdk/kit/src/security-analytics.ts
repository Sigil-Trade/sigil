/**
 * Security analytics — posture checklist, alert conditions, audit trail.
 *
 * The Security tab renders:
 * - Binary pass/fail checklist (getSecurityPosture)
 * - Alert conditions (evaluateAlertConditions) for toasts, email, webhooks
 *
 * Why binary pass/fail instead of a score: A vault with FULL_PERMISSIONS on one
 * agent and perfect everything else would get "90/100" — dangerously misleading.
 */

import { getAddressEncoder, type Address } from "@solana/kit";
import type {
  ResolvedVaultState,
  ResolvedVaultStateForOwner,
} from "./state-resolver.js";
import type { DecodedSigilEvent } from "./events.js";
import { VaultStatus } from "./generated/types/vaultStatus.js";
import { getSpendingVelocity } from "./spending-analytics.js";
import { describeEvent } from "./event-analytics.js";
import { formatUsd, formatAddress } from "./formatting.js";
import {
  FULL_PERMISSIONS,
  PROTOCOL_MODE_ALLOWLIST,
  EPOCH_DURATION,
  MAX_DEVELOPER_FEE_RATE,
} from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SecurityCheck {
  id: string;
  label: string;
  passed: boolean;
  severity: "critical" | "warning" | "info";
  detail: string;
  remediation: string | null;
}

export interface SecurityPosture {
  checks: SecurityCheck[];
  passCount: number;
  failCount: number;
  criticalFailures: SecurityCheck[];
}

export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  vaultAddress: Address;
  agentAddress: Address | null;
  actionHref: string;
  actionLabel: string;
}

export interface AuditEntry {
  timestamp: number;
  txSignature: string;
  category:
    | "policy_change"
    | "agent_change"
    | "emergency"
    | "escrow"
    | "constraint_change";
  action: string;
  actor: Address;
  details: Record<string, unknown>;
  description: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Count set bits in a bigint permission bitmask. */
function countBits(n: bigint): number {
  let count = 0;
  let v = n;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
}

// ─── getSecurityPosture ──────────────────────────────────────────────────────

/**
 * 20-point security posture checklist. Pure function — no RPC.
 * Checks 1-13: base. 14-17: timelock, fee, constraint alignment, permission concentration.
 * Checks 18-19: discriminator staleness, allowlist coverage. Check 20: mode-ALL warning.
 */
export function getSecurityPosture(state: ResolvedVaultState): SecurityPosture {
  const { vault, policy, constraints } = state;

  const checks: SecurityCheck[] = [
    {
      id: "no-full-perms",
      label: "No agent has full permissions",
      passed: !vault.agents.some((a) => a.permissions === FULL_PERMISSIONS),
      severity: "critical",
      detail:
        "An agent with all 21 permission bits can perform any action including transfers.",
      remediation: vault.agents.some((a) => a.permissions === FULL_PERMISSIONS)
        ? "Restrict agent permissions to only the actions they need."
        : null,
    },
    {
      id: "cap-configured",
      label: "Daily spending cap is configured",
      passed: policy.dailySpendingCapUsd > 0n,
      severity: "critical",
      detail: "Without a cap, agents can spend unlimited amounts in 24 hours.",
      remediation:
        policy.dailySpendingCapUsd === 0n
          ? "Set a daily spending cap. Start with your expected daily volume + 20% buffer."
          : null,
    },
    {
      id: "fee-destination-valid",
      label: "Fee destination is not system program",
      passed:
        vault.feeDestination !==
        ("11111111111111111111111111111111" as Address),
      severity: "critical",
      detail: "Fees sent to the system program address are effectively burned.",
      remediation:
        "Fee destination is immutable after vault creation. If incorrect, close and recreate the vault.",
    },
    {
      id: "agent-limits",
      label: "All agents have spending limits",
      passed:
        vault.agents.length === 0 ||
        vault.agents.every((a) => a.spendingLimitUsd > 0n),
      severity: "warning",
      detail:
        "Per-agent limits prevent any single agent from consuming the entire vault cap.",
      remediation: vault.agents.some((a) => a.spendingLimitUsd === 0n)
        ? "Set per-agent spending limits."
        : null,
    },
    {
      id: "protocol-allowlist",
      label: "Protocol mode is allowlist",
      passed: policy.protocolMode === PROTOCOL_MODE_ALLOWLIST,
      severity: "warning",
      detail: "Allowlist mode restricts agents to approved protocols only.",
      remediation:
        policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST
          ? "Switch to Allowlist mode and add only the protocols your agents need."
          : null,
    },
    {
      id: "timelock-enabled",
      label: "Policy changes require waiting period",
      passed: policy.timelockDuration > 0n,
      severity: "warning",
      detail:
        "A timelock prevents instant policy changes. Gives time to respond if owner key is compromised.",
      remediation:
        policy.timelockDuration === 0n
          ? "Enable timelock (recommended: 1-24 hours)."
          : null,
    },
    {
      id: "slippage-reasonable",
      label: "Max slippage below 10%",
      passed: policy.maxSlippageBps < 1000,
      severity: "warning",
      detail:
        "High slippage tolerance allows agents to accept unfavorable trade prices.",
      remediation:
        policy.maxSlippageBps >= 1000
          ? `Current max slippage is ${policy.maxSlippageBps / 100}%. Reduce to 1-3% for most strategies.`
          : null,
    },
    {
      id: "agent-limits-sum",
      label: "Agent limits don't exceed vault cap",
      passed: (() => {
        if (vault.agents.length === 0) return true;
        const sumLimits = vault.agents.reduce(
          (s, a) => s + a.spendingLimitUsd,
          0n,
        );
        const allHaveLimits = vault.agents.every(
          (a) => a.spendingLimitUsd > 0n,
        );
        return !allHaveLimits || sumLimits <= policy.dailySpendingCapUsd;
      })(),
      severity: "warning",
      detail:
        "If per-agent limits sum to more than the vault cap, agents may assume they have more budget than exists.",
      remediation:
        "Reduce per-agent limits so their sum is at or below the vault daily cap.",
    },
    {
      id: "constraints-configured",
      label: "Instruction constraints are set",
      passed: constraints !== null,
      severity: "info",
      detail:
        "Instruction constraints add byte-level validation on DeFi instructions.",
      remediation:
        constraints === null
          ? "Consider adding instruction constraints for high-value vaults."
          : null,
    },
    {
      id: "has-agents",
      label: "At least one agent is registered",
      passed: vault.agents.length > 0,
      severity: "info",
      detail: "A vault without agents cannot execute any DeFi operations.",
      remediation:
        vault.agents.length === 0
          ? "Register an agent to start using this vault."
          : null,
    },
    {
      id: "not-all-paused",
      label: "At least one agent is active",
      passed: vault.agents.length === 0 || vault.agents.some((a) => !a.paused),
      severity: "info",
      detail: "If all agents are paused, no DeFi operations can be executed.",
      remediation:
        vault.agents.length > 0 && vault.agents.every((a) => a.paused)
          ? "Unpause at least one agent to resume operations."
          : null,
    },
    {
      id: "vault-has-balance",
      label: "Vault has non-zero token balance",
      passed:
        state.stablecoinBalances.usdc > 0n ||
        state.stablecoinBalances.usdt > 0n,
      severity: "info",
      detail: "A vault with zero balance cannot execute any DeFi operations.",
      remediation: "Deposit funds to the vault to enable agent trading.",
    },
    {
      id: "recent-activity",
      label: "Vault has recent activity (within 7 days)",
      passed: (() => {
        if (!state.tracker) return true;
        const epochDuration = BigInt(EPOCH_DURATION);
        const lastEpochTimestamp = state.tracker.lastWriteEpoch * epochDuration;
        const sevenDaysAgo = state.resolvedAtTimestamp - 604800n;
        return (
          lastEpochTimestamp > sevenDaysAgo ||
          state.tracker.lastWriteEpoch === 0n
        );
      })(),
      severity: "info",
      detail:
        "A vault with no recent activity may indicate a broken or stopped agent.",
      remediation: "Check agent health and ensure it's connected and running.",
    },
    // ---- Step 8: 4 new checks (14-17) ----
    {
      id: "timelock-meaningful",
      label: "Timelock is at least 1 hour",
      passed:
        policy.timelockDuration === 0n || policy.timelockDuration >= 3600n,
      severity: "warning",
      detail:
        "A timelock under 1 hour may not provide enough reaction time if the owner key is compromised. " +
        "A zero timelock (disabled) is caught by the 'timelock-enabled' check above.",
      remediation:
        policy.timelockDuration > 0n && policy.timelockDuration < 3600n
          ? `Current timelock is ${Number(policy.timelockDuration)}s. Increase to at least 3600s (1 hour).`
          : null,
    },
    {
      id: "fee-rate-reasonable",
      label: "Developer fee rate is at or below maximum",
      passed: (policy.developerFeeRate ?? 0) <= MAX_DEVELOPER_FEE_RATE,
      severity: "info",
      detail:
        "Developer fee rate must be at or below 500 (5 BPS = 0.05%). " +
        "A zero rate is valid (no developer revenue). A rate at the maximum is valid but should be intentional.",
      remediation:
        (policy.developerFeeRate ?? 0) > MAX_DEVELOPER_FEE_RATE
          ? `Fee rate ${policy.developerFeeRate} exceeds maximum ${MAX_DEVELOPER_FEE_RATE}. This should not be possible on-chain.`
          : (policy.developerFeeRate ?? 0) === MAX_DEVELOPER_FEE_RATE
            ? "Developer fee rate is at the maximum (5 BPS). Verify this is intentional."
            : null,
    },
    {
      id: "constraints-protocol-aligned",
      label: "Constraint programs are in allowlist",
      passed: (() => {
        if (
          !constraints ||
          !constraints.entries ||
          policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST
        )
          return true;
        if (!policy.protocols) return true;
        const encoder = getAddressEncoder();
        const allowedBytes = policy.protocols.map((p) => encoder.encode(p));
        const activeEntries = constraints.entries.slice(
          0,
          constraints.entryCount,
        );
        for (const entry of activeEntries) {
          const matches = allowedBytes.some((ab) => {
            if (ab.length !== entry.programId.length) return false;
            for (let i = 0; i < 32; i++) {
              if (ab[i] !== entry.programId[i]) return false;
            }
            return true;
          });
          if (!matches) return false;
        }
        return true;
      })(),
      severity: "warning",
      detail:
        "Instruction constraints reference program addresses not in the protocol allowlist. " +
        "These constraints will never trigger because the protocol is already blocked.",
      remediation:
        "Update the allowlist to include constrained programs, or remove stale constraints.",
    },
    {
      id: "no-permission-concentration",
      label: "No agent has more than 15 permissions",
      passed: !vault.agents.some(
        (a: { permissions: bigint }) => countBits(a.permissions) > 15,
      ),
      severity: "warning",
      detail:
        "An agent with more than 15 of 21 permission bits is effectively unrestricted. " +
        "Use least-privilege — grant only the actions the agent's strategy requires.",
      remediation:
        "Review agent permissions and restrict to only necessary action types.",
    },
    // ---- Step 18: 2 more checks (18-19) — council security findings ----
    {
      id: "constraints-current",
      label: "Constraint discriminators are current",
      passed:
        !constraints ||
        !constraints.entries ||
        constraints.entries.length === 0 ||
        (() => {
          // Verify constraint entries reference known program discriminators.
          // Stale constraints silently stop matching after protocol upgrades.
          for (const entry of constraints.entries) {
            if (
              entry.dataConstraints &&
              entry.dataConstraints.length === 0 &&
              entry.accountConstraints &&
              entry.accountConstraints.length === 0
            ) {
              return false; // Empty entry = likely stale or misconfigured
            }
          }
          return true;
        })(),
      severity: "warning",
      detail:
        "Stale or empty constraint entries may not match current protocol instruction formats. " +
        "Review constraints when protocols upgrade.",
      remediation:
        "Review and update InstructionConstraints entries. Remove empty entries.",
    },
    {
      id: "constraints-cover-allowlist",
      label: "All allowlisted protocols have constraint entries",
      passed: (() => {
        if (
          !constraints ||
          !constraints.entries ||
          policy.protocolMode !== PROTOCOL_MODE_ALLOWLIST ||
          !policy.protocols
        )
          return true;
        const encoder = getAddressEncoder();
        const activeEntries = constraints.entries.slice(
          0,
          constraints.entryCount,
        );
        return policy.protocols.every((p: Address) => {
          const pBytes = encoder.encode(p);
          return activeEntries.some((e) => {
            if (pBytes.length !== e.programId.length) return false;
            for (let i = 0; i < 32; i++) {
              if (pBytes[i] !== e.programId[i]) return false;
            }
            return true;
          });
        });
      })(),
      severity: "info",
      detail:
        "Protocols on the allowlist without constraint entries rely solely on spending caps for protection.",
      remediation:
        "Add InstructionConstraints entries for all allowlisted protocols.",
    },
    // ---- Step 20: 1 more check (20) — council security finding ----
    {
      id: "mode-all-unguarded",
      label: "Protocol mode ALL has constraint protection",
      passed:
        policy.protocolMode !== 0 /* PROTOCOL_MODE_ALL */ ||
        (constraints !== null && Number(constraints.strictMode) !== 0),
      severity: "critical",
      detail:
        "Protocol mode ALL allows agents to call any program. Without strict-mode constraints, " +
        "agents have unrestricted program access beyond spending caps and SPL transfer blocking.",
      remediation:
        "Switch to Allowlist mode, or enable InstructionConstraints with strict_mode=true.",
    },
  ];

  const passCount = checks.filter((c) => c.passed).length;
  const failCount = checks.filter((c) => !c.passed).length;
  const criticalFailures = checks.filter(
    (c) => c.severity === "critical" && !c.passed,
  );

  return { checks, passCount, failCount, criticalFailures };
}

// ─── evaluateAlertConditions ─────────────────────────────────────────────────

/**
 * Evaluate alert conditions based on current vault state.
 * Returns active alerts sorted by severity (critical first).
 */
export function evaluateAlertConditions(
  state: ResolvedVaultState | ResolvedVaultStateForOwner,
  vaultAddress: Address,
  previousState?: ResolvedVaultState | ResolvedVaultStateForOwner,
): Alert[] {
  const alerts: Alert[] = [];
  const { vault, globalBudget } = state;
  // VaultStatus is a numeric enum (Active=0, Frozen=1, Closed=2)
  const statusNum = vault.status as number;
  const status =
    statusNum === VaultStatus.Active
      ? "Active"
      : statusNum === VaultStatus.Frozen
        ? "Frozen"
        : "Closed";

  // Cap approaching
  if (globalBudget.cap > 0n) {
    const util = Number((globalBudget.spent24h * 100n) / globalBudget.cap);

    if (util >= 95) {
      alerts.push({
        id: `cap-critical-${vaultAddress}`,
        severity: "critical",
        title: "Daily budget nearly exhausted",
        description: `${util}% of daily budget used — ${formatUsd(globalBudget.remaining, 2)} remaining.`,
        vaultAddress,
        agentAddress: null,
        actionHref: `/dashboard/vault/${vaultAddress}?tab=policy`,
        actionLabel: "Adjust budget",
      });
    } else if (util >= 80) {
      alerts.push({
        id: `cap-warning-${vaultAddress}`,
        severity: "warning",
        title: `Daily budget ${util}% used`,
        description: `${formatUsd(globalBudget.remaining, 2)} remaining of ${formatUsd(globalBudget.cap, 2)} daily budget.`,
        vaultAddress,
        agentAddress: null,
        actionHref: `/dashboard/vault/${vaultAddress}?tab=spending`,
        actionLabel: "Review spending",
      });
    }
  }

  // Vault frozen
  if (status === "Frozen") {
    alerts.push({
      id: `frozen-${vaultAddress}`,
      severity: "critical",
      title: "Vault is paused",
      description: "All agent activity is stopped. Reactivate when ready.",
      vaultAddress,
      agentAddress: null,
      actionHref: `/dashboard/vault/${vaultAddress}?tab=security`,
      actionLabel: "Review security",
    });
  }

  // Agent paused
  for (const agent of vault.agents) {
    if (agent.paused) {
      alerts.push({
        id: `agent-paused-${agent.pubkey}`,
        severity: "info",
        title: `Agent ${formatAddress(agent.pubkey)} is paused`,
        description: "This agent cannot execute any actions until resumed.",
        vaultAddress,
        agentAddress: agent.pubkey,
        actionHref: `/dashboard/vault/${vaultAddress}?tab=agents`,
        actionLabel: "Manage agents",
      });
    }
  }

  // Per-agent cap approaching
  for (const [agentAddr, budget] of state.allAgentBudgets) {
    if (budget.cap > 0n) {
      const util = Number((budget.spent24h * 100n) / budget.cap);
      if (util >= 80) {
        alerts.push({
          id: `agent-cap-${agentAddr}`,
          severity: util >= 95 ? "critical" : "warning",
          title: `Agent ${formatAddress(agentAddr)} at ${util}% of spending limit`,
          description: `${formatUsd(budget.remaining, 2)} remaining of ${formatUsd(budget.cap, 2)} daily limit.`,
          vaultAddress,
          agentAddress: agentAddr,
          actionHref: `/dashboard/vault/${vaultAddress}/agent/${agentAddr}`,
          actionLabel: "View agent",
        });
      }
    }
  }

  // No agents
  if (vault.agents.length === 0 && status === "Active") {
    alerts.push({
      id: `no-agents-${vaultAddress}`,
      severity: "warning",
      title: "No agents registered",
      description:
        "This vault has no agents and cannot execute any DeFi operations.",
      vaultAddress,
      agentAddress: null,
      actionHref: `/dashboard/vault/${vaultAddress}?tab=agents`,
      actionLabel: "Register agent",
    });
  }

  // All agents paused
  if (vault.agents.length > 0 && vault.agents.every((a) => a.paused)) {
    alerts.push({
      id: `all-paused-${vaultAddress}`,
      severity: "warning",
      title: "All agents are paused",
      description:
        "No agent can execute actions. Unpause at least one to resume operations.",
      vaultAddress,
      agentAddress: null,
      actionHref: `/dashboard/vault/${vaultAddress}?tab=agents`,
      actionLabel: "Manage agents",
    });
  }

  // High velocity + drain detection — delegate to spending-analytics for rate math
  if (state.tracker && globalBudget.cap > 0n) {
    const velocity = getSpendingVelocity(
      state.tracker,
      state.resolvedAtTimestamp,
      globalBudget,
    );

    // High velocity alert: current rate > 2x average (stricter than spending-analytics 1.5x)
    if (
      velocity.averageRate > 0n &&
      velocity.currentRate > velocity.averageRate * 2n
    ) {
      const multiplier = Number(velocity.currentRate / velocity.averageRate);
      alerts.push({
        id: `high-velocity-${vaultAddress}`,
        severity: "warning",
        title: "Unusual spending velocity detected",
        description: `Current spend rate is ${multiplier}x the 24h average.`,
        vaultAddress,
        agentAddress: null,
        actionHref: `/dashboard/vault/${vaultAddress}?tab=spending`,
        actionLabel: "Review spending",
      });
    }

    // Drain detection: current hourly rate > 50% of daily cap
    if (
      velocity.currentRate > 0n &&
      velocity.currentRate > globalBudget.cap / 2n
    ) {
      alerts.push({
        id: `drain-detected-${vaultAddress}`,
        severity: "critical",
        title: "Potential drain detected",
        description:
          "Spending rate would consume over 50% of daily budget in one hour. Consider freezing the vault.",
        vaultAddress,
        agentAddress: null,
        actionHref: `/dashboard/vault/${vaultAddress}?tab=security`,
        actionLabel: "Freeze vault",
      });
    }
  }

  // Sort: critical first
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return alerts;
}

// ─── getAuditTrail ───────────────────────────────────────────────────────────

const AUDIT_EVENTS: Record<string, AuditEntry["category"]> = {
  PolicyUpdated: "policy_change",
  PolicyChangeQueued: "policy_change",
  PolicyChangeApplied: "policy_change",
  PolicyChangeCancelled: "policy_change",
  AgentRegistered: "agent_change",
  AgentRevoked: "agent_change",
  AgentPermissionsUpdated: "agent_change",
  AgentPausedEvent: "emergency",
  AgentUnpausedEvent: "agent_change",
  VaultFrozen: "emergency",
  VaultReactivated: "emergency",
  VaultClosed: "emergency",
  VaultCreated: "emergency",
  EscrowCreated: "escrow",
  EscrowSettled: "escrow",
  EscrowRefunded: "escrow",
  InstructionConstraintsCreated: "constraint_change",
  InstructionConstraintsUpdated: "constraint_change",
  InstructionConstraintsClosed: "constraint_change",
  ConstraintsChangeQueued: "constraint_change",
  ConstraintsChangeApplied: "constraint_change",
  ConstraintsChangeCancelled: "constraint_change",
};

/**
 * Filter decoded events into a compliance-focused audit trail.
 * Shows only security-relevant events (policy, agent, emergency, escrow, constraints).
 *
 * Supports optional filtering by category, timestamp, and actor.
 *
 * Note on event field availability (verified against events.rs):
 * - 10 of 22 events have no `timestamp` field — fallback through `executes_at`, `applied_at`, then 0.
 * - 7+ events have neither `owner` nor `agent` — fallback through `settled_by`, `refunded_by`, `vault`.
 * - `txSignature` requires enrichment from transaction envelope (DecodedSigilEvent has no such field).
 */
export function getAuditTrail(
  events: DecodedSigilEvent[],
  options?: {
    /** Filter to specific categories. If omitted, returns all. */
    categories?: AuditEntry["category"][];
    /** Filter to events after this Unix timestamp. */
    since?: number;
    /** Filter to events by a specific actor address. */
    actor?: Address;
  },
): AuditEntry[] {
  const trail: AuditEntry[] = [];

  for (const e of events) {
    const category = AUDIT_EVENTS[e.name];
    if (!category) continue;

    if (options?.categories && !options.categories.includes(category)) continue;

    const f = e.fields ?? {};

    // Timestamp fallback: timestamp → executes_at → applied_at → 0
    const timestamp = Number(
      (f.timestamp as bigint) ??
        (f.executes_at as bigint) ??
        (f.applied_at as bigint) ??
        0n,
    );

    if (options?.since && timestamp > 0 && timestamp < options.since) continue;

    // Actor fallback: owner → agent → settled_by → refunded_by → vault → "unknown"
    const actor = (f.owner ??
      f.agent ??
      f.settled_by ??
      f.refunded_by ??
      f.vault ??
      "unknown") as string as Address;

    if (options?.actor && actor !== options.actor) continue;

    trail.push({
      timestamp,
      txSignature: (e as { txSignature?: string }).txSignature ?? "",
      category,
      action: e.name,
      actor,
      details: f,
      description: describeEvent(e),
    });
  }

  return trail;
}

// ─── getAuditTrailSummary ────────────────────────────────────────────────────

export interface AuditTrailSummary {
  totalEntries: number;
  byCategory: Record<AuditEntry["category"], number>;
  latestTimestamp: number;
  uniqueActors: Address[];
}

/** Summarize an audit trail into per-category counts. */
export function getAuditTrailSummary(trail: AuditEntry[]): AuditTrailSummary {
  const byCategory: Record<string, number> = {
    policy_change: 0,
    agent_change: 0,
    emergency: 0,
    escrow: 0,
    constraint_change: 0,
  };
  const actors = new Set<string>();
  let latest = 0;

  for (const entry of trail) {
    byCategory[entry.category]++;
    actors.add(entry.actor);
    if (entry.timestamp > latest) latest = entry.timestamp;
  }

  return {
    totalEntries: trail.length,
    byCategory: byCategory as Record<AuditEntry["category"], number>,
    latestTimestamp: latest,
    uniqueActors: Array.from(actors) as Address[],
  };
}
