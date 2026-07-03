/**
 * 0.25 dashboard punch-list — read-back parity + JSON round-trip.
 *
 * Item 2: fields the dashboard can WRITE (via PolicyChanges) but previously
 * could not READ are now populated by buildPolicy / buildVaultState and survive
 * the toJSON → fromJSON round-trip (the highest-risk area — a from-json miss
 * silently drops financial/security state on the MCP round-trip).
 *
 * Item 3: ActivityData.nextCursor survives the round-trip and defaults to null
 * for pre-0.25 JSON.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import type { Address } from "@solana/kit";

import { buildPolicy, buildVaultState } from "../../src/dashboard/reads.js";
import {
  policyDataFromJSON,
  vaultStateFromJSON,
  activityDataFromJSON,
} from "../../src/dashboard/from-json.js";
import { createMockVaultState } from "../../src/testing/mock-state.js";
import type { ResolvedVaultStateForOwner } from "../../src/state-resolver.js";
import type { SerializedActivityData } from "../../src/dashboard/types.js";

const VAULT = "Vault11111111111111111111111111111111111111" as Address;
const PROTO = "Proto11111111111111111111111111111111111111" as Address;
const DEST = "Dest111111111111111111111111111111111111111" as Address;
const COSIGN = "Cosign11111111111111111111111111111111111111" as Address;
const SYSTEM = "11111111111111111111111111111111"; // Pubkey::default()

function ctxWith(mutate: (s: ReturnType<typeof createMockVaultState>) => void) {
  const s = createMockVaultState({ observeOnly: true, protocols: [PROTO] });
  mutate(s);
  return { vault: VAULT, state: s as unknown as ResolvedVaultStateForOwner };
}

describe("0.25 Item 2 — PolicyData advanced-control read-back", () => {
  it("populates every new field from the decoded PolicyConfig (non-default)", () => {
    const policy = buildPolicy(
      ctxWith((s) => {
        s.policy.cosignRequired = true;
        s.policy.cosignSessionPubkey = COSIGN;
        s.policy.stableBalanceFloor = 1_000_000n;
        s.policy.perRecipientDailyCapUsd = 500_000n;
        s.policy.operatorGrantDelaySeconds = 3_600n;
        s.policy.destinationMode = 0;
        s.policy.protocolHashes[0] = new Uint8Array(32).fill(0xab);
        s.policy.destinationGraylist = [
          { destination: DEST, unlockUnix: 1_700_000_000n },
        ];
      }),
    );

    expect(policy.cosignRequired).to.equal(true);
    expect(policy.cosignSessionPubkey).to.equal(COSIGN);
    expect(policy.stableBalanceFloor).to.equal(1_000_000n);
    expect(policy.perRecipientDailyCapUsd).to.equal(500_000n);
    expect(policy.operatorGrantDelaySeconds).to.equal(3_600n);
    expect(policy.destinationMode).to.equal(0);

    expect(policy.protocolHashes).to.have.length(1);
    expect(policy.protocolHashes![0].programId).to.equal(PROTO);
    expect(policy.protocolHashes![0].armed).to.equal(true);
    expect(policy.protocolHashes![0].hash).to.equal("ab".repeat(32));

    expect(policy.graylist).to.have.length(1);
    expect(policy.graylist![0].destination).to.equal(DEST);
    expect(policy.graylist![0].unlockUnix).to.equal(1_700_000_000n);
  });

  it("maps on-chain defaults to null (cosign session, per-recipient cap) + disarmed hash", () => {
    // createMockVaultState defaults: cosign session = Pubkey::default(),
    // per-recipient cap = 0, all protocol hashes all-zero.
    const policy = buildPolicy(ctxWith(() => {}));
    expect(policy.cosignSessionPubkey).to.equal(null);
    expect(policy.perRecipientDailyCapUsd).to.equal(null);
    expect(policy.protocolHashes![0].armed).to.equal(false);
    expect(policy.protocolHashes![0].hash).to.equal(null);
    // sanity: the default cosign pubkey is the system-program address
    expect(SYSTEM).to.have.length(32);
  });

  it("survives the toJSON → policyDataFromJSON round-trip (bigint + null fidelity)", () => {
    const policy = buildPolicy(
      ctxWith((s) => {
        s.policy.cosignRequired = true;
        s.policy.cosignSessionPubkey = COSIGN;
        s.policy.stableBalanceFloor = 1_000_000n;
        s.policy.perRecipientDailyCapUsd = 500_000n;
        s.policy.operatorGrantDelaySeconds = 3_600n;
        s.policy.protocolHashes[0] = new Uint8Array(32).fill(0xab);
        s.policy.destinationGraylist = [
          { destination: DEST, unlockUnix: 1_700_000_000n },
        ];
      }),
    );

    // Simulate the MCP wire hop: object → JSON string → object → live type.
    const wire = JSON.parse(JSON.stringify(policy.toJSON()));
    const rt = policyDataFromJSON(wire);

    expect(rt.cosignRequired).to.equal(true);
    expect(rt.cosignSessionPubkey).to.equal(COSIGN);
    expect(rt.stableBalanceFloor).to.equal(1_000_000n);
    expect(rt.perRecipientDailyCapUsd).to.equal(500_000n);
    expect(rt.operatorGrantDelaySeconds).to.equal(3_600n);
    expect(rt.protocolHashes![0]).to.deep.equal({
      programId: PROTO,
      armed: true,
      hash: "ab".repeat(32),
    });
    expect(rt.graylist![0].unlockUnix).to.equal(1_700_000_000n);
    expect(typeof rt.graylist![0].unlockUnix).to.equal("bigint");
  });

  it("round-trips the null defaults faithfully", () => {
    const policy = buildPolicy(ctxWith(() => {}));
    const rt = policyDataFromJSON(JSON.parse(JSON.stringify(policy.toJSON())));
    expect(rt.cosignSessionPubkey).to.equal(null);
    expect(rt.perRecipientDailyCapUsd).to.equal(null);
    expect(rt.stableBalanceFloor).to.equal(0n);
  });

  it("policyDataFromJSON defaults new fields for pre-0.25 JSON (no keys present)", () => {
    // A legacy serialized payload lacking every new key must still deserialize.
    const legacy = {
      dailyCap: "5000000000",
      maxPerTrade: "1000000000",
      approvedApps: [],
      protocolMode: "whitelist",
      hasProtocolCaps: false,
      protocolCaps: [],
      maxSlippageBps: 50,
      allowedDestinations: [],
      developerFeeRate: 200,
      sessionExpirySeconds: "20",
      timelockSeconds: 1800,
      policyVersion: "5",
    };
    const rt = policyDataFromJSON(legacy as never);
    expect(rt.cosignRequired).to.equal(false);
    expect(rt.cosignSessionPubkey).to.equal(null);
    expect(rt.stableBalanceFloor).to.equal(0n);
    expect(rt.perRecipientDailyCapUsd).to.equal(null);
    expect(rt.destinationMode).to.equal(0);
    expect(rt.operatorGrantDelaySeconds).to.equal(0n);
    expect(rt.protocolHashes).to.deep.equal([]);
    expect(rt.graylist).to.deep.equal([]);
  });
});

describe("0.25 Item 2 — VaultState.observeOnly read-back", () => {
  it("populates observeOnly and round-trips it", () => {
    const view = buildVaultState(ctxWith(() => {}));
    expect(view.vault.observeOnly).to.equal(true);

    const rt = vaultStateFromJSON(JSON.parse(JSON.stringify(view.toJSON())));
    expect(rt.vault.observeOnly).to.equal(true);
  });

  it("vaultStateFromJSON defaults observeOnly=false for pre-0.25 JSON", () => {
    const legacy = {
      vault: {
        address: "v",
        status: "active" as const,
        owner: "o",
        agentCount: 0,
        totalVolume: "0",
        totalFees: "0",
      },
      balance: { total: "0", tokens: [] },
      pnl: { percent: 0, absolute: "0" },
      health: { level: "healthy", alertCount: 0, checks: [] },
    };
    const rt = vaultStateFromJSON(legacy as never);
    expect(rt.vault.observeOnly).to.equal(false);
  });
});

describe("0.25 Item 3 — ActivityData.nextCursor round-trip", () => {
  it("preserves a non-null cursor", () => {
    const wire: SerializedActivityData = {
      rows: [],
      summary: { total: 0, approved: 0, blocked: 0, volume: "0" },
      nextCursor: "5oldestSig",
    };
    const rt = activityDataFromJSON(wire);
    expect(rt.nextCursor).to.equal("5oldestSig");
  });

  it("defaults nextCursor to null for pre-0.25 JSON (key absent)", () => {
    const wire = {
      rows: [],
      summary: { total: 0, approved: 0, blocked: 0, volume: "0" },
    };
    const rt = activityDataFromJSON(wire as never);
    expect(rt.nextCursor).to.equal(null);
  });
});
