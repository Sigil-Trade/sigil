/**
 * Sprint 2 foundation smoke tests.
 *
 * Covers the new Sigil facade + SigilVault + SealHooks + SigilPolicyPlugin
 * contracts end-to-end at the contract level (not yet the seal-integration
 * layer, which lands in a subsequent commit). Verifies:
 *   - Sigil namespace is frozen + exposes the expected members.
 *   - Hooks compose correctly (outer runs before inner, skipSeal short-circuits).
 *   - invokeHook swallows hook throws and routes to module logger.
 *   - runPlugins short-circuits on first rejection; throws map to SDK_DOMAIN.
 *   - validatePluginList rejects malformed inputs (missing name, duplicate).
 *   - SigilVault class exists, constructor is private, factory works.
 */

import { describe, it } from "mocha";
import { expect } from "chai";

import { Sigil } from "../src/sigil.js";
import { SigilVault } from "../src/vault-handle.js";
import {
  composeHooks,
  invokeHook,
  newCorrelationId,
  type SealHookContext,
  type SealHooks,
} from "../src/hooks.js";
import {
  runPlugins,
  validatePluginList,
  type PluginContext,
  type SigilPolicyPlugin,
} from "../src/plugin.js";
import { SigilSdkDomainError } from "../src/errors/sdk.js";
import {
  SIGIL_ERROR__SDK__PLUGIN_REJECTED,
  SIGIL_ERROR__SDK__INVALID_CONFIG,
} from "../src/errors/codes.js";
import {
  setSigilModuleLogger,
  NOOP_LOGGER,
  type SigilLogger,
} from "../src/logger.js";
import type { Address } from "../src/kit-adapter.js";

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT = "Sysvar1nstructions1111111111111111111111111" as Address;
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;

function makeHookCtx(): SealHookContext {
  return {
    vault: VAULT,
    agent: AGENT,
    tokenMint: MINT,
    amount: 1_000_000n,
    network: "devnet",
    correlationId: newCorrelationId(),
  };
}

function makePluginCtx(): PluginContext {
  return {
    vault: VAULT,
    agent: AGENT,
    tokenMint: MINT,
    amount: 1_000_000n,
    network: "devnet",
    instructions: [],
    correlationId: newCorrelationId(),
  };
}

// ─── Sigil namespace ────────────────────────────────────────────────────────

describe("Sigil namespace", () => {
  it("exposes the four factory members", () => {
    expect(Sigil).to.have.property("quickstart");
    expect(Sigil).to.have.property("fromVault");
    expect(Sigil).to.have.property("discoverVaults");
    expect(Sigil).to.have.property("presets");
  });

  it("is frozen — Object.isFrozen(Sigil) returns true", () => {
    // TypeScript's `as const` + Object.freeze both apply; consumers
    // cannot replace methods or properties at runtime. We assert via
    // Object.isFrozen rather than reassignment-throws because tsx/mocha
    // in some configurations runs with soft-strict mode that silently
    // fails the assignment rather than throwing.
    expect(Object.isFrozen(Sigil)).to.be.true;
    expect(Object.isFrozen(Sigil.presets)).to.be.true;
  });

  it("presets exposes SAFETY_PRESETS, VAULT_PRESETS, and helpers", () => {
    expect(Sigil.presets).to.have.property("safety");
    expect(Sigil.presets).to.have.property("vault");
    expect(Sigil.presets).to.have.property("applySafetyPreset");
    expect(Sigil.presets).to.have.property("requireResolvedSafetyPreset");
    expect(Sigil.presets).to.have.property("presetToCreateVaultFields");
  });

  it("presets.safety.development has the documented shape", () => {
    expect(Sigil.presets.safety.development.timelockDuration).to.equal(1800);
    expect(Sigil.presets.safety.development.spendingLimitUsd).to.equal(
      100_000_000n,
    );
  });

  it("presets.safety.production has null caps (caller must supply)", () => {
    expect(Sigil.presets.safety.production.spendingLimitUsd).to.be.null;
    expect(Sigil.presets.safety.production.dailySpendingCapUsd).to.be.null;
  });
});

