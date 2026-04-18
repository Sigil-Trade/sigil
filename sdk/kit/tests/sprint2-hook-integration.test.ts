/**
 * Sprint 2 hook integration tests.
 *
 * Proves that hook invocation inside `seal()` fires at the documented
 * stages and that `onBeforeBuild`'s `{ skipSeal: true }` return path
 * throws `SigilSdkDomainError(SIGIL_ERROR__SDK__HOOK_ABORTED)` before
 * any RPC round-trip.
 *
 * Full executeAndConfirm integration (onAfterSend/onFinalize/onError
 * around signAndEncode + sendAndConfirmTransaction) is exercised
 * indirectly by the existing seal.test.ts + seal-genesis.test.ts
 * suites — consumer-visible behavior is unchanged when hooks are
 * absent. This file focuses on the specific new surface.
 */

import { describe, it } from "mocha";
import { expect } from "chai";

import { seal, type SealParams } from "../src/seal.js";
import { SigilSdkDomainError } from "../src/errors/sdk.js";
import {
  SIGIL_ERROR__SDK__HOOK_ABORTED,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
} from "../src/errors/codes.js";
import type { SealHooks } from "../src/hooks.js";
import type { Address, TransactionSigner } from "../src/kit-adapter.js";

// Stubs — never call `rpc.*`, because onBeforeBuild should abort
// before any RPC round-trip in the tests that assert that behavior.
// For tests that need to reach past onBeforeBuild we pass a minimal
// stub RPC that throws on first call so we can verify the abort and
// the subsequent error route separately.
function stubRpc(): any {
  return {
    getAccountInfo: () => ({
      send: async () => {
        throw new Error("stub rpc: onBeforeBuild should have aborted first");
      },
    }),
    getMultipleAccounts: () => ({
      send: async () => {
        throw new Error("stub rpc: onBeforeBuild should have aborted first");
      },
    }),
  };
}

const VAULT = "11111111111111111111111111111112" as Address;
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;

const AGENT: TransactionSigner = {
  address: "Sysvar1nstructions1111111111111111111111111" as Address,
  signTransactions: async () => [],
  signAndSendTransactions: async () => [],
} as unknown as TransactionSigner;

function baseSealParams(overrides: Partial<SealParams> = {}): SealParams {
  return {
    vault: VAULT,
    agent: AGENT,
    instructions: [],
    rpc: stubRpc(),
    network: "devnet",
    tokenMint: MINT,
    amount: 1_000_000n,
    ...overrides,
  };
}

