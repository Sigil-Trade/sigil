/**
 * AL2 mainnet confirmation gate — full executeAndConfirm() matrix.
 *
 * Replaces the tautological 0.16.0-era `tests/al2-mainnet-gate.test.ts`,
 * which encoded the matrix as a string table and verified the strings
 * matched themselves. This file drives the matrix through the real
 * `createSigilClient().executeAndConfirm()` code path so a defect in
 * the gate at `seal.ts:1362-1402` actually fails the test.
 *
 * Phase 9 Batch K source of truth: `seal.ts:1350-1402`. Matrix per the
 * inline JSDoc on `SigilClientConfig.requireMainnetConfirmation`:
 *
 *   network    requireMainnetConfirmation   opts.mainnetConfirmed   outcome
 *   ─────────  ──────────────────────────   ─────────────────────   ───────────────
 *   devnet     (any)                        (any)                   PROCEED (gate ignored)
 *   mainnet    true                         true                    PROCEED
 *   mainnet    true                         undefined / false       THROW 7020
 *   mainnet    undefined (0.16 default)     undefined               WARN + PROCEED
 *   mainnet    undefined                    true / false            PROCEED (no warn)
 *   mainnet    false (explicit opt-out)     (any)                   PROCEED (no warn)
 *
 * Strategy: install an `onBeforeBuild` hook that returns
 * `{ skipSeal: true, reason: "AL2_GATE_PASS_SENTINEL" }`. The hook
 * fires INSIDE `seal()`, which runs AFTER the AL2 gate inside
 * `executeAndConfirm()`. Three observable outcomes per call:
 *
 *   - Caller throws SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED →
 *     gate fired. Distinguishable by `err.code`.
 *   - Caller throws SIGIL_ERROR__SDK__HOOK_ABORTED with the sentinel
 *     reason → gate did NOT fire (we got past it; the hook short-
 *     circuited the rest of seal()).
 *   - The capture logger received the deprecation warning → gate ran
 *     the "warn + proceed" branch.
 *
 * Mutation guidance: deleting the `requireMainnetConfirmation` check
 * line at seal.ts:1366-1382 will make every "THROW 7020" row instead
 * hit the sentinel HOOK_ABORTED path. Every such row in this matrix
 * is asserted as { gateFired: true }, so the suite reports a definitive
 * PASS/FAIL per cell when the mutation lands.
 */

import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";

import { createSigilClient, type SigilClientConfig } from "../../src/seal.js";
import {
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED,
  SIGIL_ERROR__SDK__HOOK_ABORTED,
} from "../../src/errors/codes.js";
import {
  setSigilModuleLogger,
  NOOP_LOGGER,
  type SigilLogger,
} from "../../src/logger.js";
import {
  createMockAgent,
  createMockVaultState,
} from "../../src/testing/index.js";
import { USDC_MINT_DEVNET } from "../../src/types.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
// `seal()` filters out the SYSTEM_PROGRAM and COMPUTE_BUDGET_PROGRAM
// instructions before reaching the digest / hook stages. We point a
// single Jupiter instruction so the bundle is non-empty post-filter.
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

function jupiterIx(): Instruction {
  return {
    programAddress: JUPITER,
    accounts: [{ address: VAULT, role: AccountRole.WRITABLE }],
    data: new Uint8Array([1, 2, 3]),
  };
}

/**
 * Stub RPC — only the surface `seal()` touches when `cachedState` and
 * `addressLookupTables` are pre-supplied. The constructor also reads
 * `getSlot()` indirectly via genesis assertion *if* called through
 * `createSigilClientAsync`; we go through the sync factory so the
 * stub stays minimal.
 */
function stubRpc(): unknown {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
          lastValidBlockHeight: 200n,
        },
      }),
    }),
  };
}

/**
 * Capture logger — `setSigilModuleLogger` is process-global. The
 * tests/global-setup.ts root-hook restores NOOP_LOGGER after each test
 * so a forgotten cleanup never bleeds into the next file. Our local
 * `afterEach` is belt-and-suspenders.
 */
interface WarnRecord {
  message: string;
  context?: Record<string, unknown>;
}

function captureLogger(into: WarnRecord[]): SigilLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      into.push({ message, context });
    },
    error: () => undefined,
  };
}

function makeClient(opts: {
  network: "devnet" | "mainnet";
  requireMainnetConfirmation?: boolean;
}) {
  const config: SigilClientConfig = {
    rpc: stubRpc() as never,
    vault: VAULT,
    agent: createMockAgent(AGENT_ADDR),
    network: opts.network,
    ...(opts.requireMainnetConfirmation !== undefined
      ? { requireMainnetConfirmation: opts.requireMainnetConfirmation }
      : {}),
  };
  return createSigilClient(config);
}

/**
 * Run executeAndConfirm with the SENTINEL hook. The hook only fires
 * AFTER the AL2 gate, so the outcome is one of three:
 *   - Threw MAINNET_CONFIRMATION_REQUIRED → gate fired
 *   - Threw HOOK_ABORTED → gate passed (sentinel reached)
 *   - Threw something else → assertion bug
 */
