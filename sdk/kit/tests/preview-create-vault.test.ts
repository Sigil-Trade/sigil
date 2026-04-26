/**
 * Unit tests for `@usesigil/kit/previewCreateVault` (FE↔BE Contract C1).
 *
 * Pinned coverage areas (mirrors PRD ISC groups):
 *   G1 — public surface (exports, signature, immutability)
 *   G2 — PDA derivation correctness (4 PDAs in canonical order)
 *   G3 — account size correctness (`<Account>::SIZE` mirrors)
 *   G4 — cost math (BigInt mul-before-divide; no number/bigint mix)
 *   G5 — warning rules (4 codes + sorting + optional `field`)
 *   G6 — input validation (RangeError on bigint < 0, count > MAX, etc.)
 *   G7 — determinism + immutability (`Object.freeze` + concurrency)
 *   G8 — tx integrity (round-trip decode, `txSizeBytes`, `lastValidBlockHeight`)
 *   G9 — RPC failure handling (typed throws on bad rent response)
 */
import { expect } from "chai";

import {
  previewCreateVault,
  type CreateVaultPreview,
  type PreviewCreateVaultConfig,
  type PreviewWarning,
  type VaultPdaInfo,
} from "../src/preview-create-vault.js";
import {
  createMockRpc,
  MOCK_BLOCKHASH,
  type MockRpcOverrides,
} from "../src/testing/mock-rpc.js";
import { CU_VAULT_CREATION } from "../src/priority-fees.js";
import { MAX_TX_SIZE } from "../src/composer.js";
import {
  getAgentOverlayPDA,
  getPolicyPDA,
  getTrackerPDA,
  getVaultPDA,
} from "../src/resolve-accounts.js";
import { getCompiledTransactionMessageDecoder } from "../src/kit-adapter.js";
import type { Address } from "../src/kit-adapter.js";
import { SigilSdkDomainError } from "../src/errors/sdk.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Use base58-valid placeholder addresses (the existing MOCK_OWNER /
// MOCK_AGENT in mock-rpc.ts contain the letter `O` which is not in base58
// — fine for non-base58-validated paths but breaks `seedAddress` calls
// inside PDA derivation). These mirror the pattern in owner-transaction.test.ts.
const TEST_OWNER = "11111111111111111111111111111114" as Address;
const TEST_AGENT = "11111111111111111111111111111115" as Address;
const TEST_FEE_DEST = "11111111111111111111111111111116" as Address;
const SOL_PRICE_USD = 250_000_000n; // $250.00 in 6-decimal base units

/** Default per-PDA rent the mock returns: `(size + 128) × 6960`. */
function defaultMockRent(size: bigint): bigint {
  return (size + 128n) * 6_960n;
}

/**
 * Canonical fixture. Tests override only the field they're exercising.
 * `priorityFeeMicroLamports = 0` produces deterministic `feeLamports = 0n`.
 * `addressLookupTables = {}` skips ALT resolution (no `getMultipleAccounts`).
 * `blockhash = MOCK_BLOCKHASH` skips `getLatestBlockhash`.
 */
function baseConfig(
  overrides?: Partial<PreviewCreateVaultConfig>,
): PreviewCreateVaultConfig {
  return {
    rpc: createMockRpc(),
    owner: TEST_OWNER,
    agentAddress: TEST_AGENT,
    network: "devnet",
    vaultId: 0n,
    dailyCapUsd: 500_000_000n,
    maxTxSizeUsd: 100_000_000n,
    spendingLimitUsd: 100_000_000n,
    developerFeeRate: 200,
    maxSlippageBps: 100,
    timelockDuration: 1_800n,
    protocolMode: 0,
    protocols: [],
    protocolCaps: [],
    allowedDestinations: [],
    feeDestination: TEST_FEE_DEST,
    solPriceUsd: SOL_PRICE_USD,
    priorityFeeMicroLamports: 0,
    blockhash: MOCK_BLOCKHASH,
    addressLookupTables: {},
    ...overrides,
  };
}

