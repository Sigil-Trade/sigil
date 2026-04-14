/**
 * Overview (S14) — composition, memoization, toJSON shape tests.
 *
 * The `build*` helpers are pure functions over a pre-fetched
 * {@link OverviewContext}. These tests exercise the composition logic with
 * hand-constructed fixtures. RPC-level behavior (the Promise.all parallelism
 * and "exactly 4 calls" property) is visible by construction in reads.ts and
 * covered by the existing integration tests of the underlying fetchers
 * (resolveVaultStateForOwner, getVaultPnL, getVaultActivity,
 * getPendingPolicyForVault).
 *
 * Backward compatibility for the five existing reads (getVaultState, getAgents,
 * getSpending, getHealth, getPolicy) is covered by their existing tests —
 * those still pass because every read now delegates to a build* helper with a
 * ctx it assembled itself, preserving the original fetch shape.
 */

import { expect } from "chai";
import type { Address } from "@solana/kit";

import {
  buildActivityRows,
  buildVaultState,
  buildAgents,
  buildSpending,
  buildHealth,
  buildPolicy,
  DEFAULT_OVERVIEW_ACTIVITY_LIMIT,
} from "../../src/dashboard/reads.js";
import type {
  OverviewContext,
  OverviewData,
  VaultState,
  AgentData,
  SpendingData,
  HealthData,
  PolicyData,
  ActivityRow,
} from "../../src/dashboard/types.js";
import type { VaultActivityItem } from "../../src/event-analytics.js";
import type { SecurityPosture, Alert } from "../../src/security-analytics.js";
import type { SpendingBreakdown } from "../../src/spending-analytics.js";
import type { ResolvedVaultStateForOwner } from "../../src/state-resolver.js";

// ─── Test Constants ─────────────────────────────────────────────────────────

const VAULT = "Vault11111111111111111111111111111111111111" as Address;
const OWNER = "Owner11111111111111111111111111111111111111" as Address;
const AGENT = "Agent11111111111111111111111111111111111111" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function fixtureActivity(
  overrides: Partial<VaultActivityItem> = {},
): VaultActivityItem {
  return {
    timestamp: 1_700_000_000,
    txSignature: "sigTEST",
    eventType: "ActionAuthorized",
    category: "trade",
    agent: AGENT,
    amount: 1_000_000n,
    amountDisplay: "$1.000000",
    tokenMint: null,
    tokenSymbol: null,
    isSpending: true,
    positionEffect: "none",
    actionType: "swap",
    protocol: JUPITER,
    protocolName: "Jupiter",
    success: true,
    description: "Swap approved",
    ...overrides,
  };
}

/** Minimal state stub — only fields used by buildVaultState outside posture. */
function fixtureState(): ResolvedVaultStateForOwner {
  return {
    vault: {
      owner: OWNER,
      vaultId: 1n,
      agents: [],
      status: 0,
      openPositions: 0,
      totalVolume: 100_000_000n,
      totalFeesCollected: 500_000n,
    } as unknown as ResolvedVaultStateForOwner["vault"],
    stablecoinBalances: { usdc: 10_000_000n, usdt: 5_000_000n },
  } as unknown as ResolvedVaultStateForOwner;
}

function fixturePosture(
  overrides: Partial<SecurityPosture> = {},
): SecurityPosture {
  return {
    checks: [
      {
        id: "sentinel_check",
        label: "Sentinel",
        passed: true,
        severity: "info",
        detail: "fixture",
        remediation: null,
      },
    ],
    passCount: 1,
    failCount: 0,
    criticalFailures: [],
    ...overrides,
  };
}

// ─── buildActivityRows ──────────────────────────────────────────────────────

