/**
 * CH-3 (security audit 2026-05-23, Jordan) — AL2 mainnet confirmation gate
 * embedded inside `mutations.createPostAssertions` + `closePostAssertions`.
 *
 * Direct-import callers of these mutations (i.e. code that does
 * `import { createPostAssertions } from "@usesigil/kit/dashboard"`) bypass
 * the OwnerClient class gate. The fix is to put the gate INSIDE the
 * mutation so the standalone export is also protected. Single source of
 * truth, single enforcement point.
 *
 * Behavior under test (stricter than the OwnerClient gate — no
 * `requireMainnetConfirmation` opt-out at the standalone level):
 *
 *   network    opts.confirmed   outcome
 *   ─────────  ──────────────   ───────────────
 *   devnet     (any)            PROCEED (no-op; mock RPC trips later)
 *   mainnet    true             PROCEED (mock RPC trips after gate)
 *   mainnet    undefined/false  THROW MAINNET_CONFIRMATION_REQUIRED
 *
 * Mirrors the assertion shape of
 * `tests/dashboard/al2-mainnet-gate.test.ts`: a Proxy mock RPC throws
 * on every property access, so the gate's pre-RPC throw is observable
 * by code-comparing the SDK error vs. the mock's error.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";
import {
  createPostAssertions,
  closePostAssertions,
} from "../../src/dashboard/mutations.js";
import type { PostAssertionEntry } from "../../src/generated/types/postAssertionEntry.js";
import { SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED } from "../../src/errors/codes.js";
import { SigilSdkDomainError } from "../../src/errors/sdk.js";

const VAULT = "11111111111111111111111111111112" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
const TARGET_ACCT = "So11111111111111111111111111111111111111112" as Address;

function mockSigner(addr: Address = OWNER_ADDR): TransactionSigner {
  return {
    address: addr,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
  } as unknown as TransactionSigner;
}

/** Proxy RPC that throws on every read — observes whether the gate fires
 *  BEFORE any RPC plumbing runs. Mirrors the al2-mainnet-gate test helper. */
function throwingRpc(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("MOCK_RPC_TRIPPED");
      },
    },
  );
}

/** Minimal valid PostAssertionEntry (mode 0 / Absolute) — passes
 *  `validatePostAssertionEntries` so the gate (which runs AFTER
 *  validation per the production code) is reached. */
function validEntry(): PostAssertionEntry {
  return {
    targetAccount: TARGET_ACCT,
    offset: 0,
    valueLen: 1,
    operator: 0,
    expectedValue: new Uint8Array([1]),
    assertionMode: 0,
    auxValue: new Uint8Array(8),
    auxByte: 0,
  };
}

/** Classify outcome by the thrown error's shape:
 *  - `gate-throw`        → AL2 fired (the audit fix is working)
 *  - `downstream-error`  → gate passed; mock RPC threw later
 *  - `no-throw`          → impossible with the proxy RPC (would be a bug) */
async function classify(
  run: () => Promise<unknown>,
): Promise<"gate-throw" | "downstream-error" | "no-throw"> {
  try {
    await run();
    return "no-throw";
  } catch (err) {
    if (
      err instanceof SigilSdkDomainError &&
      err.code === SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED
    ) {
      return "gate-throw";
    }
    return "downstream-error";
  }
}

describe("CH-3: AL2 gate on createPostAssertions + closePostAssertions", () => {
  it("createPostAssertions rejects mainnet without confirm", async () => {
    const outcome = await classify(() =>
      createPostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        [validEntry()],
        // opts omitted — mainnetConfirmed undefined → gate must fire
      ),
    );
    expect(outcome).to.equal("gate-throw");
  });

  it("createPostAssertions ignores AL2 on devnet", async () => {
    const outcome = await classify(() =>
      createPostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "devnet",
        [validEntry()],
        // opts omitted — devnet bypasses the gate entirely → mock RPC trips
      ),
    );
    expect(outcome).to.equal("downstream-error");
  });

  it("closePostAssertions rejects mainnet without confirm", async () => {
    const outcome = await classify(() =>
      closePostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        // opts omitted
      ),
    );
    expect(outcome).to.equal("gate-throw");
  });

  it("closePostAssertions ignores AL2 on devnet", async () => {
    const outcome = await classify(() =>
      closePostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "devnet",
        // opts omitted — devnet bypasses the gate entirely
      ),
    );
    expect(outcome).to.equal("downstream-error");
  });

  // ─── Supplementary: positive-path coverage ────────────────────────────
  // The four required tests cover the audit's stated cases. These extra
  // tests document the `mainnetConfirmed: true` happy path so any future
  // refactor that breaks the positive path is caught here too.

  it("createPostAssertions proceeds on mainnet when confirmed", async () => {
    const outcome = await classify(() =>
      createPostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        [validEntry()],
        { mainnetConfirmed: true },
      ),
    );
    expect(outcome).to.equal("downstream-error");
  });

  it("closePostAssertions proceeds on mainnet when confirmed", async () => {
    const outcome = await classify(() =>
      closePostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        { mainnetConfirmed: true },
      ),
    );
    expect(outcome).to.equal("downstream-error");
  });

  it("createPostAssertions rejects mainnet with mainnetConfirmed: false", async () => {
    // Stricter than OwnerClient gate: `false` is NOT an opt-out at the
    // mutation layer because there's no `requireMainnetConfirmation`
    // client config to read. Only explicit `true` proceeds.
    const outcome = await classify(() =>
      createPostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        [validEntry()],
        { mainnetConfirmed: false },
      ),
    );
    expect(outcome).to.equal("gate-throw");
  });

  it("gate error message embeds the method name", async () => {
    try {
      await createPostAssertions(
        throwingRpc() as any,
        VAULT,
        mockSigner(),
        "mainnet",
        [validEntry()],
      );
      expect.fail("expected gate to throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      const e = err as SigilSdkDomainError;
      expect(e.code).to.equal(SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED);
      expect(e.shortMessage).to.match(/createPostAssertions/);
      expect(e.shortMessage).to.match(/mainnetConfirmed/);
    }
  });
});