// ─── G1 — Public surface ────────────────────────────────────────────────────

describe("previewCreateVault — public surface", () => {
  it("returns a CreateVaultPreview with all required fields populated", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r).to.have.all.keys([
      "pdaList",
      "rentLamports",
      "computeUnits",
      "feeLamports",
      "totalCostUsd",
      "vaultAddress",
      "unsignedTxBytes",
      "txSizeBytes",
      "lastValidBlockHeight",
    ]);
  });

  it("signature is async — returns a Promise<CreateVaultPreview>", () => {
    const result = previewCreateVault(baseConfig());
    expect(result).to.be.an.instanceOf(Promise);
  });

  it("unsignedTxBytes is a Uint8Array with length > 0", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.unsignedTxBytes).to.be.instanceOf(Uint8Array);
    expect(r.unsignedTxBytes.byteLength).to.be.greaterThan(0);
  });
});

// ─── G2 — PDA derivation correctness ────────────────────────────────────────

describe("previewCreateVault — PDA derivation", () => {
  it("pdaList contains exactly 4 entries", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList).to.have.lengthOf(4);
  });

  it("pdaList canonical order: AgentVault → PolicyConfig → SpendTracker → AgentSpendOverlay", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList.map((p) => p.name)).to.deep.equal([
      "AgentVault",
      "PolicyConfig",
      "SpendTracker",
      "AgentSpendOverlay",
    ]);
  });

  it("AgentVault address matches independent getVaultPDA(owner, vaultId)", async () => {
    const cfg = baseConfig();
    const r = await previewCreateVault(cfg);
    const [expected] = await getVaultPDA(cfg.owner as Address, cfg.vaultId);
    const vault = r.pdaList.find((p) => p.name === "AgentVault");
    expect(vault, "AgentVault PDA present").to.exist;
    expect(vault!.address).to.equal(expected);
  });

  it("PolicyConfig address matches getPolicyPDA(vault) independently", async () => {
    const r = await previewCreateVault(baseConfig());
    const [expected] = await getPolicyPDA(r.vaultAddress);
    expect(r.pdaList[1]!.address).to.equal(expected);
  });

  it("SpendTracker address matches getTrackerPDA(vault) independently", async () => {
    const r = await previewCreateVault(baseConfig());
    const [expected] = await getTrackerPDA(r.vaultAddress);
    expect(r.pdaList[2]!.address).to.equal(expected);
  });

  it("AgentSpendOverlay address matches getAgentOverlayPDA(vault, 0) independently", async () => {
    const r = await previewCreateVault(baseConfig());
    const [expected] = await getAgentOverlayPDA(r.vaultAddress, 0);
    expect(r.pdaList[3]!.address).to.equal(expected);
  });

  it("each PDA bump is in the valid u8 range [0, 255]", async () => {
    const r = await previewCreateVault(baseConfig());
    for (const pda of r.pdaList) {
      expect(pda.bump, `${pda.name} bump`).to.be.within(0, 255);
    }
  });

  it("vaultAddress equals pdaList[0].address (AgentVault)", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.vaultAddress).to.equal(r.pdaList[0]!.address);
  });
});

// ─── G3 — Account size correctness ──────────────────────────────────────────

describe("previewCreateVault — on-chain account sizes", () => {
  it("AgentVault sizeBytes equals 634", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList[0]!.sizeBytes).to.equal(634);
  });

  it("PolicyConfig sizeBytes equals 822", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList[1]!.sizeBytes).to.equal(822);
  });

  it("SpendTracker sizeBytes equals 2,840", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList[2]!.sizeBytes).to.equal(2_840);
  });

  it("AgentSpendOverlay sizeBytes equals 2,528", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.pdaList[3]!.sizeBytes).to.equal(2_528);
  });
});

