/**
 * Tests for vault creation presets.
 */

import { expect } from "chai";
import {
  VAULT_PRESETS,
  getPreset,
  listPresets,
  presetToCreateVaultFields,
  type PresetName,
} from "../src/presets.js";
import {
  FULL_CAPABILITY,
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  JUPITER_PROGRAM_ADDRESS,
  MAX_SLIPPAGE_BPS,
} from "../src/types.js";

// ─── Base58 validation helper ────────────────────────────────────────────────

function isBase58Address(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

// ─── Preset Structure Tests ──────────────────────────────────────────────────

describe("VAULT_PRESETS", () => {
  const presetNames = Object.keys(VAULT_PRESETS) as PresetName[];

  it("has 4 presets", () => {
    expect(presetNames).to.have.length(4);
  });

  for (const name of presetNames) {
    describe(`${name}`, () => {
      const preset = VAULT_PRESETS[name];

      it("has label and description", () => {
        expect(preset.label).to.be.a("string").with.length.greaterThan(0);
        expect(preset.description).to.be.a("string").with.length.greaterThan(0);
      });

      it("has valid capability (non-negative bigint)", () => {
        expect(preset.capability).to.be.a("bigint");
        expect(preset.capability >= 0n).to.be.true;
      });

      it("has positive spending caps", () => {
        expect(preset.dailySpendingCapUsd > 0n).to.be.true;
        expect(preset.maxTransactionSizeUsd > 0n).to.be.true;
        expect(preset.maxTransactionSizeUsd <= preset.dailySpendingCapUsd).to.be
          .true;
      });

      it("has valid slippage (within MAX_SLIPPAGE_BPS)", () => {
        expect(preset.maxSlippageBps).to.be.greaterThan(0);
        expect(preset.maxSlippageBps).to.be.lessThanOrEqual(MAX_SLIPPAGE_BPS);
      });

      it("has valid protocol mode", () => {
        expect([0, 1, 2]).to.include(preset.protocolMode);
      });

      it("all protocol addresses are valid base58", () => {
        for (const addr of preset.protocols) {
          expect(isBase58Address(addr), `${addr} is not valid base58`).to.be
            .true;
        }
      });

      it("allowlist mode has protocols, allow-all mode has none", () => {
        if (preset.protocolMode === PROTOCOL_MODE_ALLOWLIST) {
          expect(preset.protocols.length).to.be.greaterThan(0);
        }
        if (preset.protocolMode === PROTOCOL_MODE_ALL) {
          expect(preset.protocols.length).to.equal(0);
        }
      });
    });
  }
});

// ─── Specific Preset Values ──────────────────────────────────────────────────

describe("preset values", () => {
  // Post-v6 the on-chain capability field is a 2-bit value (0 = Disabled,
  // 1 = Observer, 2 = Operator). Every preset configures a policy that
  // permits spending, so every preset's capability is FULL_CAPABILITY (2n).
  // Per-preset variation lives in the policy fields (caps, protocols,
  // slippage, leverage), not in the capability bitmask.

  it("jupiter-swap-bot has FULL_CAPABILITY (Operator)", () => {
    expect(VAULT_PRESETS["jupiter-swap-bot"].capability).to.equal(
      FULL_CAPABILITY,
    );
  });

  it("jupiter-swap-bot includes Jupiter in allowlist", () => {
    expect(VAULT_PRESETS["jupiter-swap-bot"].protocols).to.include(
      JUPITER_PROGRAM_ADDRESS,
    );
  });

  it("perps-trader has FULL_CAPABILITY (Operator)", () => {
    expect(VAULT_PRESETS["perps-trader"].capability).to.equal(FULL_CAPABILITY);
  });

  it("perps-trader allowlist includes both Jupiter and Flash Trade", () => {
    const protocols = VAULT_PRESETS["perps-trader"].protocols;
    expect(protocols).to.include(JUPITER_PROGRAM_ADDRESS);
    expect(protocols.length).to.be.greaterThan(1);
  });

  it("perps-trader has non-zero leverage", () => {
    expect(VAULT_PRESETS["perps-trader"].maxLeverageBps).to.be.greaterThan(0);
  });

  it("lending-optimizer has FULL_CAPABILITY (Operator)", () => {
    expect(VAULT_PRESETS["lending-optimizer"].capability).to.equal(
      FULL_CAPABILITY,
    );
  });

  it("lending-optimizer allowlist includes Jupiter Lend", () => {
    const protocols = VAULT_PRESETS["lending-optimizer"].protocols as string[];
    expect(protocols).to.include("JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu");
  });

  it("full-access has FULL_CAPABILITY", () => {
    expect(VAULT_PRESETS["full-access"].capability).to.equal(FULL_CAPABILITY);
  });

  it("full-access uses protocol mode all", () => {
    expect(VAULT_PRESETS["full-access"].protocolMode).to.equal(
      PROTOCOL_MODE_ALL,
    );
  });

  it("every preset's capability is within the on-chain invariant (<= 2n)", () => {
    for (const name of listPresets()) {
      const preset = VAULT_PRESETS[name];
      expect(
        preset.capability <= 2n,
        `${name}.capability = ${preset.capability}`,
      ).to.be.true;
      expect(
        preset.permissions <= 2n,
        `${name}.permissions = ${preset.permissions}`,
      ).to.be.true;
    }
  });
});

// ─── Functions ──────────────────────────────────────────────────────────────

describe("getPreset()", () => {
  it("returns preset for valid name", () => {
    const preset = getPreset("jupiter-swap-bot");
    expect(preset).to.exist;
    expect(preset!.label).to.equal("Jupiter Swap Bot");
  });

  it("returns undefined for unknown name", () => {
    expect(getPreset("nonexistent")).to.be.undefined;
  });

  it("returns undefined for __proto__ (prototype pollution guard)", () => {
    expect(getPreset("__proto__")).to.be.undefined;
  });

  it("returns undefined for constructor (prototype pollution guard)", () => {
    expect(getPreset("constructor")).to.be.undefined;
  });
});

describe("listPresets()", () => {
  it("returns all 4 preset names", () => {
    const names = listPresets();
    expect(names).to.have.length(4);
    expect(names).to.include("jupiter-swap-bot");
    expect(names).to.include("perps-trader");
    expect(names).to.include("lending-optimizer");
    expect(names).to.include("full-access");
  });
});

describe("presetToCreateVaultFields()", () => {
  it("returns fields compatible with CreateVaultOptions", () => {
    const fields = presetToCreateVaultFields("jupiter-swap-bot");
    expect(fields.permissions).to.equal(FULL_CAPABILITY);
    expect(fields.dailySpendingCapUsd).to.equal(500_000_000n);
    expect(fields.maxTransactionSizeUsd).to.equal(100_000_000n);
    expect(fields.maxSlippageBps).to.equal(200);
    expect(fields.protocolMode).to.equal(PROTOCOL_MODE_ALLOWLIST);
    expect(fields.protocols).to.deep.equal([JUPITER_PROGRAM_ADDRESS]);
    expect(fields.maxLeverageBps).to.equal(0);
    expect(fields.maxConcurrentPositions).to.equal(0);
  });

  it("returns a copy of protocols array (not a reference)", () => {
    const fields1 = presetToCreateVaultFields("jupiter-swap-bot");
    const fields2 = presetToCreateVaultFields("jupiter-swap-bot");
    expect(fields1.protocols).to.not.equal(fields2.protocols);
    expect(fields1.protocols).to.deep.equal(fields2.protocols);
  });
});
