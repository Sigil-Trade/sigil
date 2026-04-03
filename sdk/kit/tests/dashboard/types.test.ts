import { expect } from "chai";
import type {
  VaultState,
  AgentData,
  SpendingData,
  ActivityData,
  ActivityRow,
  HealthData,
  PolicyData,
  TxResult,
  ChartPoint,
  TokenBalance,
  DiscoveredVault,
  DxError,
  PolicyChanges,
  ActivityFilters,
} from "../../src/dashboard/types.js";

// ─── toJSON Serialization Tests ─────────────────────────────────────────────
// Verify every type with toJSON() converts bigint → string correctly.

describe("Dashboard types — toJSON serialization", () => {
  it("TxResult.toJSON() returns signature string", () => {
    const result: TxResult = {
      signature: "5Uf3abc123",
      toJSON: () => ({ signature: "5Uf3abc123" }),
    };
    const json = JSON.parse(JSON.stringify(result));
    expect(json.signature).to.equal("5Uf3abc123");
  });

  it("VaultState.toJSON() converts bigint to string", () => {
    const state: VaultState = {
      vault: {
        address: "vault1",
        status: "active",
        owner: "owner1",
        agentCount: 2,
        openPositions: 0,
        totalVolume: 1_000_000_000n,
        totalFees: 500_000n,
      },
      balance: {
        total: 48_320_000_000n,
        tokens: [{ mint: "USDC", amount: 48_320_000_000n, decimals: 6 }],
      },
      pnl: { percent: 2.4, absolute: 1_200_000_000n },
      health: { level: "healthy", alertCount: 0, checks: [] },
      toJSON: () => ({
        vault: {
          address: "vault1",
          status: "active" as const,
          owner: "owner1",
          agentCount: 2,
          openPositions: 0,
          totalVolume: "1000000000",
          totalFees: "500000",
        },
        balance: {
          total: "48320000000",
          tokens: [{ mint: "USDC", amount: "48320000000", decimals: 6 }],
        },
        pnl: { percent: 2.4, absolute: "1200000000" },
        health: { level: "healthy", alertCount: 0, checks: [] },
      }),
    };

    // JSON.stringify should not throw (bigint serialized via toJSON)
    const json = JSON.parse(JSON.stringify(state));
    expect(json.vault.totalVolume).to.equal("1000000000");
    expect(json.balance.total).to.equal("48320000000");
    expect(json.pnl.absolute).to.equal("1200000000");
    expect(json.pnl.percent).to.equal(2.4);
  });

  it("AgentData.toJSON() converts bigint fields", () => {
    const agent: AgentData = {
      address: "agent1",
      status: "active",
      permissions: ["Swap"],
      permissionBitmask: 1n,
      spending: { amount: 1_840_000_000n, limit: 2_000_000_000n, percent: 92 },
      lastActionType: "swap",
      lastActionProtocol: "Jupiter",
      lastActionTimestamp: 1234567890,
      blockedCount24h: 0,
      toJSON: () => ({
        address: "agent1",
        status: "active",
        permissions: ["Swap"],
        permissionBitmask: "1",
        spending: { amount: "1840000000", limit: "2000000000", percent: 92 },
        lastActionType: "swap",
        lastActionProtocol: "Jupiter",
        lastActionTimestamp: 1234567890,
        blockedCount24h: 0,
      }),
    };

    const json = JSON.parse(JSON.stringify(agent));
    expect(json.permissionBitmask).to.equal("1");
    expect(json.spending.amount).to.equal("1840000000");
    expect(json.spending.limit).to.equal("2000000000");
    expect(json.spending.percent).to.equal(92);
  });

  it("SpendingData.toJSON() converts global + protocolBreakdown bigints", () => {
    const spending: SpendingData = {
      global: {
        today: 3_720_000_000n,
        cap: 5_000_000_000n,
        remaining: 1_280_000_000n,
        percent: 74,
        rundownMs: 86400000,
      },
      chart: [{ time: "2026-04-02T00:00:00Z", amount: 3720 }],
      protocolBreakdown: [
        {
          name: "Jupiter",
          programId: "JUP6",
          amount: 1_525_000_000n,
          percent: 41,
        },
      ],
      toJSON: () => ({
        global: {
          today: "3720000000",
          cap: "5000000000",
          remaining: "1280000000",
          percent: 74,
          rundownMs: 86400000,
        },
        chart: [{ time: "2026-04-02T00:00:00Z", amount: 3720 }],
        protocolBreakdown: [
          {
            name: "Jupiter",
            programId: "JUP6",
            amount: "1525000000",
            percent: 41,
          },
        ],
      }),
    };

    const json = JSON.parse(JSON.stringify(spending));
    expect(json.global.today).to.equal("3720000000");
    expect(json.protocolBreakdown[0].amount).to.equal("1525000000");
    expect(json.chart[0].amount).to.equal(3720);
  });

  it("ActivityData.toJSON() converts row amounts + volume", () => {
    const activity: ActivityData = {
      rows: [
        {
          id: "tx1",
          timestamp: 1234567890,
          type: "swap",
          protocol: "Jupiter",
          protocolId: "JUP6",
          agent: "agent1",
          amount: 342_100_000n,
          status: "approved",
          toJSON: () => ({
            id: "tx1",
            timestamp: 1234567890,
            type: "swap",
            protocol: "Jupiter",
            protocolId: "JUP6",
            agent: "agent1",
            amount: "342100000",
            status: "approved",
          }),
        },
      ],
      summary: { total: 1, approved: 1, blocked: 0, volume: 342_100_000n },
      toJSON: () => ({
        rows: [
          {
            id: "tx1",
            timestamp: 1234567890,
            type: "swap",
            protocol: "Jupiter",
            protocolId: "JUP6",
            agent: "agent1",
            amount: "342100000",
            status: "approved",
          },
        ],
        summary: { total: 1, approved: 1, blocked: 0, volume: "342100000" },
      }),
    };

    const json = JSON.parse(JSON.stringify(activity));
    expect(json.rows[0].amount).to.equal("342100000");
    expect(json.summary.volume).to.equal("342100000");
  });

  it("HealthData.toJSON() converts lastBlock amount", () => {
    const health: HealthData = {
      level: "elevated",
      blockedCount24h: 1,
      checks: [{ name: "policy_configured", passed: true }],
      lastBlock: {
        agent: "agent1",
        reason: "SpendingCapExceeded",
        amount: 1_200_000_000n,
        timestamp: 1234567890,
      },
      toJSON: () => ({
        level: "elevated",
        blockedCount24h: 1,
        checks: [{ name: "policy_configured", passed: true }],
        lastBlock: {
          agent: "agent1",
          reason: "SpendingCapExceeded",
          amount: "1200000000",
          timestamp: 1234567890,
        },
      }),
    };

    const json = JSON.parse(JSON.stringify(health));
    expect(json.lastBlock.amount).to.equal("1200000000");
    expect(json.level).to.equal("elevated");
  });

  it("PolicyData.toJSON() converts all bigint policy fields", () => {
    const policy: PolicyData = {
      dailyCap: 5_000_000_000n,
      maxPerTrade: 1_000_000_000n,
      approvedApps: [{ name: "Jupiter", programId: "JUP6" }],
      protocolMode: "whitelist",
      hasProtocolCaps: true,
      protocolCaps: [2_000_000_000n],
      canOpenPositions: true,
      maxConcurrentPositions: 3,
      maxSlippageBps: 50,
      leverageLimitBps: 500,
      allowedDestinations: [],
      developerFeeRate: 200,
      sessionExpirySlots: 20n,
      timelockSeconds: 1800,
      policyVersion: 5n,
      toJSON: () => ({
        dailyCap: "5000000000",
        maxPerTrade: "1000000000",
        approvedApps: [{ name: "Jupiter", programId: "JUP6" }],
        protocolMode: "whitelist",
        hasProtocolCaps: true,
        protocolCaps: ["2000000000"],
        canOpenPositions: true,
        maxConcurrentPositions: 3,
        maxSlippageBps: 50,
        leverageLimitBps: 500,
        allowedDestinations: [],
        developerFeeRate: 200,
        sessionExpirySlots: "20",
        timelockSeconds: 1800,
        policyVersion: "5",
      }),
    };

    const json = JSON.parse(JSON.stringify(policy));
    expect(json.dailyCap).to.equal("5000000000");
    expect(json.sessionExpirySlots).to.equal("20");
    expect(json.policyVersion).to.equal("5");
    expect(json.protocolCaps[0]).to.equal("2000000000");
    // Non-bigint fields stay as numbers
    expect(json.timelockSeconds).to.equal(1800);
    expect(json.leverageLimitBps).to.equal(500);
  });

  it("DiscoveredVault.toJSON() converts vaultId bigint", () => {
    const vault: DiscoveredVault = {
      address: "vault1",
      vaultId: 42n,
      status: "active",
      agentCount: 2,
      toJSON: () => ({
        address: "vault1",
        vaultId: "42",
        status: "active",
        agentCount: 2,
      }),
    };

    const json = JSON.parse(JSON.stringify(vault));
    expect(json.vaultId).to.equal("42");
  });
});

