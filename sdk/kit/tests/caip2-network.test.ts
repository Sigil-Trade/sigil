/**
 * Phase 9 Batch J — unit tests for CAIP-2 network identity + AL4 isMainnet.
 * (ISC-77, 78, 79, 80, 147).
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import {
  CAIP2_SOLANA_DEVNET,
  CAIP2_SOLANA_MAINNET,
  CAIP2_SOLANA_TESTNET,
  deriveNetworkIdentity,
  isMainnetCaip2,
  toCaip2,
  toWalletStandardChain,
  verifyNetworkIdentity,
  SOLANA_GENESIS_HASHES,
} from "../src/caip2-network.js";

describe("CAIP-2 — chain ids match the canonical registry", () => {
  it("mainnet chain id matches the published mainnet-beta CAIP-2 value", () => {
    expect(CAIP2_SOLANA_MAINNET).to.equal(
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
  });

  it("devnet chain id matches the published devnet CAIP-2 value", () => {
    expect(CAIP2_SOLANA_DEVNET).to.equal(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    );
  });

  it("testnet chain id is exported even though SDK doesn't currently produce it", () => {
    expect(CAIP2_SOLANA_TESTNET).to.equal(
      "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
    );
  });
});

describe("toCaip2(network) — strict mapping", () => {
  it("maps 'mainnet' to the mainnet-beta CAIP-2 id", () => {
    expect(toCaip2("mainnet")).to.equal(CAIP2_SOLANA_MAINNET);
  });

  it("maps 'devnet' to the devnet CAIP-2 id", () => {
    expect(toCaip2("devnet")).to.equal(CAIP2_SOLANA_DEVNET);
  });

  it("throws on any other network value (catches JS / any-cast bypass)", () => {
    expect(() => toCaip2("testnet" as unknown as "devnet")).to.throw(
      /network must be 'devnet' or 'mainnet'/,
    );
    expect(() => toCaip2("" as unknown as "devnet")).to.throw(
      /network must be 'devnet' or 'mainnet'/,
    );
  });
});

describe("isMainnetCaip2(chain) — true only for canonical mainnet-beta", () => {
  it("returns true for the canonical mainnet-beta chain id", () => {
    expect(isMainnetCaip2(CAIP2_SOLANA_MAINNET)).to.equal(true);
  });

  it("returns false for devnet", () => {
    expect(isMainnetCaip2(CAIP2_SOLANA_DEVNET)).to.equal(false);
  });

  it("returns false for testnet", () => {
    expect(isMainnetCaip2(CAIP2_SOLANA_TESTNET)).to.equal(false);
  });

  it("returns false for empty string (defensive)", () => {
    expect(isMainnetCaip2("")).to.equal(false);
  });

  it("returns false for a near-miss prefix match (no fuzzy matching)", () => {
    expect(
      isMainnetCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpEXTRA"),
    ).to.equal(false);
    expect(isMainnetCaip2("solana:")).to.equal(false);
    expect(isMainnetCaip2("ethereum:1")).to.equal(false);
  });
});

describe("deriveNetworkIdentity(network) — combined helper", () => {
  it("mainnet returns { CAIP-2 mainnet, isMainnet: true }", () => {
    const out = deriveNetworkIdentity("mainnet");
    expect(out.network).to.equal(CAIP2_SOLANA_MAINNET);
    expect(out.isMainnet).to.equal(true);
  });

  it("devnet returns { CAIP-2 devnet, isMainnet: false }", () => {
    const out = deriveNetworkIdentity("devnet");
    expect(out.network).to.equal(CAIP2_SOLANA_DEVNET);
    expect(out.isMainnet).to.equal(false);
  });

  it("invalid network throws via underlying toCaip2", () => {
    expect(() =>
      deriveNetworkIdentity("localnet" as unknown as "devnet"),
    ).to.throw();
  });
});

describe("toWalletStandardChain(caip2) — Wallet Standard chain id boundary (D-7)", () => {
  it("mainnet CAIP-2 string round-trips identity into the Wallet Standard format", () => {
    expect(toWalletStandardChain(CAIP2_SOLANA_MAINNET)).to.equal(
      CAIP2_SOLANA_MAINNET,
    );
  });

  it("devnet CAIP-2 string round-trips identity into the Wallet Standard format", () => {
    expect(toWalletStandardChain(CAIP2_SOLANA_DEVNET)).to.equal(
      CAIP2_SOLANA_DEVNET,
    );
  });

  it("composes with toCaip2() — produces `solana:<id>` from a network discriminant", () => {
    const chain = toWalletStandardChain(toCaip2("mainnet"));
    expect(chain.startsWith("solana:")).to.equal(true);
    expect(chain).to.equal(CAIP2_SOLANA_MAINNET);
  });
});

describe("AL3 ↔ AL4 binding — network discriminant survives round-trip", () => {
  it("network field on SealResult would be the CAIP-2 chain id (type-level check)", () => {
    // This test exists mostly as a documentation anchor — the actual
    // wiring is in seal.ts and tested via the seal() integration suite.
    // We verify here that deriveNetworkIdentity produces the expected
    // shape so consumers can rely on `SealResult.network` being CAIP-2.
    const m = deriveNetworkIdentity("mainnet");
    expect(m.network.startsWith("solana:")).to.equal(true);
    expect(m.network.length).to.be.greaterThan(10);
  });
});

// ─── M-3 (audit 2026-05-21): verifyNetworkIdentity ───────────────────────────
//
// Opt-in, non-throwing helper that asserts the RPC's reported genesis
// matches the caller's claimed network. Defends against the "devnet RPC
// + mainnet flag" silent bypass that isMainnetCaip2() (a pure string
// transform) cannot catch.

describe("SOLANA_GENESIS_HASHES — canonical cluster identifiers", () => {
  it("mainnet hash is the published mainnet-beta genesis hash", () => {
    expect(SOLANA_GENESIS_HASHES.mainnet).to.equal(
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    );
  });

  it("devnet hash is the published devnet genesis hash", () => {
    expect(SOLANA_GENESIS_HASHES.devnet).to.equal(
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    );
  });

  it("testnet hash is the published testnet genesis hash", () => {
    expect(SOLANA_GENESIS_HASHES.testnet).to.equal(
      "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    );
  });
});

describe("verifyNetworkIdentity(rpc, claimedNetwork) — opt-in RPC verification", () => {
  /** Build a stub RPC that returns `hash` from getGenesisHash().send(). */
  function rpcReturning(hash: string) {
    return {
      getGenesisHash: () => ({
        send: async () => hash,
      }),
    };
  }

  function rpcThrowing(err: unknown) {
    return {
      getGenesisHash: () => ({
        send: async () => {
          throw err;
        },
      }),
    };
  }

  it("returns verified=true when mainnet hash matches mainnet claim", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.mainnet),
      claimedNetwork: "mainnet",
    });
    expect(result.verified).to.equal(true);
    expect(result.actualNetwork).to.equal("mainnet");
    expect(result.expectedGenesisHash).to.equal(SOLANA_GENESIS_HASHES.mainnet);
    expect(result.observedGenesisHash).to.equal(SOLANA_GENESIS_HASHES.mainnet);
    expect(result.reason).to.equal(undefined);
  });

  it("returns verified=true when devnet hash matches devnet claim", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.devnet),
      claimedNetwork: "devnet",
    });
    expect(result.verified).to.equal(true);
    expect(result.actualNetwork).to.equal("devnet");
  });

  it("M-3 attack: devnet RPC + mainnet claim returns verified=false with actualNetwork=devnet", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.devnet),
      claimedNetwork: "mainnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.actualNetwork).to.equal("devnet");
    expect(result.expectedGenesisHash).to.equal(SOLANA_GENESIS_HASHES.mainnet);
    expect(result.observedGenesisHash).to.equal(SOLANA_GENESIS_HASHES.devnet);
    expect(result.reason).to.match(/mismatch/i);
  });

  it("M-3 attack: mainnet RPC + devnet claim returns verified=false with actualNetwork=mainnet", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.mainnet),
      claimedNetwork: "devnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.actualNetwork).to.equal("mainnet");
  });

  it("returns actualNetwork=testnet when RPC serves testnet", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.testnet),
      claimedNetwork: "mainnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.actualNetwork).to.equal("testnet");
  });

  it("returns actualNetwork=unknown for a localnet / surfpool genesis hash", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning("11111111111111111111111111111111ZeroGenesisHash"),
      claimedNetwork: "devnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.actualNetwork).to.equal("unknown");
  });

  it("does NOT throw when getGenesisHash() errors — returns structured failure", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcThrowing(new Error("ECONNREFUSED")),
      claimedNetwork: "mainnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.actualNetwork).to.equal("unknown");
    expect(result.reason).to.match(/ECONNREFUSED/);
  });

  it("does NOT throw on malformed RPC responses — returns structured failure", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning("short"),
      claimedNetwork: "mainnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.reason).to.match(/malformed/i);
  });

  it("rejects invalid claimedNetwork values (any-cast bypass) without throwing", async () => {
    const result = await verifyNetworkIdentity({
      rpc: rpcReturning(SOLANA_GENESIS_HASHES.mainnet),
      // Intentional bypass — JS callers can pass arbitrary strings.
      claimedNetwork: "localnet" as unknown as "devnet",
    });
    expect(result.verified).to.equal(false);
    expect(result.reason).to.match(/devnet.*mainnet/);
  });
});