const HOOK_ABORT_SENTINEL = "AL2_GATE_PASS_SENTINEL";

async function runGate(opts: {
  network: "devnet" | "mainnet";
  requireMainnetConfirmation?: boolean;
  mainnetConfirmed?: boolean;
  warnSink: WarnRecord[];
}): Promise<{ outcome: "GATE_THREW" | "GATE_PASSED"; warns: WarnRecord[] }> {
  setSigilModuleLogger(captureLogger(opts.warnSink));
  const client = makeClient({
    network: opts.network,
    requireMainnetConfirmation: opts.requireMainnetConfirmation,
  });

  // Choose the right token mint for the network. USDC_MINT_DEVNET is
  // a real stablecoin on devnet (matches isStablecoinMint), so seal()
  // won't try to fetch a balance via the RPC. For the mainnet client,
  // we use the same pubkey only because the gate runs BEFORE seal()
  // and the hook short-circuits seal() before it can validate the
  // mint against the mainnet stablecoin list.
  const tokenMint = USDC_MINT_DEVNET;

  try {
    await client.executeAndConfirm([jupiterIx()], {
      tokenMint,
      amount: 0n, // non-spending — skips fee-ATA RPC fetches
      cachedState: createMockVaultState({
        vault: VAULT,
        agent: AGENT_ADDR,
        owner: OWNER_ADDR,
      }),
      addressLookupTables: {},
      ...(opts.mainnetConfirmed !== undefined
        ? { mainnetConfirmed: opts.mainnetConfirmed }
        : {}),
      hooks: {
        onBeforeBuild: () => ({
          skipSeal: true,
          reason: HOOK_ABORT_SENTINEL,
        }),
      },
    });
    throw new Error(
      "runGate: executeAndConfirm returned without throwing — neither gate nor sentinel fired",
    );
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED) {
      return { outcome: "GATE_THREW", warns: opts.warnSink };
    }
    if (code === SIGIL_ERROR__SDK__HOOK_ABORTED) {
      // The hook aborted AFTER the gate passed. Confirm the abort
      // carried our sentinel so a future signature change doesn't
      // give us a false "passed" reading.
      const message = (err as Error).message ?? "";
      if (!message.includes(HOOK_ABORT_SENTINEL)) {
        throw new Error(
          `runGate: HOOK_ABORTED fired but sentinel missing from message: ${message}`,
        );
      }
      return { outcome: "GATE_PASSED", warns: opts.warnSink };
    }
    throw err;
  }
}

// ─── Surface tests (preserved from the prior tautological file) ────────────

describe("AL2 — error code surface", () => {
  it("SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED is exported and string-equal to its literal", () => {
    expect(SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED).to.equal(
      "SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED",
    );
  });

  it("SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED is exported (reserved companion)", () => {
    expect(SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED).to.equal(
      "SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED",
    );
  });

  it("the two codes are distinct discriminants", () => {
    expect(SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED).to.not.equal(
      SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REJECTED,
    );
  });
});

// ─── 12-cell matrix exercised through executeAndConfirm ────────────────────

interface MatrixRow {
  network: "devnet" | "mainnet";
  requireMainnetConfirmation: boolean | undefined;
  mainnetConfirmed: boolean | undefined;
  expectGateThrows: boolean;
  expectWarn: boolean;
  description: string;
}

const MATRIX: readonly MatrixRow[] = [
  // ── DEVNET — gate must never fire regardless of inputs ─────────────────
  {
    network: "devnet",
    requireMainnetConfirmation: undefined,
    mainnetConfirmed: undefined,
    expectGateThrows: false,
    expectWarn: false,
    description: "devnet + reqMC=undef + callMC=undef → proceed silently",
  },
  {
    network: "devnet",
    requireMainnetConfirmation: true,
    mainnetConfirmed: undefined,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "devnet + reqMC=true + callMC=undef → proceed silently (devnet ignores gate)",
  },
  {
    network: "devnet",
    requireMainnetConfirmation: false,
    mainnetConfirmed: true,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "devnet + reqMC=false + callMC=true → proceed silently (devnet ignores gate)",
  },
  // ── MAINNET + gate off (0.16.x default) ────────────────────────────────
  {
    network: "mainnet",
    requireMainnetConfirmation: undefined,
    mainnetConfirmed: undefined,
    expectGateThrows: false,
    expectWarn: true,
    description:
      "mainnet + reqMC=undef + callMC=undef → warn + proceed (0.16.x default telegraphs v1.0 flip)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: undefined,
    mainnetConfirmed: true,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=undef + callMC=true → proceed silently (caller already adopted v1.0 contract)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: undefined,
    mainnetConfirmed: false,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=undef + callMC=false → proceed silently (explicit per-call set, no warn)",
  },
  // ── MAINNET + gate explicitly on (v1.0 adopters) ───────────────────────
  {
    network: "mainnet",
    requireMainnetConfirmation: true,
    mainnetConfirmed: undefined,
    expectGateThrows: true,
    expectWarn: false,
    description:
      "mainnet + reqMC=true + callMC=undef → THROW 7020 (gate enforced, no per-call confirmation)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: true,
    mainnetConfirmed: true,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=true + callMC=true → proceed silently (gate enforced, caller confirmed)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: true,
    mainnetConfirmed: false,
    expectGateThrows: true,
    expectWarn: false,
    description:
      "mainnet + reqMC=true + callMC=false → THROW 7020 (explicit false is NOT confirmation)",
  },
  // ── MAINNET + gate explicitly off (back-compat opt-out) ────────────────
  {
    network: "mainnet",
    requireMainnetConfirmation: false,
    mainnetConfirmed: undefined,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=false + callMC=undef → proceed silently (explicit opt-out silences warn)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: false,
    mainnetConfirmed: true,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=false + callMC=true → proceed silently (opt-out + still passing the per-call flag)",
  },
  {
    network: "mainnet",
    requireMainnetConfirmation: false,
    mainnetConfirmed: false,
    expectGateThrows: false,
    expectWarn: false,
    description:
      "mainnet + reqMC=false + callMC=false → proceed silently (opt-out wins over per-call false)",
  },
];

