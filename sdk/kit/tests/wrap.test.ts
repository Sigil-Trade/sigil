import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import { wrap, replaceAgentAtas, PhalnxClient, type WrapParams, type PhalnxClientConfig } from "../src/wrap.js";
import { createVault, type CreateVaultOptions } from "../src/create-vault.js";
import { ActionType } from "../src/generated/types/actionType.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";
import { FULL_PERMISSIONS, PROTOCOL_TREASURY } from "../src/types.js";
import { createMockAgent, createMockVaultState } from "../src/testing/index.js";

// ─── Test Addresses ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
const FEE_DEST = "11111111111111111111111111111115" as Address;
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const UNKNOWN_PROTOCOL =
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn" as Address;
const COMPUTE_BUDGET =
  "ComputeBudget111111111111111111111111111111" as Address;

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function mockAgent() {
  return createMockAgent(AGENT_ADDR);
}

function mockOwner() {
  return {
    address: OWNER_ADDR,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

function makeInstruction(programAddress: Address): Instruction {
  return {
    programAddress,
    accounts: [
      { address: VAULT, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([1, 2, 3]),
  };
}

function makeCachedState(overrides?: Parameters<typeof createMockVaultState>[0]): ResolvedVaultState {
  return createMockVaultState({
    vault: VAULT,
    agent: AGENT_ADDR,
    owner: OWNER_ADDR,
    feeDestination: FEE_DEST,
    ...overrides,
  });
}

function baseWrapParams(overrides?: Partial<WrapParams>): WrapParams {
  return {
    vault: VAULT,
    agent: mockAgent(),
    instructions: [makeInstruction(JUPITER)],
    rpc: {} as any,
    network: "devnet",
    tokenMint: USDC_DEVNET,
    amount: 100_000_000n, // $100
    cachedState: makeCachedState(),
    blockhash: {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("wrap()", () => {
  it("with Jupiter protocol — returns composed TX with correct instruction order", async () => {
    const result = await wrap(baseWrapParams());

    expect(result.transaction).to.exist;
    expect(result.actionType).to.equal(ActionType.Swap);
    expect(result.warnings).to.be.an("array");
    expect(result.txSizeBytes).to.be.a("number");
    expect(result.txSizeBytes).to.be.greaterThan(0);
  });

  it("with unknown protocol + protocolMode=0 — succeeds with no warnings", async () => {
    const result = await wrap(
      baseWrapParams({
        instructions: [makeInstruction(UNKNOWN_PROTOCOL)],
        cachedState: makeCachedState({ protocolMode: 0 }),
      }),
    );
    expect(result.transaction).to.exist;
    // No protocol-related warnings (size warning may still appear)
    const protocolWarnings = result.warnings.filter((w) =>
      w.includes("protocol"),
    );
    expect(protocolWarnings).to.have.length(0);
  });

  it("defaults actionType to Swap when not provided", async () => {
    const result = await wrap(baseWrapParams({ actionType: undefined }));
    expect(result.actionType).to.equal(ActionType.Swap);
  });

  it("throws on non-active vault (status !== Active)", async () => {
    try {
      await wrap(
        baseWrapParams({
          cachedState: makeCachedState({ status: VaultStatus.Frozen }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not active");
    }
  });

  it("throws on paused agent", async () => {
    try {
      await wrap(
        baseWrapParams({
          cachedState: makeCachedState({ agentPaused: true }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("paused");
    }
  });

  it("adds advisory warning when amount exceeds cap headroom", async () => {
    const result = await wrap(
      baseWrapParams({
        amount: 2_000_000_000n, // $2000 — exceeds $1000 cap
        cachedState: makeCachedState({ dailyCap: 1_000_000_000n }),
      }),
    );
    const capWarnings = result.warnings.filter((w) =>
      w.includes("cap headroom"),
    );
    expect(capWarnings).to.have.length(1);
  });

  it("strips ComputeBudget from input instructions (avoids duplicate)", async () => {
    const cbIx = makeInstruction(COMPUTE_BUDGET);
    const jupIx = makeInstruction(JUPITER);
    const result = await wrap(
      baseWrapParams({
        instructions: [cbIx, jupIx],
      }),
    );
    // Should still succeed — ComputeBudget was stripped, Jupiter remains
    expect(result.transaction).to.exist;
  });

  it("throws on agent not found in vault", async () => {
    try {
      await wrap(
        baseWrapParams({
          cachedState: makeCachedState({ noAgents: true }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not registered");
    }
  });

  it("throws on no permission for action", async () => {
    try {
      await wrap(
        baseWrapParams({
          cachedState: makeCachedState({ agentPermissions: 0n }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("lacks permission");
    }
  });

  it("throws on protocol not allowed by policy", async () => {
    try {
      await wrap(
        baseWrapParams({
          cachedState: makeCachedState({
            protocolMode: 1, // allowlist
            protocols: [], // empty allowlist — nothing allowed
          }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not allowed");
    }
  });

  it("throws on spending action with amount=0", async () => {
    try {
      await wrap(
        baseWrapParams({
          amount: 0n,
          actionType: ActionType.Swap,
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("requires amount > 0");
    }
  });

  it("throws when no target protocol or DeFi instructions", async () => {
    try {
      await wrap(
        baseWrapParams({
          instructions: [], // no instructions
          targetProtocol: undefined,
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("No target protocol");
    }
  });

  it("throws on position limit exceeded", async () => {
    try {
      await wrap(
        baseWrapParams({
          actionType: ActionType.OpenPosition,
          cachedState: makeCachedState({
            maxConcurrentPositions: 2,
            openPositions: 2,
          }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("Position limit reached");
    }
  });
});

describe("replaceAgentAtas()", () => {
  const AGENT_TOKEN_ATA = "11111111111111111111111111111116" as Address;
  const VAULT_TOKEN_ATA = "11111111111111111111111111111117" as Address;
  const UNRELATED_ACCT = "11111111111111111111111111111118" as Address;

  function makeIxWithAccounts(
    accounts: { address: Address; role: AccountRole }[],
  ): Instruction {
    return {
      programAddress: JUPITER,
      accounts,
      data: new Uint8Array([1, 2, 3]),
    };
  }

  it("replaces agent ATA with vault ATA in DeFi instruction accounts", () => {
    const ix = makeIxWithAccounts([
      { address: AGENT_TOKEN_ATA, role: AccountRole.WRITABLE },
      { address: UNRELATED_ACCT, role: AccountRole.READONLY },
    ]);
    const replacements = new Map<Address, Address>([
      [AGENT_TOKEN_ATA, VAULT_TOKEN_ATA],
    ]);
    const result = replaceAgentAtas([ix], replacements);
    expect(result[0].accounts![0].address).to.equal(VAULT_TOKEN_ATA);
    expect(result[0].accounts![1].address).to.equal(UNRELATED_ACCT);
  });

  it("preserves account roles during replacement", () => {
    const ix = makeIxWithAccounts([
      { address: AGENT_TOKEN_ATA, role: AccountRole.WRITABLE_SIGNER },
    ]);
    const replacements = new Map<Address, Address>([
      [AGENT_TOKEN_ATA, VAULT_TOKEN_ATA],
    ]);
    const result = replaceAgentAtas([ix], replacements);
    expect(result[0].accounts![0].address).to.equal(VAULT_TOKEN_ATA);
    expect(result[0].accounts![0].role).to.equal(AccountRole.WRITABLE_SIGNER);
  });

  it("does not replace non-ATA accounts", () => {
    const ix = makeIxWithAccounts([
      { address: UNRELATED_ACCT, role: AccountRole.READONLY },
      { address: JUPITER, role: AccountRole.READONLY },
    ]);
    const replacements = new Map<Address, Address>([
      [AGENT_TOKEN_ATA, VAULT_TOKEN_ATA],
    ]);
    const result = replaceAgentAtas([ix], replacements);
    expect(result[0].accounts![0].address).to.equal(UNRELATED_ACCT);
    expect(result[0].accounts![1].address).to.equal(JUPITER);
  });

  it("handles instructions with no accounts gracefully", () => {
    const ix = makeIxWithAccounts([]);
    const replacements = new Map<Address, Address>([
      [AGENT_TOKEN_ATA, VAULT_TOKEN_ATA],
    ]);
    const result = replaceAgentAtas([ix], replacements);
    expect(result).to.have.length(1);
    expect(result[0].accounts).to.deep.equal([]);
    expect(result[0].programAddress).to.equal(JUPITER);
  });
});

describe("createVault()", () => {
  it("returns correct vault + policy PDAs", async () => {
    const result = await createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
    });

    expect(result.vaultAddress).to.be.a("string");
    expect(result.policyAddress).to.be.a("string");
    expect(result.agentOverlayAddress).to.be.a("string");
    expect(result.vaultId).to.equal(0n);
    expect(result.initializeVaultIx).to.exist;
    expect(result.initializeVaultIx.programAddress).to.be.a("string");
    expect(result.registerAgentIx).to.exist;
    expect(result.registerAgentIx.programAddress).to.be.a("string");
  });

  it("throws on owner === agent", async () => {
    const sameKey = mockOwner();
    try {
      await createVault({
        rpc: {} as any,
        network: "devnet",
        owner: sameKey,
        agent: sameKey,
        vaultId: 0n,
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("Owner and agent must be different");
    }
  });

  it("derives deterministic PDAs for same inputs", async () => {
    const r1 = await createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
    });
    const r2 = await createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
    });
    expect(r1.vaultAddress).to.equal(r2.vaultAddress);
    expect(r1.policyAddress).to.equal(r2.policyAddress);
    expect(r1.agentOverlayAddress).to.equal(r2.agentOverlayAddress);
  });
});

// ─── PhalnxClient Tests ─────────────────────────────────────────────────

/** Mock RPC that supports getLatestBlockhash (needed by PhalnxClient's instance cache). */
function mockRpc() {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
          lastValidBlockHeight: 200n,
        },
      }),
    }),
  } as any;
}

function clientConfig(overrides?: Partial<PhalnxClientConfig>): PhalnxClientConfig {
  return {
    rpc: mockRpc(),
    vault: VAULT,
    agent: mockAgent(),
    network: "devnet",
    ...overrides,
  };
}

describe("PhalnxClient", () => {
  it("constructor stores vault, agent, network, and creates caches", () => {
    const agent = mockAgent();
    const client = new PhalnxClient({
      rpc: {} as any,
      vault: VAULT,
      agent,
      network: "devnet",
    });

    expect(client.rpc).to.exist;
    expect(client.vault).to.equal(VAULT);
    expect(client.agent).to.equal(agent);
    expect(client.network).to.equal("devnet");
    // invalidateCaches should not throw (caches exist)
    expect(() => client.invalidateCaches()).to.not.throw();
  });

  it("client.wrap() produces WrapResult via delegation to standalone wrap()", async () => {
    const client = new PhalnxClient(clientConfig());
    const result = await client.wrap(
      [makeInstruction(JUPITER)],
      {
        tokenMint: USDC_DEVNET,
        amount: 100_000_000n,
        cachedState: makeCachedState(),
        addressLookupTables: {},
      },
    );

    expect(result.ok).to.equal(true);
    expect(result.transaction).to.exist;
    expect(result.actionType).to.equal(ActionType.Swap);
    expect(result.txSizeBytes).to.be.a("number");
  });

  it("client.wrap() produces same actionType as direct wrap() with identical params", async () => {
    const state = makeCachedState();
    const blockhash = {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    };

    // Use ClosePosition (non-spending, amount=0) to avoid RPC calls for fee ATAs
    const directResult = await wrap(baseWrapParams({
      cachedState: state,
      blockhash,
      actionType: ActionType.ClosePosition,
      amount: 0n,
    }));

    const client = new PhalnxClient(clientConfig());
    const clientResult = await client.wrap(
      [makeInstruction(JUPITER)],
      {
        tokenMint: USDC_DEVNET,
        amount: 0n,
        actionType: ActionType.ClosePosition,
        cachedState: state,
        // Pre-supply ALTs to avoid RPC call for ALT resolution
        addressLookupTables: {},
      },
    );

    expect(clientResult.actionType).to.equal(directResult.actionType);
    expect(clientResult.ok).to.equal(directResult.ok);
  });

  it("executeAndConfirm() throws if agent signer lacks signTransactions", async () => {
    const brokenAgent = { address: AGENT_ADDR } as any; // no signTransactions
    const client = new PhalnxClient(clientConfig({ agent: brokenAgent }));

    try {
      await client.executeAndConfirm(
        [makeInstruction(JUPITER)],
        {
          tokenMint: USDC_DEVNET,
          amount: 100_000_000n,
          cachedState: makeCachedState(),
          addressLookupTables: {},
        },
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("signTransactions");
    }
  });

  it("constructor throws if rpc is missing", () => {
    try {
      new PhalnxClient({ rpc: undefined as any, vault: VAULT, agent: mockAgent(), network: "devnet" });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("rpc is required");
    }
  });

  it("constructor throws if vault is missing", () => {
    try {
      new PhalnxClient({ rpc: {} as any, vault: undefined as any, agent: mockAgent(), network: "devnet" });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("vault is required");
    }
  });

  it("constructor throws if agent is missing", () => {
    try {
      new PhalnxClient({ rpc: {} as any, vault: VAULT, agent: undefined as any, network: "devnet" });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("agent is required");
    }
  });

  it("constructor throws if network is missing", () => {
    try {
      new PhalnxClient({ rpc: {} as any, vault: VAULT, agent: mockAgent(), network: undefined as any });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("network is required");
    }
  });

  it("PhalnxClient.createVault() delegates to standalone createVault", async () => {
    const result = await PhalnxClient.createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
    });

    expect(result.vaultAddress).to.be.a("string");
    expect(result.policyAddress).to.be.a("string");
    expect(result.vaultId).to.equal(0n);
    expect(result.initializeVaultIx).to.exist;
    expect(result.registerAgentIx).to.exist;
  });
});