// ─── G4 — Cost math ─────────────────────────────────────────────────────────

describe("previewCreateVault — cost math", () => {
  it("rentLamports equals the sum of pdaList[].rentLamports", async () => {
    const r = await previewCreateVault(baseConfig());
    const sum = r.pdaList.reduce<bigint>((acc, p) => acc + p.rentLamports, 0n);
    expect(r.rentLamports).to.equal(sum);
  });

  it("each PDA rentLamports equals (size+128) × 6960 (mock formula)", async () => {
    const r = await previewCreateVault(baseConfig());
    for (const pda of r.pdaList) {
      const expected = defaultMockRent(BigInt(pda.sizeBytes));
      expect(pda.rentLamports, `${pda.name} rent`).to.equal(expected);
    }
  });

  it("feeLamports = priorityFee×CU/1_000_000n with explicit BigInt math", async () => {
    const cfg = baseConfig({
      priorityFeeMicroLamports: 50_000,
      computeUnits: 400_000,
    });
    const r = await previewCreateVault(cfg);
    // 50_000 × 400_000 = 20_000_000_000 microLamports = 20_000 lamports
    expect(r.feeLamports).to.equal(20_000n);
  });

  it("feeLamports is 0n when priorityFeeMicroLamports is 0", async () => {
    const r = await previewCreateVault(
      baseConfig({ priorityFeeMicroLamports: 0 }),
    );
    expect(r.feeLamports).to.equal(0n);
  });

  it("totalCostUsd = (rent + fee) × solPriceUsd / 1_000_000_000n (BigInt)", async () => {
    const cfg = baseConfig({
      priorityFeeMicroLamports: 0,
      solPriceUsd: 200_000_000n, // $200
    });
    const r = await previewCreateVault(cfg);
    const expected = (r.rentLamports * 200_000_000n) / 1_000_000_000n;
    expect(r.totalCostUsd).to.equal(expected);
  });

  it("totalCostUsd fixture: rent ~52M + fee 0 + price $250 → known value", async () => {
    // pin a single concrete value so a future drift triggers a test failure.
    // Sum of rent for the 4 PDAs at default mock formula = ((634+128) +
    // (822+128) + (2840+128) + (2528+128)) × 6960 = (762+950+2968+2656) ×
    // 6960 = 7336 × 6960 = 51_058_560 lamports.
    // totalCostUsd = 51_058_560 × 250_000_000 / 1_000_000_000 = 12_764_640
    // (= $12.76464 in 6-decimal USD).
    const r = await previewCreateVault(
      baseConfig({
        priorityFeeMicroLamports: 0,
        solPriceUsd: 250_000_000n,
      }),
    );
    expect(r.rentLamports).to.equal(51_058_560n);
    expect(r.totalCostUsd).to.equal(12_764_640n);
  });

  it("totalCostUsd is bigint (never number)", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(typeof r.totalCostUsd).to.equal("bigint");
  });

  it("computeUnits defaults to CU_VAULT_CREATION (400_000)", async () => {
    const r = await previewCreateVault(baseConfig({ computeUnits: undefined }));
    expect(r.computeUnits).to.equal(CU_VAULT_CREATION);
    expect(CU_VAULT_CREATION).to.equal(400_000);
  });

  it("computeUnits override propagates to feeLamports math", async () => {
    const r = await previewCreateVault(
      baseConfig({
        computeUnits: 1_000_000,
        priorityFeeMicroLamports: 1_000,
      }),
    );
    // 1_000 × 1_000_000 = 1_000_000_000 microLamports = 1_000 lamports
    expect(r.computeUnits).to.equal(1_000_000);
    expect(r.feeLamports).to.equal(1_000n);
  });
});

// ─── G5 — Warning rules ─────────────────────────────────────────────────────

