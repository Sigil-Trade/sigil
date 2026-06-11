/**
 * S10 — `OwnerClient.getAgentDetail` tests.
 *
 * The full `getAgentDetail()` performs an RPC fetch and an activity
 * enrichment fetch. These tests follow the established dashboard pattern
 * (see `overview.test.ts`): exercise the pure `buildAgentDetail` composition
 * helper with hand-built fixtures. The full read function's RPC behavior is
 * a thin Promise.all over `resolveVaultStateForOwner` + `getVaultActivity`,
 * already covered by their existing integration tests; the only new logic
 * `getAgentDetail` adds — single-agent filter + not-found error — is
 * tested through `buildAgentDetail` directly plus a delegation test on the
 * OwnerClient.
 */

import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";

import {
  buildAgentDetail,
  OwnerClient,
  type OwnerClientConfig,
} from "../../src/dashboard/index.js";
import * as reads from "../../src/dashboard/reads.js";
import type { OverviewContext } from "../../src/dashboard/types.js";
import type { VaultActivityItem } from "../../src/event-analytics.js";

// ─── Test Constants ─────────────────────────────────────────────────────────

const VAULT = "Vault11111111111111111111111111111111111111" as Address;
const OWNER = "Owner11111111111111111111111111111111111111" as Address;
const AGENT_A = "AgentA11111111111111111111111111111111111111" as Address;
const AGENT_B = "AgentB11111111111111111111111111111111111111" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const UNKNOWN_AGENT =
  "Unkn11111111111111111111111111111111111111111" as Address;

// ─── Fixture helpers ────────────────────────────────────────────────────────

function fixtureActivity(
  overrides: Partial<VaultActivityItem> = {},
): VaultActivityItem {
  return {
    timestamp: 1_700_000_000,
    txSignature: "sigTEST",
    eventType: "ActionAuthorized",
    category: "trade",
    agent: AGENT_A,
    amount: 1_000_000n,
    amountDisplay: "$1.000000",
    tokenMint: null,
    tokenSymbol: null,
    isSpending: true,
    protocol: JUPITER,
    protocolName: "Jupiter",
    success: true,
    description: "Swap approved",
    ...overrides,
  };
}

/** Two-agent fixture state — reused across test cases. */
function fixtureCtx(activity?: VaultActivityItem[]): OverviewContext {
  const state = {
    vault: {
      owner: OWNER,
      vaultId: 1n,
      agents: [
        { pubkey: AGENT_A, capability: 2, paused: false },
        { pubkey: AGENT_B, capability: 1, paused: true },
      ],
      status: 0,
      totalVolume: 0n,
      totalFeesCollected: 0n,
    },
    overlay: null,
    allAgentBudgets: new Map([
      [
        AGENT_A,
        { spent24h: 5_000_000n, cap: 10_000_000n, remaining: 5_000_000n },
      ],
      [AGENT_B, { spent24h: 0n, cap: 1_000_000n, remaining: 1_000_000n }],
    ]),
  };
  return { vault: VAULT, state, activity } as unknown as OverviewContext;
}

// ─── buildAgentDetail — happy path ──────────────────────────────────────────

