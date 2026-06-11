/**
 * H-9 (Phase 10 Bucket 1) — AL2 mainnet confirmation gate on OwnerClient.
 *
 * Mirrors the seal-side gate behavior matrix from
 * `tests/al2-mainnet-gate.test.ts`. The OwnerClient gate is checked
 * before any RPC plumbing, so this suite uses raw mocks (no LiteSVM) —
 * the mutations.* builders never run.
 *
 * State table under test:
 *
 *   network    requireFlag   opts.confirmed   outcome
 *   ─────────  ────────────  ──────────────   ───────────────
 *   devnet     (any)         (any)            PROCEED (no-op; mutation runs, then mock RPC throws)
 *   mainnet    true          true             PROCEED (mock RPC throws AFTER gate passes)
 *   mainnet    true          undefined        THROW MAINNET_CONFIRMATION_REQUIRED
 *   mainnet    true          false            THROW MAINNET_CONFIRMATION_REQUIRED
 *   mainnet    undefined     undefined        WARN + PROCEED (default 0.16.x)
 *   mainnet    undefined     true             PROCEED (no warn)
 *   mainnet    false         (any)            PROCEED (no warn)
 *
 * We assert by the SHAPE of the thrown error: either the gate's
 * `MAINNET_CONFIRMATION_REQUIRED` (which fires BEFORE the mock RPC) or
 * an arbitrary downstream error from the mock RPC chain (which fires
 * AFTER the gate has been satisfied). The presence of the
 * gate-specific code is the load-bearing assertion.
 */

import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";
import {
  OwnerClient,
  type OwnerClientConfig,
} from "../../src/dashboard/index.js";
import {
  SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
} from "../../src/errors/codes.js";
import { SigilSdkDomainError } from "../../src/errors/sdk.js";
import { setSigilModuleLogger, type SigilLogger } from "../../src/logger.js";

const VAULT = "11111111111111111111111111111112" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
const AGENT_ADDR = "11111111111111111111111111111115" as Address;

function mockSigner(addr: Address = OWNER_ADDR): TransactionSigner {
  return {
    address: addr,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
  } as unknown as TransactionSigner;
}

/** Mock RPC that always throws — we only want to observe the gate. */
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

function baseConfig(
  network: "devnet" | "mainnet",
  requireMainnetConfirmation?: boolean,
): OwnerClientConfig {
  return {
    rpc: throwingRpc() as any,
    vault: VAULT,
    owner: mockSigner(),
    network,
    ...(requireMainnetConfirmation === undefined
      ? {}
      : { requireMainnetConfirmation }),
  };
}

/**
 * Run a mutation and classify the outcome.
 * - `gate-throw` → the AL2 gate fired (MAINNET_CONFIRMATION_REQUIRED)
 * - `downstream-error` → the gate passed and the mock RPC tripped
 * - `no-throw` → impossible with the mock RPC (would indicate a bug)
 */