describe("previewCreateVault — warnings", () => {
  it("warnings is undefined when no warnings fire (clean config)", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.warnings).to.equal(undefined);
  });

  it("daily_cap_zero fires when dailyCapUsd === 0n (info severity)", async () => {
    const r = await previewCreateVault(
      baseConfig({ dailyCapUsd: 0n, maxTxSizeUsd: 0n, spendingLimitUsd: 0n }),
    );
    const w = r.warnings?.find((x) => x.code === "daily_cap_zero");
    expect(w, "daily_cap_zero present").to.exist;
    expect(w!.severity).to.equal("info");
    expect(w!.field).to.equal("dailyCapUsd");
  });

  it("daily_cap_unusually_high fires when dailyCapUsd > $1M", async () => {
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 2_000_000_000_000n, // $2M
        maxTxSizeUsd: 1_000_000_000n,
        spendingLimitUsd: 1_000_000_000n,
      }),
    );
    const w = r.warnings?.find((x) => x.code === "daily_cap_unusually_high");
    expect(w, "daily_cap_unusually_high present").to.exist;
    expect(w!.severity).to.equal("warning");
    expect(w!.suggestedValue).to.equal(1_000_000_000_000n);
  });

  it("no_protocols_approved fires when allowlist + 0 protocols", async () => {
    const r = await previewCreateVault(
      baseConfig({ protocolMode: 1, protocols: [] }),
    );
    const w = r.warnings?.find((x) => x.code === "no_protocols_approved");
    expect(w, "no_protocols_approved present").to.exist;
    expect(w!.field).to.equal("protocols");
  });

  it("no_protocols_approved does NOT fire when mode=ALL + 0 protocols", async () => {
    const r = await previewCreateVault(
      baseConfig({ protocolMode: 0, protocols: [] }),
    );
    expect(r.warnings).to.equal(undefined);
  });

  it("max_tx_exceeds_daily_cap fires when maxTx > dailyCap", async () => {
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 100_000_000n,
        maxTxSizeUsd: 200_000_000n,
        spendingLimitUsd: 100_000_000n,
      }),
    );
    const w = r.warnings?.find((x) => x.code === "max_tx_exceeds_daily_cap");
    expect(w, "max_tx_exceeds_daily_cap present").to.exist;
    expect(w!.suggestedValue).to.equal(100_000_000n);
  });

  it("warnings are sorted by code ascending (FE-stable React keys)", async () => {
    // Trigger 3 warnings simultaneously: cap=0 + allowlist+empty + maxTx>cap
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 0n,
        maxTxSizeUsd: 100_000_000n, // > 0 → max_tx_exceeds_daily_cap
        spendingLimitUsd: 0n,
        protocolMode: 1,
        protocols: [],
      }),
    );
    const codes = r.warnings!.map((w) => w.code);
    const sorted = [...codes].sort();
    expect(codes).to.deep.equal(sorted);
  });

  it("multiple warnings fire simultaneously without stomping", async () => {
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 0n,
        maxTxSizeUsd: 100_000_000n,
        spendingLimitUsd: 0n,
        protocolMode: 1,
        protocols: [],
      }),
    );
    expect(r.warnings).to.have.lengthOf(3);
    const codes = new Set(r.warnings!.map((w) => w.code));
    expect(codes.has("daily_cap_zero")).to.equal(true);
    expect(codes.has("no_protocols_approved")).to.equal(true);
    expect(codes.has("max_tx_exceeds_daily_cap")).to.equal(true);
  });

  it("each warning has code + severity + message; severity ∈ {info, warning}", async () => {
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 0n,
        maxTxSizeUsd: 0n,
        spendingLimitUsd: 0n,
      }),
    );
    for (const w of r.warnings!) {
      expect(w.code).to.be.a("string").and.not.empty;
      expect(w.message).to.be.a("string").and.not.empty;
      expect(["info", "warning"]).to.include(w.severity);
    }
  });
});

// ─── G6 — Input validation ──────────────────────────────────────────────────