describe("AL2 — executeAndConfirm gate matrix (12 cells)", () => {
  afterEach(() => {
    // Belt-and-suspenders; tests/global-setup.ts also resets.
    setSigilModuleLogger(NOOP_LOGGER);
  });

  for (const row of MATRIX) {
    it(row.description, async () => {
      const warns: WarnRecord[] = [];
      const result = await runGate({
        network: row.network,
        requireMainnetConfirmation: row.requireMainnetConfirmation,
        mainnetConfirmed: row.mainnetConfirmed,
        warnSink: warns,
      });

      if (row.expectGateThrows) {
        expect(result.outcome).to.equal(
          "GATE_THREW",
          `Row '${row.description}' expected gate to throw but got outcome=${result.outcome}`,
        );
      } else {
        expect(result.outcome).to.equal(
          "GATE_PASSED",
          `Row '${row.description}' expected gate to PASS to the sentinel hook but got outcome=${result.outcome}`,
        );
      }

      // Filter to the deprecation warning specifically. The SDK may
      // emit other warnings in other code paths; we lock the assertion
      // to the AL2 telegraph message so unrelated warnings don't
      // produce false positives.
      const al2Warns = warns.filter((w) =>
        w.message.includes("requireMainnetConfirmation"),
      );

      if (row.expectWarn) {
        expect(al2Warns.length).to.be.greaterThan(
          0,
          `Row '${row.description}' expected the 0.16.x deprecation warn but the logger received none. Warns: ${JSON.stringify(warns)}`,
        );
      } else {
        expect(al2Warns.length).to.equal(
          0,
          `Row '${row.description}' did not expect the deprecation warn but received: ${JSON.stringify(al2Warns)}`,
        );
      }
    });
  }

  // ── Gate-error shape lock (Phase 9 ISC-141) ────────────────────────────
  //
  // The MAINNET_CONFIRMATION_REQUIRED error carries vault + network in its
  // context payload — wallet adapters and dashboard error renderers rely
  // on those fields to surface a precise migration nudge.
  it("gate error carries vault + network in context (ISC-141)", async () => {
    const warns: WarnRecord[] = [];
    setSigilModuleLogger(captureLogger(warns));
    const client = makeClient({
      network: "mainnet",
      requireMainnetConfirmation: true,
    });
    try {
      await client.executeAndConfirm([jupiterIx()], {
        tokenMint: USDC_MINT_DEVNET,
        amount: 0n,
        cachedState: createMockVaultState({
          vault: VAULT,
          agent: AGENT_ADDR,
          owner: OWNER_ADDR,
        }),
        addressLookupTables: {},
        // mainnetConfirmed intentionally absent
        // Sentinel hook so that if a future commit deletes the gate
        // throw, the test surfaces a HOOK_ABORTED instead of a noisy
        // RPC plumbing error and still flips PASS → FAIL on the code
        // assertion below.
        hooks: {
          onBeforeBuild: () => ({
            skipSeal: true,
            reason: HOOK_ABORT_SENTINEL,
          }),
        },
      });
      expect.fail("expected gate to throw");
    } catch (err: unknown) {
      const e = err as {
        code?: string;
        context?: Record<string, unknown>;
        message?: string;
      };
      expect(e.code).to.equal(SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED);
      expect(e.context).to.exist;
      expect(e.context!.vault).to.equal(VAULT);
      expect(e.context!.network).to.equal("mainnet");
      // The migration docs URL is part of the user-facing remediation
      // copy. Locking the message here would be brittle, but the docs
      // path is load-bearing — make sure it survives.
      expect(e.message).to.include("MIGRATION.md");
    }
  });
});