async function classify(
  runMutation: () => Promise<unknown>,
): Promise<"gate-throw" | "downstream-error" | "no-throw"> {
  try {
    await runMutation();
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

describe("AL2 — OwnerClient mainnet confirmation gate (H-9)", () => {
  // ─── Logger capture ─────────────────────────────────────────────────────
  let warnings: string[];
  let prevLogger: SigilLogger | undefined;

  beforeEach(() => {
    warnings = [];
    const captureLogger: SigilLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    };
    prevLogger = undefined;
    setSigilModuleLogger(captureLogger);
  });

  afterEach(() => {
    // Reset to default (NOOP) — the global setSigilModuleLogger has no
    // unset, so restore by setting a noop logger.
    setSigilModuleLogger({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  describe("devnet — gate is a no-op regardless of state", () => {
    it("requireFlag=true, confirmed=undefined → no gate throw", async () => {
      const client = new OwnerClient(baseConfig("devnet", true));
      const outcome = await classify(() => client.freezeVault());
      // Gate must not fire on devnet. Downstream mock RPC trips.
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });

    it("requireFlag=undefined, confirmed=undefined → no warn, no gate throw", async () => {
      const client = new OwnerClient(baseConfig("devnet"));
      const outcome = await classify(() =>
        client.queueAgentGrant(AGENT_ADDR, 2, 500_000_000n),
      );
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });
  });

  describe("mainnet + requireMainnetConfirmation: true", () => {
    it("opts.mainnetConfirmed=true → gate passes, downstream proceeds", async () => {
      const client = new OwnerClient(baseConfig("mainnet", true));
      const outcome = await classify(() =>
        client.freezeVault({ mainnetConfirmed: true }),
      );
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });

    it("opts.mainnetConfirmed=undefined → THROW MAINNET_CONFIRMATION_REQUIRED", async () => {
      const client = new OwnerClient(baseConfig("mainnet", true));
      const outcome = await classify(() => client.freezeVault());
      expect(outcome).to.equal("gate-throw");
    });

    it("opts.mainnetConfirmed=false → THROW MAINNET_CONFIRMATION_REQUIRED", async () => {
      const client = new OwnerClient(baseConfig("mainnet", true));
      const outcome = await classify(() =>
        client.reactivateVault(undefined, { mainnetConfirmed: false }),
      );
      expect(outcome).to.equal("gate-throw");
    });

    it("gate message embeds the method name", async () => {
      const client = new OwnerClient(baseConfig("mainnet", true));
      try {
        await client.setObserveOnly(true);
        expect.fail("expected gate to throw");
      } catch (err) {
        expect(err).to.be.instanceOf(SigilSdkDomainError);
        const e = err as SigilSdkDomainError;
        expect(e.code).to.equal(
          SIGIL_ERROR__SDK__MAINNET_CONFIRMATION_REQUIRED,
        );
        expect(e.shortMessage).to.match(/setObserveOnly/);
      }
    });
  });

  describe("mainnet + requireMainnetConfirmation: undefined (0.16.x default)", () => {
    it("opts.mainnetConfirmed=undefined → WARN + downstream proceeds", async () => {
      const client = new OwnerClient(baseConfig("mainnet"));
      const outcome = await classify(() => client.withdraw(VAULT, 1n));
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(1);
      expect(warnings[0]).to.match(/withdraw/);
      expect(warnings[0]).to.match(/requireMainnetConfirmation/);
    });

    it("opts.mainnetConfirmed=true → no warn, downstream proceeds", async () => {
      const client = new OwnerClient(baseConfig("mainnet"));
      const outcome = await classify(() =>
        client.queueAgentGrant(AGENT_ADDR, 1, 0n, { mainnetConfirmed: true }),
      );
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });

    it("opts.mainnetConfirmed=false → no warn, no throw (caller is explicit)", async () => {
      const client = new OwnerClient(baseConfig("mainnet"));
      const outcome = await classify(() =>
        client.pauseAgent(AGENT_ADDR, { mainnetConfirmed: false }),
      );
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });
  });

  describe("mainnet + requireMainnetConfirmation: false (explicit opt-out)", () => {
    it("opts.mainnetConfirmed=undefined → no warn, downstream proceeds", async () => {
      const client = new OwnerClient(baseConfig("mainnet", false));
      const outcome = await classify(() => client.closeVault());
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });

    it("opts.mainnetConfirmed=true → no warn, downstream proceeds", async () => {
      const client = new OwnerClient(baseConfig("mainnet", false));
      const outcome = await classify(() =>
        client.applyAgentGrant({ mainnetConfirmed: true }),
      );
      expect(outcome).to.equal("downstream-error");
      expect(warnings.length).to.equal(0);
    });
  });

  describe("Gate coverage — every documented mutation method gates", () => {
    function mainnetClient(): OwnerClient {
      return new OwnerClient(baseConfig("mainnet", true));
    }

    // One representative per cluster — full breadth confirms the gate is
    // wired uniformly. Each call MUST gate-throw because none pass
    // `mainnetConfirmed: true`.
    const calls: { name: string; run: (c: OwnerClient) => Promise<unknown> }[] =
      [
        { name: "freezeVault", run: (c) => c.freezeVault() },
        { name: "resumeVault", run: (c) => c.resumeVault() },
        { name: "reactivateVault", run: (c) => c.reactivateVault() },
        { name: "setObserveOnly", run: (c) => c.setObserveOnly(true) },
        {
          name: "queueAgentGrant",
          run: (c) => c.queueAgentGrant(AGENT_ADDR, 1, 0n),
        },
        { name: "applyAgentGrant", run: (c) => c.applyAgentGrant() },
        { name: "cancelAgentGrant", run: (c) => c.cancelAgentGrant() },
        { name: "closeVault", run: (c) => c.closeVault() },
        { name: "deposit", run: (c) => c.deposit(VAULT, 1n) },
        { name: "withdraw", run: (c) => c.withdraw(VAULT, 1n) },
        {
          name: "pauseAgent",
          run: (c) => c.pauseAgent(AGENT_ADDR),
        },
        {
          name: "unpauseAgent",
          run: (c) => c.unpauseAgent(AGENT_ADDR),
        },
        {
          name: "revokeAgent",
          run: (c) => c.revokeAgent(AGENT_ADDR),
        },
        {
          name: "applyAgentPermissions",
          run: (c) => c.applyAgentPermissions(AGENT_ADDR),
        },
        {
          name: "cancelAgentPermissions",
          run: (c) => c.cancelAgentPermissions(AGENT_ADDR),
        },
        {
          name: "applyPendingPolicy",
          run: (c) => c.applyPendingPolicy(),
        },
        {
          name: "cancelPendingPolicy",
          run: (c) => c.cancelPendingPolicy(),
        },
        // M1-04: constraint mutation gate-entries removed (engine deleted).
        {
          name: "initiateOwnershipTransfer",
          run: (c) => c.initiateOwnershipTransfer(AGENT_ADDR, false),
        },
        {
          name: "acceptOwnershipTransfer",
          run: (c) => c.acceptOwnershipTransfer(),
        },
        {
          name: "acceptOwnershipTransferMultisig",
          run: (c) => c.acceptOwnershipTransferMultisig(AGENT_ADDR),
        },
        {
          name: "cancelOwnershipTransfer",
          run: (c) => c.cancelOwnershipTransfer(),
        },
      ];

    for (const { name, run } of calls) {
      it(`OwnerClient.${name} → throws MAINNET_CONFIRMATION_REQUIRED when gateEnabled and unconfirmed`, async () => {
        const outcome = await classify(() => run(mainnetClient()));
        expect(outcome).to.equal("gate-throw");
      });
    }
  });

  describe("OwnerClientConfig — requireMainnetConfirmation field shape", () => {
    it("constructor accepts requireMainnetConfirmation: true without throwing", () => {
      expect(
        () =>
          new OwnerClient({
            rpc: throwingRpc() as any,
            vault: VAULT,
            owner: mockSigner(),
            network: "mainnet",
            requireMainnetConfirmation: true,
          }),
      ).to.not.throw();
    });

    it("constructor accepts requireMainnetConfirmation: false", () => {
      expect(
        () =>
          new OwnerClient({
            rpc: throwingRpc() as any,
            vault: VAULT,
            owner: mockSigner(),
            network: "mainnet",
            requireMainnetConfirmation: false,
          }),
      ).to.not.throw();
    });

    it("constructor leaves rpc/vault/owner/network checks intact", () => {
      expect(
        () =>
          new OwnerClient({
            rpc: undefined as any,
            vault: VAULT,
            owner: mockSigner(),
            network: "mainnet",
            requireMainnetConfirmation: true,
          }),
      ).to.throw(SigilSdkDomainError);
      try {
        new OwnerClient({
          rpc: undefined as any,
          vault: VAULT,
          owner: mockSigner(),
          network: "mainnet",
          requireMainnetConfirmation: true,
        });
      } catch (err) {
        expect((err as SigilSdkDomainError).code).to.equal(
          SIGIL_ERROR__SDK__INVALID_CONFIG,
        );
      }
    });
  });
});