describe("previewCreateVault — input validation throws", () => {
  it("vaultId < 0n throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ vaultId: -1n }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/vaultId/);
  });

  it("dailyCapUsd < 0n throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ dailyCapUsd: -1n }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/dailyCapUsd/);
  });

  it("solPriceUsd < 0n throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ solPriceUsd: -1n }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("developerFeeRate > 500 throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ developerFeeRate: 501 }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/developerFeeRate/);
  });

  it("protocols.length > 10 throws RangeError", async () => {
    const tooMany = Array.from({ length: 11 }, () => TEST_OWNER);
    let thrown: unknown = null;
    try {
      await previewCreateVault(
        baseConfig({ protocols: tooMany, protocolMode: 1 }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/protocols/);
  });

  it("allowedDestinations.length > 10 throws RangeError", async () => {
    const tooMany = Array.from({ length: 11 }, () => TEST_OWNER);
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ allowedDestinations: tooMany }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("timelockDuration < 1800n throws RangeError (MIN_TIMELOCK_DURATION mirror)", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ timelockDuration: 100n }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/timelockDuration/);
  });

  it("timelockDuration === 1800n is accepted (boundary)", async () => {
    const r = await previewCreateVault(
      baseConfig({ timelockDuration: 1_800n }),
    );
    expect(r).to.exist;
  });

  it("invalid network propagates validateNetwork error (not RangeError)", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ network: "garbage" as never }));
    } catch (e) {
      thrown = e;
    }
    // SigilSdkDomainError, not RangeError.
    expect(thrown).to.not.be.instanceOf(RangeError);
    expect(thrown).to.be.instanceOf(SigilSdkDomainError);
  });

  it("protocolCaps non-empty + protocolMode != 1 throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(
        baseConfig({
          protocolMode: 0,
          protocols: [TEST_OWNER],
          protocolCaps: [100_000_000n],
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/ALLOWLIST/);
  });

  it("protocolCaps.length mismatched with protocols.length throws", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(
        baseConfig({
          protocolMode: 1,
          protocols: [TEST_OWNER, TEST_AGENT],
          protocolCaps: [100_000_000n], // length 1, expected 2
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("solPriceUsd === 0n throws RangeError (no silent $0 lie)", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ solPriceUsd: 0n }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/solPriceUsd/);
  });

  it("feeDestination === SYSTEM_PROGRAM throws RangeError (mirror on-chain InvalidFeeDestination)", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(
        baseConfig({
          feeDestination: "11111111111111111111111111111111" as Address,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/system program/);
  });

  it("priorityFeeMicroLamports negative throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ priorityFeeMicroLamports: -1 }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("priorityFeeMicroLamports non-integer throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ priorityFeeMicroLamports: 1.5 }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("priorityFeeMicroLamports NaN throws RangeError", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(
        baseConfig({ priorityFeeMicroLamports: Number.NaN }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("computeUnits = 0 throws RangeError (must be positive)", async () => {
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ computeUnits: 0 }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
  });

  it("dailyCapUsd > u64::MAX throws RangeError (overflow guard)", async () => {
    const overflow = (1n << 64n) + 1n;
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ dailyCapUsd: overflow }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/u64::MAX/);
  });

  it("timelockDuration > Number.MAX_SAFE_INTEGER throws RangeError (precision guard)", async () => {
    const overflow = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ timelockDuration: overflow }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(RangeError);
    expect((thrown as RangeError).message).to.match(/precision/);
  });
});

// ─── G7 — Determinism + immutability ────────────────────────────────────────

