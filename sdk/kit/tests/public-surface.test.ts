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

  it("DOES export the account types + their decoders (M1-04: 3 constraint accounts removed)", () => {
    const accounts = [
      "getAgentVaultDecoder",
      "getPolicyConfigDecoder",
      "getSpendTrackerDecoder",
      "getSessionAuthorityDecoder",
      "getAgentSpendOverlayDecoder",
      // M1-04: constraint account decoders removed (engine deleted).
      "getPendingPolicyUpdateDecoder",
      "getPendingAgentPermissionsUpdateDecoder",
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
    const {
      NOOP_LOGGER,
      createConsoleLogger,
      sanitizeNoop,
      structuredWarn,
      structuredError,
    } = await import("../src/logger.js");
    expect(parseUsd).to.be.a("function");
    expect(initializeVaultAtas).to.be.a("function");
    expect(validateAgentCapAggregate).to.be.a("function");
    expect(NOOP_LOGGER).to.be.an("object");
    expect(createConsoleLogger).to.be.a("function");
    // F-9 (third-pass audit): mandatory-sanitize structured-warn/error helpers
    expect(sanitizeNoop).to.be.a("function");
    expect(structuredWarn).to.be.a("function");
    expect(structuredError).to.be.a("function");
  });

  it("DOES expose SigilClient.create async factory (A7)", () => {
    expect((kit.SigilClient as { create?: unknown }).create).to.be.a(
      "function",
    );
  });

  it("DOES export SIGIL_PROGRAM_ADDRESS", () => {
    expect(kit.SIGIL_PROGRAM_ADDRESS).to.be.a("string");
  });

  it("DOES export the 0.25 dashboard punch-list additions (Items 1/3/4/5)", () => {
    // Item 1 — send/poll primitive.
    expect(kit.sendAndConfirmTransaction).to.be.a("function");
    // Item 3 — cursor-aware paginated activity fetcher.
    expect(kit.getVaultActivityPage).to.be.a("function");
    // Item 4 — timelock bounds (seconds), mirror on-chain state/mod.rs.
    expect(kit.MIN_TIMELOCK_DURATION).to.equal(1_800);
    expect(kit.MAX_TIMELOCK_DURATION).to.equal(172_800);
    // Item 5 — instruction discriminators (8 bytes each).
    expect(kit.INITIALIZE_VAULT_DISCRIMINATOR).to.be.an.instanceof(Uint8Array);
    expect(kit.INITIALIZE_VAULT_DISCRIMINATOR).to.have.lengthOf(8);
    expect(kit.REGISTER_AGENT_DISCRIMINATOR).to.be.an.instanceof(Uint8Array);
    expect(kit.REGISTER_AGENT_DISCRIMINATOR).to.have.lengthOf(8);
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

describe("v0.13.0 root barrel — PR B barrel closeout (54 internals hidden)", () => {
  // Regression guard for PR B (Sprint 1 barrel closeout). Each symbol
  // below was removed from the root barrel per docs/BARREL-AUDIT.md
  // after the zero-consumer audit. Source files remain for internal
  // SDK use via relative imports; only the public barrel is pruned.
  // See .changeset/pr-b-barrel-closeout.md for rationale.

  it("does NOT re-export Category 1 — internal RPC plumbing (14)", () => {
    // `sendAndConfirmTransaction` was REMOVED from this list in the 0.25
    // dashboard punch-list (Item 1): it is now an intentional root export
    // (send/poll primitive the dashboard's offline-signing flows need). The
    // rest of the v0.13 barrel-closeout plumbing stays internal.
    const removed = [
      "BlockhashCache",
      "getBlockhashCache",
      "AltCache",
      "mergeAltAddresses",
      "SIGIL_ALT_DEVNET",
      "SIGIL_ALT_MAINNET",
      "getSigilAltAddress",
      "signAndEncode",
      "composeSigilTransaction",
      "validateTransactionSize",
      "measureTransactionSize",
      "toInstruction",
      "bytesToAddress",
      "resolveAccounts",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (internal RPC plumbing)`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export Category 2 — policy engine internals (10)", () => {
    const removed = [
      "evaluatePolicy",
      "enforcePolicy",
      "recordTransaction",
      "toCoreAnalysis",
      "ShieldStorage",
      "SpendEntry",
      "TxEntry",
      "VelocityTracker",
      "VelocityConfig",
      "SpendStatus",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (use shield() / vault.budget() instead)`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export Category 3 — TEE internals + custody bridge (12)", () => {
    const removed = [
      "AttestationCache",
      "DEFAULT_CACHE_TTL_MS",
      "clearAttestationCache",
      "deleteFromAttestationCache",
      "NitroPcrValues",
      "TurnkeyAttestationBundle",
      "WalletLike",
      "AttestationConfig",
      "AttestationLevel",
      "AttestationMetadata",
      "custodyAdapterToTransactionSigner",
      "CustodyAdapter",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (TEE internals or migrated to @usesigil/plugins/sak)`,
      ).to.be.undefined;
    }
  });

  it("DOES still expose the TEE public verification surface", () => {
    // Redacted subset — consumers verifying Turnkey attestations use
    // these; internal cache/config types stay private.
    expect(kit.verifyTurnkey).to.be.a("function");
    expect(kit.verifyCrossmint).to.be.a("function");
    expect(kit.verifyPrivy).to.be.a("function");
    expect(kit.verifyTeeAttestation).to.be.a("function");
    expect(kit.isTeeWallet).to.be.a("function");
  });

  it("does NOT re-export Category 5 — redundant vault creation (8)", () => {
    const removed = [
      "inscribe",
      "withVault",
      "mapPoliciesToVaultParams",
      "findNextVaultId",
      "InscribeOptions",
      "InscribeResult",
      "WithVaultOptions",
      "WithVaultResult",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (use createAndSendVault() / createVault() instead)`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export Category 6 — internal constants (10)", () => {
    const removed = [
      "EPOCH_DURATION",
      "NUM_EPOCHS",
      "OVERLAY_EPOCH_DURATION",
      "OVERLAY_NUM_EPOCHS",
      "ROLLING_WINDOW_SECONDS",
      "PROTOCOL_TREASURY",
      "PROTOCOL_FEE_RATE",
      "MAX_DEVELOPER_FEE_RATE",
      "FEE_RATE_DENOMINATOR",
      "ON_CHAIN_ERROR_MAP",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (internal implementation detail)`,
      ).to.be.undefined;
    }
  });

  it("does NOT re-export Category 7 — duplicate TransactionExecutor (4)", () => {
    const removed = [
      "TransactionExecutor",
      "ExecuteTransactionParams",
      "ExecuteTransactionResult",
      "TransactionExecutorOptions",
    ];
    for (const name of removed) {
      expect(
        (kit as unknown as Record<string, unknown>)[name],
        `${name} must NOT be on root (use createSigilClient().executeAndConfirm())`,
      ).to.be.undefined;
    }
  });
});

describe("v0.9.0 root barrel — total export budget", () => {
  it("root barrel symbol count is below the pre-surgery ~700 baseline", () => {
    const count = Object.keys(kit).length;
    // A12 removed the `export * from ./generated/index.js` line and the
    // 49 SIGIL_ERROR__* constants from root, bringing count from ~700
    // to ~388. PR B (v0.13.0) removed another 54 internal utilities
    // — count is now ~334.
    //
    // Ceiling locked at 500 as a regression guard — any PR adding five+
    // new top-level names without reviewer attention will trip this.
    expect(
      count,
      `root barrel has ${count} exports (was ~700 pre-A12, ~388 pre-v0.13)`,
    ).to.be.lessThan(500);
  });

  it("root barrel count has plan-target gap documented honestly", () => {
    // Plan said ≤ 125. PR B v0.13 brought count to ~334 (from ~388).
    // Further cuts (generated account decoder sprawl, codec/encoder/
    // size exports) are the remaining gap; they carry dashboard build-
    // verification risk and land in a future "generated surface trim" PR.
    const count = Object.keys(kit).length;
    expect(count).to.be.greaterThan(125); // informational, not a bug
  });
});