describe("buildActivityRows", () => {
  it("returns empty array for empty input", () => {
    expect(buildActivityRows([])).to.deep.equal([]);
  });

  it("maps v6 trade+increment event to open_position", () => {
    const rows = buildActivityRows([
      fixtureActivity({ positionEffect: "increment", actionType: null }),
    ]);
    expect(rows).to.have.length(1);
    expect(rows[0].type).to.equal("open_position");
  });

  it("maps v6 trade+decrement event to close_position", () => {
    const rows = buildActivityRows([
      fixtureActivity({ positionEffect: "decrement", actionType: null }),
    ]);
    expect(rows[0].type).to.equal("close_position");
  });

  it("maps deposit category to deposit type", () => {
    const rows = buildActivityRows([
      fixtureActivity({ category: "deposit", eventType: "FundsDeposited" }),
    ]);
    expect(rows[0].type).to.equal("deposit");
  });

  it("maps withdrawal category to withdraw type", () => {
    const rows = buildActivityRows([
      fixtureActivity({ category: "withdrawal", eventType: "FundsWithdrawn" }),
    ]);
    expect(rows[0].type).to.equal("withdraw");
  });

  it("marks failed events as blocked with description as reason", () => {
    const rows = buildActivityRows([
      fixtureActivity({ success: false, description: "SpendingCapExceeded" }),
    ]);
    expect(rows[0].status).to.equal("blocked");
    expect(rows[0].reason).to.equal("SpendingCapExceeded");
  });

  it("omits reason for successful events", () => {
    const rows = buildActivityRows([fixtureActivity({ success: true })]);
    expect(rows[0].status).to.equal("approved");
    expect(rows[0].reason).to.equal(undefined);
  });

  it("toJSON() stringifies bigint amount", () => {
    const rows = buildActivityRows([fixtureActivity({ amount: 1_234_000n })]);
    const json = rows[0].toJSON();
    expect(json.amount).to.equal("1234000");
    expect(typeof json.amount).to.equal("string");
  });

  it("derives fallback id from timestamp+eventType when txSignature empty", () => {
    const rows = buildActivityRows([
      fixtureActivity({ txSignature: "", eventType: "ActionAuthorized" }),
    ]);
    expect(rows[0].id).to.equal("evt-1700000000-ActionAuthorized");
  });

  it("returns unfiltered rows — does not drop any input", () => {
    const input = [
      fixtureActivity({ success: true }),
      fixtureActivity({ success: false }),
      fixtureActivity({ category: "deposit", eventType: "FundsDeposited" }),
    ];
    expect(buildActivityRows(input)).to.have.length(3);
  });
});

// ─── DEFAULT_OVERVIEW_ACTIVITY_LIMIT ────────────────────────────────────────

describe("DEFAULT_OVERVIEW_ACTIVITY_LIMIT", () => {
  it("exports 100 (matches getAgents' enrichment window)", () => {
    expect(DEFAULT_OVERVIEW_ACTIVITY_LIMIT).to.equal(100);
  });
});

// ─── State-missing guard ────────────────────────────────────────────────────

describe("build* helper guards", () => {
  it("buildVaultState throws labeled error when state.vault is null", () => {
    const ctx = {
      vault: VAULT,
      state: { vault: null, stablecoinBalances: { usdc: 0n, usdt: 0n } },
      posture: fixturePosture(),
    } as unknown as OverviewContext;
    expect(() => buildVaultState(ctx)).to.throw(/state\.vault is required/);
  });

  it("buildAgents throws labeled error when state.vault is null", () => {
    const ctx = {
      vault: VAULT,
      state: { vault: null, allAgentBudgets: new Map() },
    } as unknown as OverviewContext;
    expect(() => buildAgents(ctx)).to.throw(/state\.vault is required/);
  });

  it("buildPolicy throws labeled error when state.policy is null", () => {
    const ctx = {
      vault: VAULT,
      state: { policy: null },
    } as unknown as OverviewContext;
    expect(() => buildPolicy(ctx)).to.throw(/state\.policy is required/);
  });
});

// ─── buildVaultState memoization ────────────────────────────────────────────