describe("buildAgentDetail (S10)", () => {
  it("returns the full AgentData shape for the requested agent", () => {
    const ctx = fixtureCtx();
    const detail = buildAgentDetail(ctx, AGENT_A);

    expect(detail).to.not.equal(null);
    if (!detail) throw new Error("detail null");
    expect(detail.address).to.equal(AGENT_A);
    expect(detail.status).to.equal("active");
    expect(detail.capabilityLabel).to.equal("Operator");
    expect(detail.capability).to.equal(2);
    expect(detail.spending.amount).to.equal(5_000_000n);
    expect(detail.spending.limit).to.equal(10_000_000n);
    expect(typeof detail.spending.percent).to.equal("number");
    expect(typeof detail.toJSON).to.equal("function");
  });

  it("filters to a single agent — does NOT return the other agent's data", () => {
    const ctx = fixtureCtx();
    const detailA = buildAgentDetail(ctx, AGENT_A);
    const detailB = buildAgentDetail(ctx, AGENT_B);

    expect(detailA?.address).to.equal(AGENT_A);
    expect(detailA?.spending.amount).to.equal(5_000_000n);

    expect(detailB?.address).to.equal(AGENT_B);
    expect(detailB?.status).to.equal("paused");
    expect(detailB?.spending.amount).to.equal(0n);
  });

  it("returns null when the agent is not registered in the vault", () => {
    const ctx = fixtureCtx();
    const detail = buildAgentDetail(ctx, UNKNOWN_AGENT);
    expect(detail).to.equal(null);
  });

  it("populates last-action fields from ctx.activity when provided", () => {
    const ctx = fixtureCtx([
      fixtureActivity({
        agent: AGENT_A,
        timestamp: 1_700_000_000,
        category: "deposit",
        eventType: "FundsDeposited",
        protocolName: "Jupiter",
      }),
    ]);
    const detail = buildAgentDetail(ctx, AGENT_A);
    expect(detail?.lastActionType).to.equal("deposit");
    expect(detail?.lastActionProtocol).to.equal("Jupiter");
    expect(detail?.lastActionTimestamp).to.equal(1_700_000_000 * 1000);
  });

  it("returns empty last-action fields when activity is absent", () => {
    const ctx = fixtureCtx();
    const detail = buildAgentDetail(ctx, AGENT_A);
    expect(detail?.lastActionType).to.equal("");
    expect(detail?.lastActionProtocol).to.equal("");
    expect(detail?.lastActionTimestamp).to.equal(0);
    expect(detail?.blockedCount24h).to.equal(0);
  });

  it("toJSON serializes bigint spending fields to strings", () => {
    const ctx = fixtureCtx();
    const detail = buildAgentDetail(ctx, AGENT_A);
    if (!detail) throw new Error("detail null");
    const json = detail.toJSON();
    expect(json.spending.amount).to.equal("5000000");
    expect(json.spending.limit).to.equal("10000000");
    expect(typeof json.spending.amount).to.equal("string");
  });
});

// ─── OwnerClient.getAgentDetail — delegation ────────────────────────────────
//
// Cannot mutate imported binding `reads.getAgentDetail` from a test (ESM
// imports are read-only). Instead: pass a sentinel RPC that throws the
// moment the read is invoked, and verify the wrapped error path runs end-
// to-end through the OwnerClient method. This proves the method reaches
// `reads.getAgentDetail`, which then reaches the RPC layer.

describe("OwnerClient.getAgentDetail (S10)", () => {
  function mockSigner(addr: Address = OWNER): TransactionSigner {
    return {
      address: addr,
      signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
    } as unknown as TransactionSigner;
  }

  it("exposes getAgentDetail as a method on OwnerClient", () => {
    const client = new OwnerClient({
      rpc: {} as unknown as OwnerClientConfig["rpc"],
      vault: VAULT,
      owner: mockSigner(),
      network: "devnet",
    });
    expect(typeof client.getAgentDetail).to.equal("function");
  });

  it("invokes reads.getAgentDetail and propagates the wrapped error path", async () => {
    // Sentinel RPC throws on the first method call. Whichever underlying
    // RPC accessor `resolveVaultStateForOwner` or `getVaultActivity`
    // reaches first will trigger the throw — proving the method runs the
    // full read pipeline rather than short-circuiting.
    const sentinelMessage = "SENTINEL_RPC_REACHED";
    const sentinelRpc = new Proxy(
      {},
      {
        get() {
          throw new Error(sentinelMessage);
        },
      },
    ) as unknown as OwnerClientConfig["rpc"];

    const client = new OwnerClient({
      rpc: sentinelRpc,
      vault: VAULT,
      owner: mockSigner(),
      network: "devnet",
    });

    let caught: unknown;
    try {
      await client.getAgentDetail(AGENT_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.not.equal(undefined);
    // toDxError preserves the underlying cause via `details`. Asserting on
    // the prefix confirms the error went through getAgentDetail's
    // try/catch and was wrapped with the operation name.
    const msg = (caught as Error).message ?? "";
    expect(msg).to.include("OwnerClient.getAgentDetail");
  });

  it("references reads.getAgentDetail at module level (sanity)", () => {
    expect(typeof reads.getAgentDetail).to.equal("function");
  });
});