describe("previewCreateVault — determinism + immutability", () => {
  it("same input → identical pdaList (addresses, names, sizes, bumps, rent)", async () => {
    const r1 = await previewCreateVault(baseConfig());
    const r2 = await previewCreateVault(baseConfig());
    expect(r1.pdaList.length).to.equal(r2.pdaList.length);
    for (let i = 0; i < r1.pdaList.length; i++) {
      expect(r1.pdaList[i]!.address).to.equal(r2.pdaList[i]!.address);
      expect(r1.pdaList[i]!.name).to.equal(r2.pdaList[i]!.name);
      expect(r1.pdaList[i]!.sizeBytes).to.equal(r2.pdaList[i]!.sizeBytes);
      expect(r1.pdaList[i]!.bump).to.equal(r2.pdaList[i]!.bump);
      expect(r1.pdaList[i]!.rentLamports).to.equal(r2.pdaList[i]!.rentLamports);
    }
  });

  it("same input → identical totalCostUsd", async () => {
    const r1 = await previewCreateVault(baseConfig());
    const r2 = await previewCreateVault(baseConfig());
    expect(r1.totalCostUsd).to.equal(r2.totalCostUsd);
  });

  it("returned preview is Object.freeze'd (mutation throws in strict mode)", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(Object.isFrozen(r)).to.equal(true);
  });

  it("pdaList array is frozen", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(Object.isFrozen(r.pdaList)).to.equal(true);
  });

  it("each pdaList entry is frozen", async () => {
    const r = await previewCreateVault(baseConfig());
    for (const pda of r.pdaList) {
      expect(Object.isFrozen(pda)).to.equal(true);
    }
  });

  it("warnings array is frozen when present", async () => {
    const r = await previewCreateVault(
      baseConfig({ dailyCapUsd: 0n, maxTxSizeUsd: 0n, spendingLimitUsd: 0n }),
    );
    expect(Object.isFrozen(r.warnings)).to.equal(true);
  });

  it("two parallel calls don't corrupt shared state — outputs are byte-equal", async () => {
    const cfg = baseConfig();
    const [r1, r2] = await Promise.all([
      previewCreateVault(cfg),
      previewCreateVault(cfg),
    ]);
    expect(r1.vaultAddress).to.equal(r2.vaultAddress);
    expect(r1.rentLamports).to.equal(r2.rentLamports);
    expect(r1.totalCostUsd).to.equal(r2.totalCostUsd);
    expect(r1.pdaList.length).to.equal(r2.pdaList.length);
  });
});

// ─── G8 — Tx integrity ──────────────────────────────────────────────────────

describe("previewCreateVault — tx integrity", () => {
  it("unsignedTxBytes round-trips via getCompiledTransactionMessageDecoder", async () => {
    const r = await previewCreateVault(baseConfig());
    // Wire bytes start with signature_count_byte (compact-u16) + signatures
    // + message bytes. The compiled transaction message lives at offset
    // (1 + 64 * num_sigs). For 1 signer: offset = 1 + 64 = 65.
    const numSigs = r.unsignedTxBytes[0]!;
    expect(numSigs).to.equal(1);
    const messageBytes = r.unsignedTxBytes.slice(1 + 64 * numSigs);
    const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
    expect(decoded).to.exist;
    // Versioned tx has header + staticAccounts + lifetimeToken + instructions.
    // Static accounts include the fee payer (owner) at index 0.
    expect((decoded as any).staticAccounts[0]).to.equal(TEST_OWNER);
  });

  it("txSizeBytes is reported and within Solana's 1232-byte limit", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.txSizeBytes).to.be.a("number");
    expect(r.txSizeBytes).to.be.greaterThan(0);
    expect(r.txSizeBytes).to.be.at.most(MAX_TX_SIZE);
  });

  it("unsignedTxBytes.byteLength equals txSizeBytes", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(r.unsignedTxBytes.byteLength).to.equal(r.txSizeBytes);
  });

  it("lastValidBlockHeight is bigint and matches the supplied blockhash", async () => {
    const r = await previewCreateVault(baseConfig());
    expect(typeof r.lastValidBlockHeight).to.equal("bigint");
    expect(r.lastValidBlockHeight).to.equal(
      MOCK_BLOCKHASH.lastValidBlockHeight,
    );
  });
});