describe("buildVaultState posture memoization", () => {
  it("uses ctx.posture when provided instead of deriving from state", () => {
    // Construct a ctx with a sentinel posture. If buildVaultState honors
    // memoization, the returned health.checks will reflect the sentinel.
    // If it ignores ctx.posture and derives its own, the check name would
    // NOT be 'sentinel_check'.
    const ctx: OverviewContext = {
      vault: VAULT,
      state: fixtureState(),
      posture: fixturePosture(),
    };
    const view = buildVaultState(ctx);
    expect(view.health.checks).to.have.length(1);
    expect(view.health.checks[0].name).to.equal("sentinel_check");
  });

  it("health level maps from ctx.posture failCount/criticalFailures", () => {
    const criticalCheck = {
      id: "fail_critical",
      label: "fail",
      passed: false,
      severity: "critical" as const,
      detail: "",
      remediation: null,
    };
    const ctx: OverviewContext = {
      vault: VAULT,
      state: fixtureState(),
      posture: {
        checks: [criticalCheck],
        passCount: 0,
        failCount: 1,
        criticalFailures: [criticalCheck],
      },
    };
    expect(buildVaultState(ctx).health.level).to.equal("critical");
  });

  it("returns zero pnl when ctx.pnl is undefined", () => {
    const ctx: OverviewContext = {
      vault: VAULT,
      state: fixtureState(),
      posture: fixturePosture(),
    };
    const view = buildVaultState(ctx);
    expect(view.pnl.percent).to.equal(0);
    expect(view.pnl.absolute).to.equal(0n);
  });

  it("uses ctx.pnl when provided", () => {
    const ctx: OverviewContext = {
      vault: VAULT,
      state: fixtureState(),
      pnl: {
        pnl: 1_500_000n,
        pnlPercent: 2.5,
      } as unknown as OverviewContext["pnl"],
      posture: fixturePosture(),
    };
    const view = buildVaultState(ctx);
    expect(view.pnl.absolute).to.equal(1_500_000n);
    expect(view.pnl.percent).to.equal(2.5);
  });
});

// ─── buildAgents honors ctx.activity ────────────────────────────────────────

describe("buildAgents", () => {
  it("uses ctx.activity to populate last-action fields on matching agent", () => {
    const ctx = {
      vault: VAULT,
      state: {
        vault: { agents: [{ pubkey: AGENT }] },
        allAgentBudgets: new Map([
          [AGENT, { spent24h: 0n, cap: 0n, remaining: 0n }],
        ]),
      },
      activity: [
        fixtureActivity({
          agent: AGENT,
          timestamp: 1_700_000_000,
          category: "deposit",
          eventType: "FundsDeposited",
          protocolName: "Jupiter",
        }),
      ],
    } as unknown as OverviewContext;
    const agents = buildAgents(ctx);
    expect(agents).to.have.length(1);
    expect(agents[0].lastActionType).to.equal("deposit");
    expect(agents[0].lastActionProtocol).to.equal("Jupiter");
    expect(agents[0].lastActionTimestamp).to.equal(1_700_000_000 * 1000);
  });

  it("returns empty last-action fields when ctx.activity is undefined", () => {
    const ctx = {
      vault: VAULT,
      state: {
        vault: { agents: [{ pubkey: AGENT }] },
        allAgentBudgets: new Map([
          [AGENT, { spent24h: 0n, cap: 0n, remaining: 0n }],
        ]),
      },
      // activity intentionally omitted — mimics includeActivity: false path
    } as unknown as OverviewContext;
    const agents = buildAgents(ctx);
    expect(agents[0].lastActionType).to.equal("");
    expect(agents[0].lastActionProtocol).to.equal("");
    expect(agents[0].lastActionTimestamp).to.equal(0);
    expect(agents[0].blockedCount24h).to.equal(0);
  });
});

// ─── buildSpending honors ctx.breakdown ─────────────────────────────────────

