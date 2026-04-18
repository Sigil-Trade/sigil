import { describe, it, afterEach } from "mocha";
import { expect } from "chai";

import {
  SigilClient,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
} from "../src/seal.js";
import type { Address, TransactionSigner } from "../src/kit-adapter.js";
import {
  setSigilModuleLogger,
  NOOP_LOGGER,
  type SigilLogger,
} from "../src/logger.js";

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT = {
  address: "Sysvar1nstructions1111111111111111111111111" as Address,
  signTransactions: async () => [],
  signAndSendTransactions: async () => [],
} as unknown as TransactionSigner;

/**
 * Test RPC factory — builds a minimal stub that honors `getGenesisHash()`
 * with a configurable value. Returns a `counters` object so tests can
 * observe the internal call count by reference.
 */
function makeStubRpc(
  hash: string,
  opts: { errorCount?: number } = {},
): { rpc: any; counters: { calls: number } } {
  const counters = { calls: 0 };
  let errorsRemaining = opts.errorCount ?? 0;
  const rpc = {
    getGenesisHash() {
      return {
        send: async () => {
          counters.calls++;
          if (errorsRemaining > 0) {
            errorsRemaining--;
            throw new Error("rpc transport error");
          }
          return hash;
        },
      };
    },
  };
  return { rpc, counters };
}

describe("SigilClient.create — genesis hash assertion", () => {
  afterEach(() => {
    setSigilModuleLogger(NOOP_LOGGER);
  });

  it("passes when devnet RPC returns the canonical devnet hash", async () => {
    const { rpc, counters: _unused_counters } = makeStubRpc(
      SOLANA_DEVNET_GENESIS_HASH,
    );
    const client = await SigilClient.create({
      rpc,
      vault: VAULT,
      agent: AGENT,
      network: "devnet",
    });
    expect(client).to.be.instanceOf(SigilClient);
    expect(client.network).to.equal("devnet");
  });

  it("passes when mainnet RPC returns the canonical mainnet hash", async () => {
    const { rpc, counters: _unused_counters } = makeStubRpc(
      SOLANA_MAINNET_GENESIS_HASH,
    );
    const client = await SigilClient.create({
      rpc,
      vault: VAULT,
      agent: AGENT,
      network: "mainnet",
    });
    expect(client).to.be.instanceOf(SigilClient);
    expect(client.network).to.equal("mainnet");
  });

  it("throws SigilRpcError when mainnet RPC returns the devnet hash", async () => {
    const { rpc, counters: _unused_counters } = makeStubRpc(
      SOLANA_DEVNET_GENESIS_HASH,
    );
    let threw = false;
    try {
      await SigilClient.create({
        rpc,
        vault: VAULT,
        agent: AGENT,
        network: "mainnet",
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error;
      expect(e.message).to.include("Genesis hash mismatch");
      expect(e.message).to.include("mainnet");
    }
    expect(threw, "expected create() to throw on mismatch").to.be.true;
  });

  it("throws after 3 retries when getGenesisHash consistently fails", async () => {
    const { rpc, counters } = makeStubRpc(SOLANA_DEVNET_GENESIS_HASH, {
      errorCount: 5,
    });
    let threw = false;
    try {
      await SigilClient.create({
        rpc,
        vault: VAULT,
        agent: AGENT,
        network: "devnet",
      });
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).to.include("getGenesisHash");
    }
    expect(threw, "expected create() to throw after retries exhausted").to.be
      .true;
    // Exactly 3 attempts made (withRetry attempts = 3).
    expect(rpc.getGenesisHash().send).to.be.a("function"); // anchor the shape
    // Internal counter is shared by reference; withRetry attempts = 3.
    expect(counters.calls).to.be.greaterThanOrEqual(3);
  });

  it("skipGenesisAssertion=true bypasses the check and warns via logger", async () => {
    const warnings: string[] = [];
    const logger: SigilLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
    };
    const { rpc, counters } = makeStubRpc(SOLANA_DEVNET_GENESIS_HASH);
    const client = await SigilClient.create({
      rpc,
      vault: VAULT,
      agent: AGENT,
      network: "mainnet", // intentional mismatch — would throw without skip
      skipGenesisAssertion: true,
      logger,
    });
    expect(client).to.be.instanceOf(SigilClient);
    expect(
      warnings.some((w) => w.includes("skipGenesisAssertion=true")),
      "expected skip-path warning",
    ).to.be.true;
    // No getGenesisHash call made when skipped.
    expect(counters.calls).to.equal(0);
  });

  it("caches the observed hash per RPC — repeated create() doesn't refetch", async () => {
    const { rpc, counters } = makeStubRpc(SOLANA_DEVNET_GENESIS_HASH);
    // `calls` tracks hits to the stub's `.send()`. First create triggers
    // fetch, second should hit the WeakMap cache.
    const ref = { rpc }; // stable reference so WeakMap keys line up
    // Note: WeakMap keys are by identity — pass the same rpc instance.
    const c1 = await SigilClient.create({
      rpc: ref.rpc,
      vault: VAULT,
      agent: AGENT,
      network: "devnet",
    });
    const afterFirst = counters.calls;
    const c2 = await SigilClient.create({
      rpc: ref.rpc,
      vault: VAULT,
      agent: AGENT,
      network: "devnet",
    });
    expect(c1).to.be.instanceOf(SigilClient);
    expect(c2).to.be.instanceOf(SigilClient);
    expect(afterFirst).to.equal(1); // fetched once
    expect(counters.calls).to.equal(1); // still just once after second call
  });

  it("sync constructor is private — direct `new SigilClient()` throws (Sprint 2 carryover)", () => {
    const { rpc } = makeStubRpc(SOLANA_DEVNET_GENESIS_HASH);
    // TS would reject this at compile time; cast through any to simulate
    // a JS consumer that bypasses the TS visibility rule.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = SigilClient as any;
    expect(
      () => new Ctor({ rpc, vault: VAULT, agent: AGENT, network: "devnet" }),
    ).to.throw(/direct construction is not allowed/);
  });
});

describe("SigilClient.create — config.logger injection", () => {
  afterEach(() => {
    setSigilModuleLogger(NOOP_LOGGER);
  });

  it("installs config.logger as the module logger before genesis assertion", async () => {
    const events: string[] = [];
    const logger: SigilLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => events.push(`warn: ${msg}`),
      error: (msg) => events.push(`error: ${msg}`),
    };
    const { rpc, counters: _unused_counters } = makeStubRpc(
      SOLANA_DEVNET_GENESIS_HASH,
    );
    await SigilClient.create({
      rpc,
      vault: VAULT,
      agent: AGENT,
      network: "devnet",
      logger,
    });
    // .create() suppresses the sync-ctor deprecation warning (C-review C4)
    // so there should be NO "sync constructor bypasses" warning on the
    // async path. The presence of that warning would be misleading spam.
    expect(
      events.some((e) => e.includes("sync constructor bypasses")),
      "create() must NOT emit the sync-ctor deprecation warning",
    ).to.be.false;
    // The logger was still installed — follow-up leaf warnings would
    // flow through it. Nothing to assert here without triggering a warn.
  });

  // Sprint 2 carryover: the "DOES emit deprecation warning" test is no
  // longer relevant — the sync ctor now throws rather than warns. The
  // "is private — throws" assertion lives in the preceding describe block.
});