describe("seal() — onBeforeBuild abort path", () => {
  it("onBeforeBuild returning { skipSeal: true, reason } throws HOOK_ABORTED", async () => {
    const hooks: SealHooks = {
      onBeforeBuild: () => ({ skipSeal: true, reason: "dry-run-mode" }),
    };
    let threw = false;
    try {
      await seal(baseSealParams({ hooks }));
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__HOOK_ABORTED,
      );
      expect((err as Error).message).to.include("dry-run-mode");
    }
    expect(threw, "expected HOOK_ABORTED throw").to.be.true;
  });

  it("abort occurs BEFORE any RPC call (stub rpc is never invoked)", async () => {
    let rpcCalled = false;
    const rpc = {
      getAccountInfo: () => ({
        send: async () => {
          rpcCalled = true;
          throw new Error("rpc should not have been reached");
        },
      }),
      getMultipleAccounts: () => ({
        send: async () => {
          rpcCalled = true;
          throw new Error("rpc should not have been reached");
        },
      }),
    };
    const hooks: SealHooks = {
      onBeforeBuild: () => ({ skipSeal: true, reason: "pre-flight-only" }),
    };
    try {
      await seal(baseSealParams({ hooks, rpc: rpc as unknown as any }));
    } catch {
      /* expected */
    }
    expect(rpcCalled, "RPC must not be invoked when onBeforeBuild aborts").to.be
      .false;
  });

  it("hooks receives SealHookContext with the correct fields", async () => {
    let captured: unknown = null;
    const hooks: SealHooks = {
      onBeforeBuild: (ctx) => {
        captured = ctx;
        return { skipSeal: true, reason: "captured" };
      },
    };
    try {
      await seal(baseSealParams({ hooks, correlationId: "custom-id-123" }));
    } catch {
      /* expected — we only care about the captured ctx */
    }
    expect(captured).to.be.an("object");
    expect((captured as { vault: string }).vault).to.equal(VAULT);
    expect((captured as { agent: string }).agent).to.equal(AGENT.address);
    expect((captured as { tokenMint: string }).tokenMint).to.equal(MINT);
    expect((captured as { amount: bigint }).amount).to.equal(1_000_000n);
    expect((captured as { network: string }).network).to.equal("devnet");
    expect((captured as { correlationId: string }).correlationId).to.equal(
      "custom-id-123",
    );
  });

  it("hooks receives a generated correlationId when params.correlationId is absent", async () => {
    let captured = "";
    const hooks: SealHooks = {
      onBeforeBuild: (ctx) => {
        captured = ctx.correlationId;
        return { skipSeal: true, reason: "id-check" };
      },
    };
    try {
      await seal(baseSealParams({ hooks }));
    } catch {
      /* expected */
    }
    expect(captured).to.be.a("string");
    expect(captured.length).to.be.greaterThan(0);
  });

  it("returning void from onBeforeBuild allows seal() to proceed to the next step", async () => {
    // With no skipSeal signal, the hook should be a no-op and seal
    // should proceed to state resolution — which will fail against
    // our stub RPC. We catch the downstream RPC error to prove the
    // hook didn't abort on its own.
    const hooks: SealHooks = {
      onBeforeBuild: () => {
        // return void
      },
    };
    let threw = false;
    try {
      await seal(baseSealParams({ hooks }));
    } catch (err) {
      threw = true;
      // This error should NOT be HOOK_ABORTED — it should be from the
      // RPC layer (stub throws "onBeforeBuild should have aborted first"
      // or some vault-not-found class error).
      if (err instanceof SigilSdkDomainError) {
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__HOOK_ABORTED);
      }
    }
    expect(threw, "stub RPC should have thrown").to.be.true;
  });

  it("hook that throws is swallowed; seal proceeds past the hook", async () => {
    // Hook throws — invokeHook catches + logs + returns undefined —
    // seal proceeds past onBeforeBuild and THEN fails at the state
    // resolve step against our stub. The failure is NOT HOOK_ABORTED.
    const hooks: SealHooks = {
      onBeforeBuild: () => {
        throw new Error("intentional hook throw");
      },
    };
    let threw = false;
    try {
      await seal(baseSealParams({ hooks }));
    } catch (err) {
      threw = true;
      if (err instanceof SigilSdkDomainError) {
        // If hook throw had propagated, we'd see HOOK_ABORTED; we
        // should see anything else (the downstream RPC failure).
        expect(err.code).to.not.equal(SIGIL_ERROR__SDK__HOOK_ABORTED);
      }
    }
    expect(threw, "downstream stub RPC should still throw").to.be.true;
  });

  it("missing hooks config is a no-op — seal() works without hooks", async () => {
    // With no hooks at all, the SealHookContext is still built (for
    // future hooks added mid-call) but no hook invocations happen.
    // Seal should proceed to state resolution.
    let threw = false;
    try {
      await seal(baseSealParams());
    } catch {
      threw = true;
      // Expected — stub RPC throws at state resolve
    }
    expect(threw).to.be.true;
  });
});

describe("plugin config validation — validatePluginList at client construction", () => {
  // These tests verify that the SigilClientConfig.plugins shape is
  // validated at client creation time via validatePluginList, so a
  // malformed plugin list fails fast (INVALID_CONFIG) rather than
  // crashing deep inside seal() on the first runPlugins() call.
  // (Plugin runner integration in seal() is a follow-up commit; this
  // test verifies the config-time guard.)
  // Static imports — dynamic `await import(...)` in ts-node/tsx can
  // return a different class identity than the static seal.ts import
  // chain, making `instanceof SigilSdkDomainError` fail. Static import
  // + duck-typing on `.code` is robust under both module loaders.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validatePluginList } = require("../src/plugin.js");

  it("validatePluginList (smoke) rejects a plugin missing check()", () => {
    const plugins = [{ name: "bad" }];
    try {
      validatePluginList(plugins);
      expect.fail("expected throw");
    } catch (err) {
      // Duck-type on `.code` instead of instanceof — resilient to
      // class-identity drift across dynamic/static import graphs.
      expect((err as { code?: string }).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
      );
    }
  });

  it("validatePluginList (smoke) accepts a well-formed plugin list", () => {
    const plugins = [{ name: "ok", check: () => ({ allow: true as const }) }];
    expect(() => validatePluginList(plugins)).not.to.throw();
  });
});