describe("buildSpending", () => {
  it("uses ctx.breakdown when provided (memoization path)", () => {
    // Sentinel: when ctx.breakdown is set, buildSpending must produce a
    // protocolBreakdown reflecting the sentinel — NOT a derivation from state.
    const sentinelBreakdown: SpendingBreakdown = {
      total: 0n,
      byProtocol: [
        {
          protocol: JUPITER,
          spent24h: 12_345_678n,
          cap: 100_000_000n,
          remaining: 87_654_322n,
          utilization: 12.35,
        },
      ],
      mostActive: null,
      byAgent: [],
    } as unknown as SpendingBreakdown;

    const ctx = {
      vault: VAULT,
      state: {
        tracker: { buckets: [], lastWriteEpoch: 0n },
        globalBudget: { spent24h: 0n, cap: 0n, remaining: 0n },
      },
      breakdown: sentinelBreakdown,
    } as unknown as OverviewContext;

    const spending = buildSpending(ctx);
    expect(spending.protocolBreakdown).to.have.length(1);
    expect(spending.protocolBreakdown[0].amount).to.equal(12_345_678n);
    expect(spending.protocolBreakdown[0].percent).to.equal(12.35);
    expect(spending.protocolBreakdown[0].programId).to.equal(JUPITER);
  });
});

// ─── buildHealth memoization ────────────────────────────────────────────────

describe("buildHealth", () => {
  it("uses ctx.alerts when provided (memoization path)", () => {
    const sentinelAlerts: Alert[] = [
      {
        id: "A1",
        severity: "critical",
        title: "SentinelBlock",
        description: "fixture",
        vaultAddress: VAULT,
        agentAddress: AGENT,
        actionHref: "",
        actionLabel: "",
      },
    ];
    const ctx = {
      vault: VAULT,
      state: {},
      posture: fixturePosture(),
      alerts: sentinelAlerts,
    } as unknown as OverviewContext;
    const health = buildHealth(ctx);
    expect(health.blockedCount24h).to.equal(1);
    expect(health.lastBlock?.reason).to.equal("SentinelBlock");
    expect(health.lastBlock?.agent).to.equal(AGENT);
  });

  it("health level follows ctx.posture failures", () => {
    const ctx = {
      vault: VAULT,
      state: {},
      posture: fixturePosture({ failCount: 2 }),
      alerts: [],
    } as unknown as OverviewContext;
    expect(buildHealth(ctx).level).to.equal("elevated");
  });
});

// ─── buildPolicy pendingPolicy semantics ────────────────────────────────────

describe("buildPolicy", () => {
  function minimalPolicyState() {
    return {
      policy: {
        dailySpendingCapUsd: 0n,
        maxTransactionSizeUsd: 0n,
        protocols: [],
        protocolMode: 0,
        hasProtocolCaps: false,
        protocolCaps: [],
        canOpenPositions: false,
        maxConcurrentPositions: 0,
        maxSlippageBps: 0,
        maxLeverageBps: 0,
        allowedDestinations: [],
        developerFeeRate: 0,
        sessionExpirySlots: 0n,
        policyVersion: 0n,
        timelockDuration: 1800n,
      },
    };
  }

  it("pendingPolicy undefined → pendingUpdate undefined", () => {
    const ctx = {
      vault: VAULT,
      state: minimalPolicyState(),
      // pendingPolicy omitted
    } as unknown as OverviewContext;
    expect(buildPolicy(ctx).pendingUpdate).to.equal(undefined);
  });

  it("pendingPolicy null → pendingUpdate undefined (confirmed no pending)", () => {
    const ctx = {
      vault: VAULT,
      state: minimalPolicyState(),
      pendingPolicy: null,
    } as unknown as OverviewContext;
    expect(buildPolicy(ctx).pendingUpdate).to.equal(undefined);
  });
});

// ─── OverviewData toJSON delegation ─────────────────────────────────────────