// ─── G9 — RPC failure handling ──────────────────────────────────────────────

describe("previewCreateVault — RPC failure handling", () => {
  it("getMinimumBalanceForRentExemption returning 0n throws SigilSdkDomainError", async () => {
    const overrides: MockRpcOverrides = {
      getMinimumBalanceForRentExemptionResult: 0n,
    };
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ rpc: createMockRpc(overrides) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(SigilSdkDomainError);
    expect((thrown as Error).message).to.match(/positive lamport/);
  });

  it("getMinimumBalanceForRentExemption returning negative bigint throws SigilSdkDomainError", async () => {
    const overrides: MockRpcOverrides = {
      getMinimumBalanceForRentExemptionResult: -100n,
    };
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ rpc: createMockRpc(overrides) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(SigilSdkDomainError);
    expect((thrown as Error).message).to.match(/positive lamport/);
  });

  it("getMinimumBalanceForRentExemption returning undefined throws SigilSdkDomainError", async () => {
    const overrides: MockRpcOverrides = {
      // mock function returns undefined → mock cast to bigint will fail
      // (typeof undefined !== "bigint" branch fires)
      getMinimumBalanceForRentExemptionResult: () =>
        undefined as unknown as bigint,
    };
    let thrown: unknown = null;
    try {
      await previewCreateVault(baseConfig({ rpc: createMockRpc(overrides) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(SigilSdkDomainError);
    expect((thrown as Error).message).to.match(/non-bigint/);
  });
});

// ─── Type identity guards (compile-time assertions) ─────────────────────────

describe("previewCreateVault — type identity (compile-time guards)", () => {
  it("VaultPdaInfo.name is the canonical 4-tuple union", () => {
    const sample: VaultPdaInfo["name"] = "AgentVault";
    expect([
      "AgentVault",
      "PolicyConfig",
      "SpendTracker",
      "AgentSpendOverlay",
    ]).to.include(sample);
  });

  it("PreviewWarning.code is the canonical 4-tuple union", () => {
    const sample: PreviewWarning["code"] = "daily_cap_zero";
    expect([
      "daily_cap_zero",
      "daily_cap_unusually_high",
      "no_protocols_approved",
      "max_tx_exceeds_daily_cap",
    ]).to.include(sample);
  });

  it("PreviewWarning is a discriminated union — narrowing by code yields the right field set", async () => {
    const r = await previewCreateVault(
      baseConfig({
        dailyCapUsd: 0n,
        maxTxSizeUsd: 100_000_000n,
        spendingLimitUsd: 0n,
      }),
    );
    for (const w of r.warnings!) {
      // Compile-time narrowing via switch — TS rejects this if the union
      // isn't discriminated. Body asserts the runtime invariants.
      switch (w.code) {
        case "daily_cap_zero":
          expect(w.field).to.equal("dailyCapUsd");
          // No `suggestedValue` on this variant.
          expect((w as { suggestedValue?: unknown }).suggestedValue).to.equal(
            undefined,
          );
          break;
        case "daily_cap_unusually_high":
          expect(w.field).to.equal("dailyCapUsd");
          expect(typeof w.suggestedValue).to.equal("bigint");
          break;
        case "no_protocols_approved":
          expect(w.field).to.equal("protocols");
          break;
        case "max_tx_exceeds_daily_cap":
          expect(w.field).to.equal("maxTxSizeUsd");
          expect(typeof w.suggestedValue).to.equal("bigint");
          break;
      }
    }
  });

  it("CreateVaultPreview type structurally exposes the 9 documented fields", async () => {
    // Compile-time sanity: a function expecting CreateVaultPreview must
    // accept the runtime return value.
    const consume = (_: CreateVaultPreview) => {};
    const r = await previewCreateVault(baseConfig());
    consume(r);
    expect(r).to.exist;
  });
});
