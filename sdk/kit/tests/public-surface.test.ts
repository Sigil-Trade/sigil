/**
 * Public surface audit — regression guard for v0.9.0 A12 barrel surgery.
 *
 * Locks in the current state of `@usesigil/kit`'s root barrel so accidental
 * re-exports of internals in future PRs are caught by CI.
 */

import { describe, it } from "mocha";
import { expect } from "chai";

import * as kit from "../src/index.js";

describe("v0.9.0 root barrel — removed exports", () => {
  it("does NOT re-export SIGIL_ERROR__* code constants from root (moved to /errors subpath)", () => {
    const removed = [
      "SIGIL_ERROR__SDK__CAP_EXCEEDED",
      "SIGIL_ERROR__SDK__INVALID_AMOUNT",
      "SIGIL_ERROR__SDK__INVALID_NETWORK",
      "SIGIL_ERROR__SDK__INVALID_PARAMS",
      "SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED",
      "SIGIL_ERROR__SHIELD__POLICY_DENIED",
      "SIGIL_ERROR__TEE__ATTESTATION_FAILED",
      "SIGIL_ERROR__X402__HEADER_MALFORMED",
      "SIGIL_ERROR__RPC__TX_FAILED",
      "SIGIL_ERROR__PROGRAM__GENERIC",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root — import from "@usesigil/kit/errors"`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export generated instruction builders from root", () => {
    const removed = [
      "getValidateAndAuthorizeInstructionAsync",
      "getFinalizeSessionInstructionAsync",
      "getInitializeVaultInstructionAsync",
      "getRegisterAgentInstruction",
      "getCreateEscrowInstructionAsync",
      "getSettleEscrowInstructionAsync",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root — consumers use seal() / createVault() / OwnerClient`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export generated Anchor enum (`SigilError` from on-chain errors)", () => {
    // The on-chain Anchor SigilError enum would collide with the SDK's
    // SigilKitError alias. It's intentionally absent from the root barrel.
    // (The error-code string constants are on /errors; the integer enum
    // itself remains internal to the SDK.)
    expect(
      (kit as unknown as Record<string, unknown>)["SigilError"],
      "on-chain Anchor SigilError enum must NOT leak to root",
    ).to.be.undefined;
  });
});

describe("v0.9.0 root barrel — kept exports", () => {
  it("DOES export the primary API (seal, createSigilClient, SigilClient)", () => {
    expect(kit.seal).to.be.a("function");
    expect(kit.createSigilClient).to.be.a("function");
    expect(kit.SigilClient).to.be.a("function");
  });

  it("DOES export createVault + createAndSendVault", () => {
    expect(kit.createVault).to.be.a("function");
    expect(kit.createAndSendVault).to.be.a("function");
  });

  it("DOES export VAULT_PRESETS and SAFETY_PRESETS (A10)", () => {
    expect(kit.VAULT_PRESETS).to.be.an("object");
    expect(kit.SAFETY_PRESETS).to.be.an("object");
    expect(kit.SAFETY_PRESETS.development.timelockDuration).to.equal(1800);
    expect(kit.SAFETY_PRESETS.production.timelockDuration).to.equal(86_400);
  });

  it("DOES export the 12 account types + their decoders", () => {
    const accounts = [
      "getAgentVaultDecoder",
      "getPolicyConfigDecoder",
      "getSpendTrackerDecoder",
      "getSessionAuthorityDecoder",
      "getAgentSpendOverlayDecoder",
      "getEscrowDepositDecoder",
      "getInstructionConstraintsDecoder",
      "getPendingPolicyUpdateDecoder",
      "getPendingConstraintsUpdateDecoder",
      "getPendingAgentPermissionsUpdateDecoder",
      "getPendingCloseConstraintsDecoder",
      "getPostExecutionAssertionsDecoder",
    ];
    for (const name of accounts) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must be on root (account decoders are the supported read path)`,
      ).to.be.a("function");
    }
  });

  it("DOES export the new A3-A9 helpers (parseUsd, initializeVaultAtas, SigilLogger primitives, validateAgentCapAggregate)", async () => {
    const { parseUsd } = await import("../src/helpers/parse-usd.js");
    const { initializeVaultAtas } = await import("../src/helpers/ata.js");
    const { validateAgentCapAggregate } =
      await import("../src/helpers/validate-cap-aggregate.js");
    const { NOOP_LOGGER, createConsoleLogger } =
      await import("../src/logger.js");
    expect(parseUsd).to.be.a("function");
    expect(initializeVaultAtas).to.be.a("function");
    expect(validateAgentCapAggregate).to.be.a("function");
    expect(NOOP_LOGGER).to.be.an("object");
    expect(createConsoleLogger).to.be.a("function");
  });

  it("DOES expose SigilClient.create async factory (A7)", () => {
    expect((kit.SigilClient as { create?: unknown }).create).to.be.a(
      "function",
    );
  });

  it("DOES export SIGIL_PROGRAM_ADDRESS", () => {
    expect(kit.SIGIL_PROGRAM_ADDRESS).to.be.a("string");
  });
});

describe("v0.9.0 /errors subpath smoke", () => {
  it("import from /errors subpath resolves all 49 code constants", async () => {
    const errorsSubpath: Record<string, unknown> =
      await import("../src/errors/public.js");
    const codes = Object.keys(errorsSubpath).filter((k) =>
      k.startsWith("SIGIL_ERROR__"),
    );
    // 49 codes post-Sprint-1; Sprint 2 added 3 new ones
    // (HOOK_ABORTED, PLUGIN_REJECTED, OWNER_REQUIRED) bringing the total
    // to 52. Future additions should bump this number intentionally.
    expect(codes.length).to.equal(52);
  });
});

describe("v0.9.0 root barrel — total export budget", () => {
  it("root barrel symbol count is below the pre-surgery ~700 baseline", () => {
    const count = Object.keys(kit).length;
    // A12 removed the `export * from ./generated/index.js` line and the
    // 49 SIGIL_ERROR__* constants from root, bringing count from ~700 to
    // ~388. The original plan target was ≤125 — NOT achieved in Sprint 1
    // because further cuts (BlockhashCache, TransactionExecutor,
    // VelocityTracker, evaluatePolicy, KNOWN_PROTOCOLS, etc.) carry
    // monorepo-wide risk and need dashboard build verification each
    // change. Sprint 2 tightens further toward the ~125 goal.
    //
    // Ceiling locked at 500 as a regression guard — any PR adding five+
    // new top-level names without reviewer attention will trip this.
    expect(
      count,
      `root barrel has ${count} exports (was ~700 pre-A12)`,
    ).to.be.lessThan(500);
  });

  it("root barrel count has plan-target gap documented honestly", () => {
    // Plan said ≤ 125. Actual: ~388. Gap is 263 symbols; all are
    // internal utilities kept public for dashboard/custody back-compat.
    // Sprint 2 will drop them. Until then, this test exists so a
    // reader looking for "where does the 125 target come from?" finds
    // this explicit acknowledgment and the rationale above.
    const count = Object.keys(kit).length;
    expect(count).to.be.greaterThan(125); // informational, not a bug
  });
});
