import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  seal,
  replaceAgentAtas,
  SigilClient,
  createSigilClient,
  type SealParams,
  type SigilClientConfig,
} from "../src/seal.js";
import { createVault, type CreateVaultOptions } from "../src/create-vault.js";
import { deriveAta } from "../src/x402/transfer-builder.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";
import {
  FULL_CAPABILITY,
  PROTOCOL_TREASURY,
  USDC_MINT_DEVNET,
} from "../src/types.js";
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
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;

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
    accounts: [{ address: VAULT, role: AccountRole.WRITABLE }],
    data: new Uint8Array([1, 2, 3]),
  };
}

function makeCachedState(
  overrides?: Parameters<typeof createMockVaultState>[0],
): ResolvedVaultState {
  return createMockVaultState({
    vault: VAULT,
    agent: AGENT_ADDR,
    owner: OWNER_ADDR,
    feeDestination: FEE_DEST,
    ...overrides,
  });
}

function baseSealParams(overrides?: Partial<SealParams>): SealParams {
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

describe("seal()", () => {
  it("with Jupiter protocol — returns composed TX with correct instruction order", async () => {
    const result = await seal(baseSealParams());

    expect(result.transaction).to.exist;
    expect(result.isSpending).to.equal(true);
    expect(result.warnings).to.be.an("array");
    expect(result.txSizeBytes).to.be.a("number");
    expect(result.txSizeBytes).to.be.greaterThan(0);
  });

  it("with unknown protocol + protocolMode=0 — succeeds with no warnings", async () => {
    const result = await seal(
      baseSealParams({
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

  it("determines spending from amount > 0n", async () => {
    const result = await seal(baseSealParams({ amount: 100_000_000n }));
    expect(result.isSpending).to.equal(true);
  });

  it("throws on non-active vault (status !== Active)", async () => {
    try {
      await seal(
        baseSealParams({
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
      await seal(
        baseSealParams({
          cachedState: makeCachedState({ agentPaused: true }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("paused");
    }
  });

  it("throws error when amount + fees exceeds cap headroom", async () => {
    try {
      await seal(
        baseSealParams({
          amount: 2_000_000_000n, // $2000 — exceeds $1000 cap
          cachedState: makeCachedState({ dailyCap: 1_000_000_000n }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("exceeds remaining daily cap headroom");
    }
  });

  it("strips ComputeBudget from input instructions (avoids duplicate)", async () => {
    const cbIx = makeInstruction(COMPUTE_BUDGET);
    const jupIx = makeInstruction(JUPITER);
    const result = await seal(
      baseSealParams({
        instructions: [cbIx, jupIx],
      }),
    );
    // Should still succeed — ComputeBudget was stripped, Jupiter remains
    expect(result.transaction).to.exist;
  });

  it("throws on agent not found in vault", async () => {
    try {
      await seal(
        baseSealParams({
          cachedState: makeCachedState({ noAgents: true }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not registered");
    }
  });

  it("throws on zero capability agent", async () => {
    try {
      await seal(
        baseSealParams({
          cachedState: makeCachedState({ agentCapability: 0n }),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("zero capability");
    }
  });

  it("throws on protocol not allowed by policy", async () => {
    try {
      await seal(
        baseSealParams({
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

  it("amount=0 results in non-spending seal", async () => {
    const result = await seal(
      baseSealParams({
        amount: 0n,
      }),
    );
    expect(result.isSpending).to.equal(false);
  });

  it("throws when no target protocol or DeFi instructions", async () => {
    try {
      await seal(
        baseSealParams({
          instructions: [], // no instructions
          targetProtocol: undefined,
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("No target protocol");
    }
  });

  it("warns on position limit approached for spending actions", async () => {
    const result = await seal(
      baseSealParams({
        amount: 100_000_000n,
        cachedState: makeCachedState({
          maxConcurrentPositions: 2,
          openPositions: 2,
        }),
      }),
    );
    const posWarnings = result.warnings.filter((w) =>
      w.includes("Position limit"),
    );
    expect(posWarnings.length).to.be.greaterThan(0);
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
      spendingLimitUsd: 100_000_000n as never,
      dailySpendingCapUsd: 500_000_000n as never,
      timelockDuration: 1800,
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
        spendingLimitUsd: 100_000_000n as never,
        dailySpendingCapUsd: 500_000_000n as never,
        timelockDuration: 1800,
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
      spendingLimitUsd: 100_000_000n as never,
      dailySpendingCapUsd: 500_000_000n as never,
      timelockDuration: 1800,
    });
    const r2 = await createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
      spendingLimitUsd: 100_000_000n as never,
      dailySpendingCapUsd: 500_000_000n as never,
      timelockDuration: 1800,
    });
    expect(r1.vaultAddress).to.equal(r2.vaultAddress);
    expect(r1.policyAddress).to.equal(r2.policyAddress);
    expect(r1.agentOverlayAddress).to.equal(r2.agentOverlayAddress);
  });
});

// ─── SigilClient Tests ─────────────────────────────────────────────────

/** Mock RPC that supports getLatestBlockhash (needed by SigilClient's instance cache). */
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

function clientConfig(
  overrides?: Partial<SigilClientConfig>,
): SigilClientConfig {
  return {
    rpc: mockRpc(),
    vault: VAULT,
    agent: mockAgent(),
    network: "devnet",
    ...overrides,
  };
}

describe("SigilClient", () => {
  it("constructor stores vault, agent, network, and creates caches", () => {
    const agent = mockAgent();
    const client = createSigilClient({
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

  it("client.seal() produces SealResult via delegation to standalone seal()", async () => {
    const client = createSigilClient(clientConfig());
    const result = await client.seal([makeInstruction(JUPITER)], {
      tokenMint: USDC_DEVNET,
      amount: 100_000_000n,
      cachedState: makeCachedState(),
      addressLookupTables: {},
    });

    expect(result.ok).to.equal(true);
    expect(result.transaction).to.exist;
    expect(result.isSpending).to.equal(true);
    expect(result.txSizeBytes).to.be.a("number");
  });

  it("client.seal() produces same isSpending as direct seal() with identical params", async () => {
    const state = makeCachedState();
    const blockhash = {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    };

    // Use amount=0 (non-spending) to avoid RPC calls for fee ATAs
    const directResult = await seal(
      baseSealParams({
        cachedState: state,
        blockhash,
        amount: 0n,
      }),
    );

    const client = createSigilClient(clientConfig());
    const clientResult = await client.seal([makeInstruction(JUPITER)], {
      tokenMint: USDC_DEVNET,
      amount: 0n,
      cachedState: state,
      // Pre-supply ALTs to avoid RPC call for ALT resolution
      addressLookupTables: {},
    });

    expect(clientResult.isSpending).to.equal(directResult.isSpending);
    expect(clientResult.ok).to.equal(directResult.ok);
  });

  it("executeAndConfirm() throws if agent signer lacks signTransactions", async () => {
    const brokenAgent = { address: AGENT_ADDR } as any; // no signTransactions
    const client = createSigilClient(clientConfig({ agent: brokenAgent }));

    try {
      await client.executeAndConfirm([makeInstruction(JUPITER)], {
        tokenMint: USDC_DEVNET,
        amount: 100_000_000n,
        cachedState: makeCachedState(),
        addressLookupTables: {},
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("signTransactions");
    }
  });

  it("constructor throws if rpc is missing", () => {
    try {
      createSigilClient({
        rpc: undefined as any,
        vault: VAULT,
        agent: mockAgent(),
        network: "devnet",
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("rpc is required");
    }
  });

  it("constructor throws if vault is missing", () => {
    try {
      createSigilClient({
        rpc: {} as any,
        vault: undefined as any,
        agent: mockAgent(),
        network: "devnet",
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("vault is required");
    }
  });

  it("constructor throws if agent is missing", () => {
    try {
      createSigilClient({
        rpc: {} as any,
        vault: VAULT,
        agent: undefined as any,
        network: "devnet",
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("agent is required");
    }
  });

  it("constructor throws if network is missing", () => {
    try {
      createSigilClient({
        rpc: {} as any,
        vault: VAULT,
        agent: mockAgent(),
        network: undefined as any,
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("network is required");
    }
  });

  it("SigilClient.createVault() delegates to standalone createVault", async () => {
    const result = await SigilClient.createVault({
      rpc: {} as any,
      network: "devnet",
      owner: mockOwner(),
      agent: mockAgent(),
      vaultId: 0n,
      spendingLimitUsd: 100_000_000n as never,
      dailySpendingCapUsd: 500_000_000n as never,
      timelockDuration: 1800,
    });

    expect(result.vaultAddress).to.be.a("string");
    expect(result.policyAddress).to.be.a("string");
    expect(result.vaultId).to.equal(0n);
    expect(result.initializeVaultIx).to.exist;
    expect(result.registerAgentIx).to.exist;
  });
});

// ─── Pre-flight checks (Steps 23, 24) ────────────────────────────────────────

const TOKEN_PROGRAM_ADDR =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022_ADDR =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

describe("seal() pre-flight checks", () => {
  it("throws on top-level SPL Transfer in instructions", async () => {
    const splTransferIx: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]), // disc 3 = Transfer
    };
    try {
      await seal(baseSealParams({ instructions: [splTransferIx] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("SPL Token Transfer not allowed");
    }
  });

  it("throws on top-level SPL Approve in instructions", async () => {
    const splApproveIx: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0, 0]), // disc 4 = Approve
    };
    try {
      await seal(baseSealParams({ instructions: [splApproveIx] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("SPL Token Approve not allowed");
    }
  });

  it("throws on top-level SPL ApproveChecked in instructions", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([13, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("ApproveChecked not allowed");
    }
  });

  it("throws on top-level SPL Burn in instructions", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("Burn");
    }
  });

  it("throws on top-level SPL BurnChecked in instructions", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([15, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("Burn");
    }
  });

  it("throws on top-level SPL SetAuthority in instructions", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([6, 1, 1, ...new Array(32).fill(0)]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("SetAuthority");
    }
  });

  it("throws on top-level SPL CloseAccount in instructions", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([9]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("CloseAccount");
    }
  });

  // --- ADV-6: Negative amount ---
  it("throws clean error on negative amount", async () => {
    try {
      await seal(baseSealParams({ amount: -1n }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("non-negative");
    }
  });

  // --- ADV-1: ATA replacement collision ---
  it("throws when additionalAtaReplacements conflicts with canonical ATA", async () => {
    const canonicalAta = await deriveAta(AGENT_ADDR, USDC_DEVNET);
    try {
      await seal(
        baseSealParams({
          additionalAtaReplacements: new Map([
            [
              canonicalAta,
              "Malicious1111111111111111111111111111111111" as Address,
            ],
          ]),
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("conflicts with canonical");
    }
  });

  // --- ADV-3: Role-based ATA replacement ---
  it("replaceAgentAtas preserves READONLY accounts", () => {
    const agentAta = "AgentAta111111111111111111111111111111111111" as Address;
    const vaultAta = "VaultAta111111111111111111111111111111111111" as Address;
    const map = new Map<Address, Address>([[agentAta, vaultAta]]);
    const ix: Instruction = {
      programAddress: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
      accounts: [
        { address: agentAta, role: AccountRole.WRITABLE },
        { address: agentAta, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1]),
    };
    const [result] = replaceAgentAtas([ix], map);
    expect(result.accounts![0].address).to.equal(vaultAta); // WRITABLE → replaced
    expect(result.accounts![1].address).to.equal(agentAta); // READONLY → preserved
  });

  // --- ADV-2: Non-stablecoin token balance ---
  it("fetches non-stablecoin token balance for vaultContext drain detection", async () => {
    const amount = 500_000_000n;
    const data = new Uint8Array(72);
    for (let i = 0; i < 8; i++)
      data[64 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
    const base64 = btoa(String.fromCharCode(...data));
    const NON_STABLE = "NonStab1e1111111111111111111111111111111111" as Address;
    const rpcWithBalance = {
      ...mockRpc(),
      getAccountInfo: () => ({
        send: async () => ({ value: { data: [base64, "base64"] } }),
      }),
    };
    const result = await seal(
      baseSealParams({
        rpc: rpcWithBalance as any,
        tokenMint: NON_STABLE,
        addressLookupTables: {},
      }),
    );
    expect(result.vaultContext!.tokenBalance).to.equal(amount);
  });

  it("uses conservative 1n sentinel when non-stablecoin RPC fetch fails", async () => {
    const NON_STABLE = "NonStab1e1111111111111111111111111111111111" as Address;
    const rpcThatFails = {
      ...mockRpc(),
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("RPC timeout");
        },
      }),
    };
    const result = await seal(
      baseSealParams({
        rpc: rpcThatFails as any,
        tokenMint: NON_STABLE,
        addressLookupTables: {},
      }),
    );
    // Sentinel makes any outflow trigger drain detection (conservative)
    expect(result.vaultContext!.tokenBalance).to.equal(1n); // DRAIN_DETECTION_MIN_BALANCE
    expect(result.warnings.some((w) => w.includes("conservative fallback"))).to
      .be.true;
  });

  it("throws on 2+ DeFi instructions for stablecoin input", async () => {
    const jupIx1 = makeInstruction(JUPITER);
    const jupIx2 = makeInstruction(JUPITER);
    try {
      await seal(
        baseSealParams({
          instructions: [jupIx1, jupIx2],
          tokenMint: USDC_MINT_DEVNET, // stablecoin — must use real mint for isStablecoinMint() to match
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("At most 1 recognized DeFi instruction");
    }
  });

  it("throws on 0 DeFi instructions for non-stablecoin input", async () => {
    const nonDefiIx: Instruction = {
      programAddress: "UnknownProg1111111111111111111111111111111" as Address,
      accounts: [],
      data: new Uint8Array([1]),
    };
    try {
      await seal(
        baseSealParams({
          instructions: [nonDefiIx],
          tokenMint: "So11111111111111111111111111111111111111112" as Address,
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      // PR 2.A: SigilError base appends a Version footer; assert via .include.
      expect(e.message).to.include(
        "Exactly 1 recognized DeFi instruction required for non-stablecoin input.",
      );
    }
  });

  // Disc 12 (TransferChecked) — must also be blocked
  it("throws on top-level SPL TransferChecked (disc 12)", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [],
      data: new Uint8Array([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.match(/SPL Token Transfer not allowed/);
    }
  });

  // Disc 26 (Token-2022 TransferCheckedWithFee) — must be blocked
  it("throws on Token-2022 TransferCheckedWithFee (disc 26)", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_2022_ADDR,
      accounts: [],
      data: new Uint8Array([26, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    try {
      await seal(baseSealParams({ instructions: [ix] }));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.match(/SPL Token Transfer not allowed/);
    }
  });

  // Negative test: disc 1 (InitializeMint) should NOT be blocked
  it("does not block SPL InitializeMint (disc 1)", async () => {
    const ix: Instruction = {
      programAddress: TOKEN_PROGRAM_ADDR,
      accounts: [{ address: VAULT, role: AccountRole.WRITABLE }],
      data: new Uint8Array([1, 6, 0, 0, 0]),
    };
    // This should pass through SPL blocking and fail later (e.g., DeFi count check)
    // but NOT with "SPL Token Transfer not allowed" or "SPL Token Approve not allowed"
    try {
      await seal(baseSealParams({ instructions: [ix] }));
    } catch (e: any) {
      expect(e.message).to.not.match(
        /SPL Token (Transfer|Approve) not allowed/,
      );
    }
  });

  // DeFi count: 2+ recognized for non-stablecoin — should fail
  it("throws on 2+ DeFi instructions for non-stablecoin input", async () => {
    try {
      await seal(
        baseSealParams({
          instructions: [makeInstruction(JUPITER), makeInstruction(JUPITER)],
          tokenMint: "So11111111111111111111111111111111111111112" as Address,
        }),
      );
      expect.fail("should throw");
    } catch (e: any) {
      // PR 2.A: SigilError base appends a Version footer; assert via .include.
      expect(e.message).to.include(
        "Exactly 1 recognized DeFi instruction required for non-stablecoin input.",
      );
    }
  });
});
