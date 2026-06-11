/**
 * Tests for createVault() + createAndSendVault().
 *
 * createAndSendVault() composes createVault() → buildOwnerTransaction()
 * → signAndEncode() → sendAndConfirmTransaction(). Integration testing
 * requires LiteSVM or devnet. This file tests preconditions only.
 *
 * v0.9.0 additions:
 *   - `spendingLimitUsd`, `dailySpendingCapUsd`, `timelockDuration` are
 *     required — no silent defaults. Test coverage below.
 *   - Aggregate cap guard via `validateAgentCapAggregate` — rejects
 *     spendingLimitUsd > dailySpendingCapUsd at construction time.
 */

import { expect } from "chai";
import { createVault, createAndSendVault } from "../src/create-vault.js";
import type { Address, TransactionSigner } from "@solana/kit";
import { SigilSdkDomainError } from "../src/errors/sdk.js";
import {
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__SDK__CAP_EXCEEDED,
} from "../src/errors/codes.js";
import type { UsdBaseUnits } from "../src/types.js";

function createMockSigner(addr: Address): TransactionSigner {
  return {
    address: addr,
    signTransactions: async (txs: unknown[]) => txs,
  } as unknown as TransactionSigner;
}

const OWNER = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;
const AGENT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
// Any valid program pubkey — these are construction-time tests (no on-chain
// validation), the allowlist just has to be non-empty so the active-vault F-11
// guard (added with the protocolMode default fix) doesn't fire for the cap /
// required-param probes below.
const PROTOCOL = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

/**
 * A createVault options object with the minimum required fields filled in
 * for v0.9.0. Tests override one field at a time to probe specific error
 * paths. `vaultId` is supplied to avoid the findNextVaultId RPC call,
 * which would fail against the stub `{}` rpc object.
 */
function baseOpts() {
  return {
    rpc: {} as any,
    network: "devnet" as const,
    owner: createMockSigner(OWNER),
    agent: createMockSigner(AGENT),
    spendingLimitUsd: 100_000_000n as UsdBaseUnits,
    dailySpendingCapUsd: 500_000_000n as UsdBaseUnits,
    timelockDuration: 1800,
    vaultId: 1n,
    protocols: [PROTOCOL],
  };
}

describe("createAndSendVault — existing preconditions", () => {
  it("rejects owner === agent with exact error message", async () => {
    try {
      await createAndSendVault({
        ...baseOpts(),
        owner: createMockSigner(OWNER),
        agent: createMockSigner(OWNER),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).to.include(
        "Owner and agent must be different keys.",
      );
    }
  });
});

describe("createVault — v0.9.0 required params", () => {
  it("throws INVALID_PARAMS when spendingLimitUsd is undefined at runtime", async () => {
    const { spendingLimitUsd: _, ...rest } = baseOpts();
    try {
      await createVault(rest as never);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
      expect((err as Error).message).to.include("spendingLimitUsd");
    }
  });

  it("throws INVALID_PARAMS when dailySpendingCapUsd is undefined", async () => {
    const { dailySpendingCapUsd: _, ...rest } = baseOpts();
    try {
      await createVault(rest as never);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
      expect((err as Error).message).to.include("dailySpendingCapUsd");
    }
  });

  it("throws INVALID_PARAMS when timelockDuration is undefined", async () => {
    const { timelockDuration: _, ...rest } = baseOpts();
    try {
      await createVault(rest as never);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
      expect((err as Error).message).to.include("timelockDuration");
    }
  });

  it("runtime rejects non-bigint spendingLimitUsd (JS-only consumer)", async () => {
    const opts = { ...baseOpts(), spendingLimitUsd: 100 as never };
    try {
      await createVault(opts);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
    }
  });

  it("runtime rejects non-number timelockDuration (JS-only consumer)", async () => {
    const opts = { ...baseOpts(), timelockDuration: "1800" as never };
    try {
      await createVault(opts);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
    }
  });
});

describe("createVault — V2 allowlist defaults (Phase 2 Option A / F-11)", () => {
  it("rejects an active vault with no protocol or destination allowlist (F-11)", async () => {
    // observeOnly defaults false → ACTIVE vault. With no protocols and no
    // destinations the on-chain program would reject it as inert
    // (ActiveVaultRequiresAllowlist, 6073). The SDK now fails fast — and it
    // fires BEFORE the RPC getSlot call, so the stub rpc is never reached.
    const { protocols: _p, ...rest } = baseOpts();
    const opts = { ...rest, protocols: [] as Address[] };
    try {
      await createVault(opts);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
      );
      expect((err as Error).message).to.match(/allowlist|inert/i);
    }
  });

  it("allows an observe-only vault with an empty allowlist (inert by design)", async () => {
    // observeOnly vaults are explicitly inert — the F-11 guard is skipped, so
    // an empty allowlist must NOT raise INVALID_PARAMS. (It may still throw
    // later when the stub rpc's getSlot is called; that is not our concern.)
    const { protocols: _p, ...rest } = baseOpts();
    const opts = { ...rest, protocols: [] as Address[], observeOnly: true };
    try {
      await createVault(opts);
    } catch (err) {
      if (err instanceof SigilSdkDomainError) {
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__INVALID_PARAMS);
      }
    }
  });

  it("a non-empty protocol allowlist passes the F-11 guard", async () => {
    // baseOpts already carries protocols: [PROTOCOL] — the guard must not fire.
    try {
      await createVault(baseOpts());
    } catch (err) {
      if (err instanceof SigilSdkDomainError) {
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__INVALID_PARAMS);
      }
    }
  });
});

describe("createVault — aggregate cap guard (F3/D12)", () => {
  it("throws CAP_EXCEEDED when spendingLimitUsd > dailySpendingCapUsd", async () => {
    const opts = {
      ...baseOpts(),
      spendingLimitUsd: 1_000_000_000n as UsdBaseUnits,
      dailySpendingCapUsd: 500_000_000n as UsdBaseUnits,
    };
    try {
      await createVault(opts);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__CAP_EXCEEDED,
      );
    }
  });

  it("boundary: spendingLimitUsd == dailySpendingCapUsd does not trigger CAP_EXCEEDED", async () => {
    const opts = {
      ...baseOpts(),
      spendingLimitUsd: 500_000_000n as UsdBaseUnits,
      dailySpendingCapUsd: 500_000_000n as UsdBaseUnits,
    };
    try {
      await createVault(opts);
    } catch (err) {
      if (err instanceof SigilSdkDomainError) {
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__CAP_EXCEEDED);
      }
    }
  });

  it("spendingLimitUsd === 0n (Observer agent) does not trigger CAP_EXCEEDED or INVALID_PARAMS", async () => {
    const opts = {
      ...baseOpts(),
      spendingLimitUsd: 0n as UsdBaseUnits,
    };
    try {
      await createVault(opts);
    } catch (err) {
      if (err instanceof SigilSdkDomainError) {
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__CAP_EXCEEDED);
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__INVALID_PARAMS);
      }
    }
  });
});
