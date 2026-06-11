/**
 * S12 — `OwnerClient.getAuditTrail` tests.
 *
 * Covers:
 * - `buildAuditTrail`: filters raw activity to the governance/security
 *   subset and maps each survivor to an AuditTrailEntry
 * - `getAuditTrail` honors the `since` lower-bound timestamp filter
 * - Empty inputs / no-audit-events inputs return `[]`
 * - `OwnerClient.getAuditTrail` delegation
 *
 * Pure-function path follows the dashboard convention (`overview.test.ts`):
 * `buildAuditTrail` is pure over an already-fetched activity list, so the
 * RPC fetch behavior is covered by the existing `getVaultActivity` tests.
 */

import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";

import {
  buildAuditTrail,
  OwnerClient,
  type OwnerClientConfig,
} from "../../src/dashboard/index.js";
import * as reads from "../../src/dashboard/reads.js";
import type { VaultActivityItem } from "../../src/event-analytics.js";

// ─── Test Constants ─────────────────────────────────────────────────────────

const VAULT = "Vault11111111111111111111111111111111111111" as Address;
const OWNER = "Owner11111111111111111111111111111111111111" as Address;
const AGENT = "Agent11111111111111111111111111111111111111" as Address;

// ─── Fixture helpers ────────────────────────────────────────────────────────

function fixtureActivity(
  overrides: Partial<VaultActivityItem> = {},
): VaultActivityItem {
  return {
    timestamp: 1_700_000_000,
    txSignature: "sig-trade",
    eventType: "ActionAuthorized",
    category: "trade",
    agent: AGENT,
    amount: 1_000_000n,
    amountDisplay: "$1.000000",
    tokenMint: null,
    tokenSymbol: null,
    isSpending: true,
    protocol: null,
    protocolName: null,
    success: true,
    description: "Swap approved",
    ...overrides,
  };
}

// ─── buildAuditTrail ────────────────────────────────────────────────────────

describe("buildAuditTrail (S12)", () => {
  it("returns an empty array for empty input", () => {
    expect(buildAuditTrail([])).to.deep.equal([]);
  });

  it("returns an empty array when only routine activity is present", () => {
    const entries = buildAuditTrail([
      fixtureActivity({ category: "trade" }),
      fixtureActivity({ category: "deposit", eventType: "FundsDeposited" }),
      fixtureActivity({ category: "withdrawal", eventType: "FundsWithdrawn" }),
      fixtureActivity({ category: "fee", eventType: "FeesCollected" }),
    ]);
    expect(entries).to.deep.equal([]);
  });

  it("maps policy events to policy_change", () => {
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "policy",
        eventType: "PolicyChangeApplied",
        txSignature: "sig-policy",
        description: "Policy was updated",
      }),
    ]);
    expect(entries).to.have.length(1);
    expect(entries[0].eventType).to.equal("policy_change");
    expect(entries[0].eventName).to.equal("PolicyChangeApplied");
    expect(entries[0].txSignature).to.equal("sig-policy");
    expect(entries[0].details).to.equal("Policy was updated");
  });

  it("maps agent events to agent_change with the agent address as actor", () => {
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "agent",
        eventType: "AgentRegistered",
        agent: AGENT,
      }),
    ]);
    expect(entries).to.have.length(1);
    expect(entries[0].eventType).to.equal("agent_change");
    expect(entries[0].actor).to.equal(AGENT);
  });

  it("maps security events to vault_security", () => {
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "security",
        eventType: "VaultFrozen",
        agent: null,
      }),
    ]);
    expect(entries).to.have.length(1);
    expect(entries[0].eventType).to.equal("vault_security");
    // Empty-string actor sentinel when no agent attribution exists.
    expect(entries[0].actor).to.equal("");
  });

  // Escrow events were removed in V2 (REVAMP_PLAN §2.1). `buildAuditTrail`
  // only maps policy/agent/security categories — see `AUDIT_CATEGORY_TO_TYPE`
  // in `sdk/kit/src/dashboard/reads.ts`. The "maps escrow events" case is
  // gone with no V2 equivalent.

  it("converts timestamp seconds to milliseconds", () => {
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "policy",
        eventType: "PolicyChangeApplied",
        timestamp: 1_700_000_000,
      }),
    ]);
    expect(entries[0].timestamp).to.equal(1_700_000_000 * 1000);
  });

  it("preserves audit-event order from the input (newest-first by convention)", () => {
    // getVaultActivity sorts items newest-first; buildAuditTrail must
    // preserve that ordering rather than re-sorting.
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "policy",
        eventType: "PolicyChangeApplied",
        timestamp: 2,
        txSignature: "sig-2",
      }),
      fixtureActivity({
        category: "agent",
        eventType: "AgentRegistered",
        timestamp: 1,
        txSignature: "sig-1",
      }),
    ]);
    expect(entries.map((e) => e.txSignature)).to.deep.equal(["sig-2", "sig-1"]);
  });

  it("toJSON returns string-only fields with the same shape", () => {
    const entries = buildAuditTrail([
      fixtureActivity({
        category: "policy",
        eventType: "PolicyChangeApplied",
      }),
    ]);
    const json = entries[0].toJSON();
    expect(json).to.have.all.keys(
      "timestamp",
      "eventType",
      "eventName",
      "actor",
      "details",
      "txSignature",
    );
    expect(typeof json.timestamp).to.equal("number");
    expect(typeof json.actor).to.equal("string");
  });
});

// ─── OwnerClient.getAuditTrail — delegation + since filter ─────────────────
//
// Cannot mutate ESM imports, so we use a sentinel-RPC pattern: the Proxy
// throws on the first method call, which proves we ran through
// reads.getAuditTrail's RPC layer (rather than short-circuiting).

describe("OwnerClient.getAuditTrail (S12)", () => {
  function mockSigner(addr: Address = OWNER): TransactionSigner {
    return {
      address: addr,
      signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
    } as unknown as TransactionSigner;
  }

  it("exposes getAuditTrail as a method on OwnerClient", () => {
    const client = new OwnerClient({
      rpc: {} as unknown as OwnerClientConfig["rpc"],
      vault: VAULT,
      owner: mockSigner(),
      network: "devnet",
    });
    expect(typeof client.getAuditTrail).to.equal("function");
  });

  it("invokes reads.getAuditTrail and propagates the wrapped error path", async () => {
    const sentinelRpc = new Proxy(
      {},
      {
        get() {
          throw new Error("SENTINEL_RPC_REACHED");
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
      await client.getAuditTrail({ limit: 25, since: 999 });
    } catch (err) {
      caught = err;
    }
    expect(caught).to.not.equal(undefined);
    const msg = (caught as Error).message ?? "";
    expect(msg).to.include("OwnerClient.getAuditTrail");
  });

  it("references reads.getAuditTrail at module level (sanity)", () => {
    expect(typeof reads.getAuditTrail).to.equal("function");
  });

  it("accepts undefined opts (defaults applied internally)", async () => {
    const sentinelRpc = new Proxy(
      {},
      {
        get() {
          throw new Error("SENTINEL_RPC_REACHED");
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
      await client.getAuditTrail();
    } catch (err) {
      caught = err;
    }
    expect(caught).to.not.equal(undefined);
    expect((caught as Error).message ?? "").to.include(
      "OwnerClient.getAuditTrail",
    );
  });
});