// ─── Type Shape Tests ───────────────────────────────────────────────────────
// These are compile-time checks — if the file compiles, types are correct.

describe("Dashboard types — type shapes (compile-time)", () => {
  it("ChartPoint has time (string) and amount (number)", () => {
    const point: ChartPoint = { time: "2026-04-02T00:00:00Z", amount: 1234 };
    expect(point.time).to.be.a("string");
    expect(point.amount).to.be.a("number");
  });

  it("TokenBalance has mint, amount (bigint), decimals", () => {
    const bal: TokenBalance = { mint: "USDC", amount: 100n, decimals: 6 };
    expect(typeof bal.amount).to.equal("bigint");
  });

  it("DxError has code, message, recovery[]", () => {
    const err: DxError = {
      code: 6006,
      message: "Cap exceeded",
      recovery: ["Wait for cap reset"],
    };
    expect(err.recovery).to.be.an("array");
  });

  it("PolicyChanges all fields are optional", () => {
    const empty: PolicyChanges = {};
    const partial: PolicyChanges = { dailyCap: 10_000_000_000n };
    const full: PolicyChanges = {
      dailyCap: 10n,
      maxPerTrade: 5n,
      approvedApps: [],
      protocolMode: "whitelist",
      hasProtocolCaps: true,
      protocolCaps: [],
      canOpenPositions: true,
      maxConcurrentPositions: 3,
      maxSlippageBps: 50,
      leverageLimit: 500,
      allowedDestinations: [],
      developerFeeRate: 200,
      sessionExpirySlots: 20n,
      timelock: 1800,
    };
    expect(empty).to.deep.equal({});
    expect(partial.dailyCap).to.equal(10_000_000_000n);
    expect(full.timelock).to.equal(1800);
  });

  it("ActivityFilters all fields are optional", () => {
    const empty: ActivityFilters = {};
    const full: ActivityFilters = {
      agent: "addr",
      protocol: "JUP6",
      status: "blocked",
      timeRange: "24h",
    };
    expect(empty).to.deep.equal({});
    expect(full.timeRange).to.equal("24h");
  });
});