describe("OverviewData toJSON delegation", () => {
  function stubVault(): VaultState {
    return {
      vault: {
        address: VAULT,
        status: "active",
        owner: OWNER,
        agentCount: 0,
        openPositions: 0,
        totalVolume: 0n,
        totalFees: 0n,
      },
      balance: { total: 0n, tokens: [] },
      pnl: { percent: 0, absolute: 0n },
      health: { level: "healthy", alertCount: 0, checks: [] },
      toJSON: () => ({ __type: "vault-stub" }) as never,
    };
  }
  function stubAgents(): AgentData[] {
    return [
      {
        address: AGENT,
        status: "active",
        capabilityLabel: "Operator",
        capability: 2,
        spending: { amount: 0n, limit: 0n, percent: 0 },
        lastActionType: "",
        lastActionProtocol: "",
        lastActionTimestamp: 0,
        blockedCount24h: 0,
        toJSON: () => ({ __type: "agent-stub" }) as never,
      },
    ];
  }
  function stubSpending(): SpendingData {
    return {
      global: {
        today: 0n,
        cap: 0n,
        remaining: 0n,
        percent: 0,
        rundownMs: 0,
      },
      chart: [],
      protocolBreakdown: [],
      toJSON: () => ({ __type: "spending-stub" }) as never,
    };
  }
  function stubHealth(): HealthData {
    return {
      level: "healthy",
      blockedCount24h: 0,
      checks: [],
      toJSON: () => ({ __type: "health-stub" }) as never,
    };
  }
  function stubPolicy(): PolicyData {
    return {
      dailyCap: 0n,
      maxPerTrade: 0n,
      approvedApps: [],
      protocolMode: "unrestricted",
      hasProtocolCaps: false,
      protocolCaps: [],
      canOpenPositions: false,
      maxConcurrentPositions: 0,
      maxSlippageBps: 0,
      leverageLimitBps: 0,
      allowedDestinations: [],
      developerFeeRate: 0,
      sessionExpirySlots: 0n,
      timelockSeconds: 1800,
      policyVersion: 0n,
      toJSON: () => ({ __type: "policy-stub" }) as never,
    };
  }
  function stubActivityRow(id: string): ActivityRow {
    return {
      id,
      timestamp: 0,
      type: "swap",
      protocol: "",
      protocolId: "",
      agent: AGENT,
      amount: 0n,
      status: "approved",
      toJSON: () => ({ __type: "row-stub", id }) as never,
    };
  }

  it("top-level toJSON produces all 6 fields, each delegating to its sub-toJSON", () => {
    const activity = [stubActivityRow("row-1"), stubActivityRow("row-2")];
    const overview: OverviewData = {
      vault: stubVault(),
      agents: stubAgents(),
      spending: stubSpending(),
      health: stubHealth(),
      policy: stubPolicy(),
      activity,
      toJSON() {
        return {
          vault: this.vault.toJSON(),
          agents: this.agents.map((a) => a.toJSON()),
          spending: this.spending.toJSON(),
          health: this.health.toJSON(),
          policy: this.policy.toJSON(),
          activity: this.activity.map((r) => r.toJSON()),
        };
      },
    };

    const json = overview.toJSON() as unknown as Record<string, unknown>;
    expect(json).to.have.all.keys(
      "vault",
      "agents",
      "spending",
      "health",
      "policy",
      "activity",
    );
    expect((json.vault as { __type: string }).__type).to.equal("vault-stub");
    expect((json.spending as { __type: string }).__type).to.equal(
      "spending-stub",
    );
    expect((json.health as { __type: string }).__type).to.equal("health-stub");
    expect((json.policy as { __type: string }).__type).to.equal("policy-stub");
    expect((json.agents as Array<{ __type: string }>)[0].__type).to.equal(
      "agent-stub",
    );
    expect(json.activity as Array<{ id: string }>).to.have.length(2);
    expect((json.activity as Array<{ id: string }>)[0].id).to.equal("row-1");
  });
});