// ─── SealHooks: composeHooks ────────────────────────────────────────────────

describe("composeHooks", () => {
  it("returns undefined when neither hook is provided", () => {
    expect(composeHooks(undefined, undefined)).to.be.undefined;
  });

  it("returns the inner hook when outer is undefined", () => {
    const inner: SealHooks = { onBeforeBuild: () => {} };
    expect(composeHooks(undefined, inner)).to.equal(inner);
  });

  it("returns the outer hook when inner is undefined", () => {
    const outer: SealHooks = { onBeforeBuild: () => {} };
    expect(composeHooks(outer, undefined)).to.equal(outer);
  });

  it("outer.onBeforeBuild runs before inner.onBeforeBuild", async () => {
    const order: string[] = [];
    const outer: SealHooks = {
      onBeforeBuild: () => {
        order.push("outer");
      },
    };
    const inner: SealHooks = {
      onBeforeBuild: () => {
        order.push("inner");
      },
    };
    const composed = composeHooks(outer, inner);
    await composed?.onBeforeBuild?.(makeHookCtx(), {});
    expect(order).to.deep.equal(["outer", "inner"]);
  });

  it("outer skipSeal short-circuits before inner runs", async () => {
    const order: string[] = [];
    const outer: SealHooks = {
      onBeforeBuild: () => {
        order.push("outer");
        return { skipSeal: true, reason: "outer-said-no" };
      },
    };
    const inner: SealHooks = {
      onBeforeBuild: () => {
        order.push("inner");
      },
    };
    const composed = composeHooks(outer, inner);
    const result = await composed?.onBeforeBuild?.(makeHookCtx(), {});
    expect(order).to.deep.equal(["outer"]);
    expect(result).to.deep.equal({ skipSeal: true, reason: "outer-said-no" });
  });
});

// ─── SealHooks: invokeHook ──────────────────────────────────────────────────

describe("invokeHook", () => {
  it("returns undefined when hooks is undefined", async () => {
    const result = await invokeHook(undefined, "onBeforeBuild");
    expect(result).to.be.undefined;
  });

  it("returns undefined when the named hook is absent", async () => {
    const result = await invokeHook({}, "onBeforeBuild");
    expect(result).to.be.undefined;
  });

  it("returns whatever the hook returned on success", async () => {
    const hooks: SealHooks = {
      onBeforeBuild: () => ({ skipSeal: true, reason: "test" }),
    };
    const result = await invokeHook(hooks, "onBeforeBuild", makeHookCtx(), {});
    expect(result).to.deep.equal({ skipSeal: true, reason: "test" });
  });

  it("swallows thrown errors and routes to module logger", async () => {
    const warnings: string[] = [];
    const capture: SigilLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
    };
    setSigilModuleLogger(capture);
    try {
      const hooks: SealHooks = {
        onBeforeBuild: () => {
          throw new Error("boom");
        },
      };
      const result = await invokeHook(
        hooks,
        "onBeforeBuild",
        makeHookCtx(),
        {},
      );
      expect(result).to.be.undefined;
      expect(
        warnings.some((w) => w.includes("onBeforeBuild threw")),
        "expected hook-threw warning",
      ).to.be.true;
    } finally {
      setSigilModuleLogger(NOOP_LOGGER);
    }
  });
});

// ─── newCorrelationId ───────────────────────────────────────────────────────

describe("newCorrelationId", () => {
  it("returns a non-empty string", () => {
    const id = newCorrelationId();
    expect(id).to.be.a("string");
    expect(id.length).to.be.greaterThan(0);
  });

  it("returns unique values across invocations", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).to.not.equal(b);
  });
});

// ─── SigilPolicyPlugin: runPlugins ──────────────────────────────────────────

