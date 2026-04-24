/**
 * Integration tests for createPostAssertions — end-to-end typed-error path.
 *
 * These complement `post-assertion-validation.test.ts` (which tests the
 * validator in isolation) by exercising the FULL mutation pipeline:
 *
 *   caller input → createPostAssertions() → validatePostAssertionEntries()
 *     → PostAssertionValidationError thrown → reaches caller intact
 *
 * **Why this file exists:** the security audit (2026-04-22) caught a
 * CRITICAL where `toDxError(err, "createPostAssertions")` was collapsing
 * the typed `validationCode` + `entryIndex` to `DX_ERROR_CODE_UNMAPPED`
 * (7999). Validator-level tests passed (they catch `PostAssertionValidationError`
 * directly) but the mutation wrapper destroyed the typed fields before
 * the caller saw them. A regression of that bug would pass the 60+
 * validator tests. These integration tests are what prevents that.
 *
 * No RPC is needed because the validation error fires BEFORE any async
 * instruction building or network I/O.
 */
import { expect } from "chai";
import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
  ReadonlyUint8Array,
} from "@solana/kit";
import type { PostAssertionEntry } from "../../src/generated/types/postAssertionEntry.js";
import { createPostAssertions } from "../../src/dashboard/mutations.js";
import {
  PostAssertionValidationError,
  DX_CODE_POST_ASSERTION_VALIDATION,
} from "../../src/dashboard/post-assertion-validation.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const VAULT = "Vault111111111111111111111111111111111111111" as Address;
const OWNER_ADDR = "Owner111111111111111111111111111111111111111" as Address;

function mockRpc(): Rpc<SolanaRpcApi> {
  // Any rpc call here would indicate the validator failed to short-circuit.
  return new Proxy(
    {},
    {
      get() {
        throw new Error(
          "Test bug: mutation called an RPC method, but the validator should have short-circuited before any network I/O.",
        );
      },
    },
  ) as unknown as Rpc<SolanaRpcApi>;
}

function mockOwner(): TransactionSigner {
  return {
    address: OWNER_ADDR,
    signTransactions: async () => {
      throw new Error(
        "Test bug: mutation tried to sign, but the validator should have short-circuited.",
      );
    },
    modifyAndSignTransactions: async () => {
      throw new Error(
        "Test bug: mutation tried to modify-and-sign, but the validator should have short-circuited.",
      );
    },
  } as unknown as TransactionSigner;
}

function bytes(length: number, fill = 0): ReadonlyUint8Array {
  return new Uint8Array(length).fill(fill) as unknown as ReadonlyUint8Array;
}

function validAbsoluteEntry(): PostAssertionEntry {
  return {
    targetAccount: "11111111111111111111111111111111" as unknown as Address,
    offset: 140,
    valueLen: 8,
    operator: 3,
    expectedValue: bytes(8, 0x11),
    assertionMode: 0,
    crossFieldOffsetB: 0,
    crossFieldMultiplierBps: 0,
    crossFieldFlags: 0,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("createPostAssertions — DxError-compatible typed errors", () => {
  const rpc = mockRpc();
  const owner = mockOwner();

  it("surfaces PostAssertionValidationError instance to the caller", async () => {
    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", []);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(PostAssertionValidationError);
  });

  it("preserves numeric DxError code (7008) on the thrown error", async () => {
    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", []);
    } catch (err) {
      caught = err;
    }
    const err = caught as PostAssertionValidationError;
    expect(err.code).to.equal(DX_CODE_POST_ASSERTION_VALIDATION);
    expect(err.code).to.equal(7008);
  });

  it("preserves validationCode string discriminator end-to-end", async () => {
    // Entry with cross-field flags enabled but assertionMode=1 — the exact
    // case the security-audit CRITICAL was checking. If the mutation still
    // wrapped in toDxError, we'd see code=7999 and no validationCode.
    const bad = validAbsoluteEntry();
    bad.assertionMode = 1;
    bad.crossFieldOffsetB = 172;
    bad.crossFieldMultiplierBps = 100_000;
    bad.crossFieldFlags = 0x01;

    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", [bad]);
    } catch (err) {
      caught = err;
    }
    const err = caught as PostAssertionValidationError;
    expect(err.validationCode).to.equal("cross_field_requires_absolute_mode");
  });

  it("preserves entryIndex on the thrown error (pinpoint failing entry)", async () => {
    // Batch of 3; index 2 is bad. Caller needs to know which.
    const good = validAbsoluteEntry();
    const bad = validAbsoluteEntry();
    bad.valueLen = 0;

    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", [
        good,
        good,
        bad,
      ]);
    } catch (err) {
      caught = err;
    }
    const err = caught as PostAssertionValidationError;
    expect(err.entryIndex).to.equal(2);
    expect(err.message).to.include("PostAssertion[2]");
  });

  it("populates recovery array with entry index for UI rendering", async () => {
    const bad = validAbsoluteEntry();
    bad.valueLen = 0;

    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", [bad]);
    } catch (err) {
      caught = err;
    }
    const err = caught as PostAssertionValidationError;
    expect(err.recovery).to.be.an("array").with.length.greaterThan(0);
    expect(err.recovery[0]).to.include("index 0");
    expect(err.recovery[0]).to.include("value_len_out_of_range");
  });

  it("rejects null entries input without an RPC round-trip", async () => {
    let caught: unknown;
    try {
      await createPostAssertions(
        rpc,
        VAULT,
        owner,
        "devnet",
        null as unknown as PostAssertionEntry[],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(PostAssertionValidationError);
    expect((caught as PostAssertionValidationError).validationCode).to.equal(
      "entries_not_an_array",
    );
  });

  it("rejects negative operator without an RPC round-trip (regression for HIGH-2)", async () => {
    const bad = validAbsoluteEntry();
    bad.operator = -1;

    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", [bad]);
    } catch (err) {
      caught = err;
    }
    expect((caught as PostAssertionValidationError).validationCode).to.equal(
      "operator_out_of_range",
    );
  });

  it("rejects non-integer crossFieldFlags without an RPC round-trip (regression for HIGH-3)", async () => {
    const bad = validAbsoluteEntry();
    bad.crossFieldFlags = 0.5;

    let caught: unknown;
    try {
      await createPostAssertions(rpc, VAULT, owner, "devnet", [bad]);
    } catch (err) {
      caught = err;
    }
    expect((caught as PostAssertionValidationError).validationCode).to.equal(
      "cross_field_flags_out_of_range",
    );
  });
});