describe("runPlugins", () => {
  it("no-ops when plugin list is undefined or empty", async () => {
    await runPlugins(undefined, makePluginCtx());
    await runPlugins([], makePluginCtx());
    // Reaching this line is the assertion — neither threw.
  });

  it("runs every plugin in registration order when all allow", async () => {
    const order: string[] = [];
    const plugins: SigilPolicyPlugin[] = [
      {
        name: "first",
        check: () => {
          order.push("first");
          return { allow: true };
        },
      },
      {
        name: "second",
        check: () => {
          order.push("second");
          return { allow: true };
        },
      },
    ];
    await runPlugins(plugins, makePluginCtx());
    expect(order).to.deep.equal(["first", "second"]);
  });

  it("first rejecting plugin short-circuits the chain", async () => {
    const order: string[] = [];
    const plugins: SigilPolicyPlugin[] = [
      {
        name: "blocker",
        check: () => {
          order.push("blocker");
          return { allow: false, reason: "nope" };
        },
      },
      {
        name: "downstream",
        check: () => {
          order.push("downstream");
          return { allow: true };
        },
      },
    ];
    let threw = false;
    try {
      await runPlugins(plugins, makePluginCtx());
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__PLUGIN_REJECTED,
      );
      expect((err as Error).message).to.include("nope");
    }
    expect(threw, "expected PLUGIN_REJECTED throw").to.be.true;
    expect(order, "downstream should not have run").to.deep.equal(["blocker"]);
  });

  it("plugin that throws is wrapped as PLUGIN_REJECTED with the error message", async () => {
    const plugins: SigilPolicyPlugin[] = [
      {
        name: "broken",
        check: () => {
          throw new Error("rpc went sideways");
        },
      },
    ];
    try {
      await runPlugins(plugins, makePluginCtx());
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__PLUGIN_REJECTED,
      );
      expect((err as Error).message).to.include("rpc went sideways");
    }
  });

  it("accepts async plugin check()", async () => {
    const plugins: SigilPolicyPlugin[] = [
      {
        name: "async",
        check: async () => {
          await Promise.resolve();
          return { allow: true };
        },
      },
    ];
    await runPlugins(plugins, makePluginCtx());
  });
});

// ─── validatePluginList ─────────────────────────────────────────────────────

describe("validatePluginList", () => {
  it("rejects non-array input", () => {
    expect(() => validatePluginList("not an array")).to.throw(
      SigilSdkDomainError,
    );
  });

  it("rejects a plugin missing a name", () => {
    const plugins = [{ check: () => ({ allow: true as const }) }];
    try {
      validatePluginList(plugins);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__INVALID_CONFIG,
      );
    }
  });

  it("rejects a plugin without a check function", () => {
    const plugins = [{ name: "missing-check" }];
    expect(() => validatePluginList(plugins)).to.throw(SigilSdkDomainError);
  });

  it("rejects duplicate plugin names", () => {
    const plugins = [
      { name: "same", check: () => ({ allow: true as const }) },
      { name: "same", check: () => ({ allow: true as const }) },
    ];
    try {
      validatePluginList(plugins);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).to.include("Duplicate plugin name");
    }
  });

  it("accepts a well-formed plugin list", () => {
    const plugins: SigilPolicyPlugin[] = [
      { name: "one", check: () => ({ allow: true }) },
      { name: "two", check: () => ({ allow: true }) },
    ];
    expect(() => validatePluginList(plugins)).not.to.throw();
  });
});

// ─── SigilVault construction ────────────────────────────────────────────────

describe("SigilVault", () => {
  it("exports a class", () => {
    expect(SigilVault).to.be.a("function");
  });

  it("direct construction via `new SigilVault()` throws", () => {
    // TS disallows this at compile time; we cast to `any` to simulate a
    // JS-only consumer bypassing the compile-time check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = SigilVault as any;
    expect(() => new Ctor({}, {})).to.throw(
      /direct construction is not allowed/,
    );
  });
});
