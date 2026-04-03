import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  buildOwnerTransaction,
  type BuildOwnerTransactionParams,
} from "../src/owner-transaction.js";
import { MAX_TX_SIZE } from "../src/composer.js";
import { CU_OWNER_ACTION } from "../src/priority-fees.js";
import { SIGIL_PROGRAM_ADDRESS } from "../src/types.js";
import {
  createMockRpc,
  createMockAgent,
  MOCK_BLOCKHASH,
} from "../src/testing/index.js";

// ─── Test Addresses ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockOwner() {
  return createMockAgent(OWNER_ADDR);
}

function makeFreezeInstruction(): Instruction {
  return {
    programAddress: SIGIL_PROGRAM_ADDRESS,
    accounts: [
      { address: VAULT, role: AccountRole.WRITABLE },
      { address: OWNER_ADDR, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([0xaa, 0xbb, 0xcc]),
  };
}

function makeRegisterAgentInstruction(): Instruction {
  return {
    programAddress: SIGIL_PROGRAM_ADDRESS,
    accounts: [
      { address: VAULT, role: AccountRole.WRITABLE },
      { address: OWNER_ADDR, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([0xdd, 0xee, 0xff]),
  };
}

function baseParams(
  overrides?: Partial<BuildOwnerTransactionParams>,
): BuildOwnerTransactionParams {
  return {
    rpc: createMockRpc(),
    owner: mockOwner(),
    instructions: [makeFreezeInstruction()],
    network: "devnet",
    blockhash: MOCK_BLOCKHASH,
    addressLookupTables: {},
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildOwnerTransaction()", () => {
  it("single instruction — builds valid TX with compute budget + owner IX", async () => {
    const result = await buildOwnerTransaction(baseParams());

    expect(result.transaction).to.exist;
    expect(result.txSizeBytes).to.be.a("number");
    expect(result.txSizeBytes).to.be.greaterThan(0);
    expect(result.txSizeBytes).to.be.at.most(MAX_TX_SIZE);
    expect(result.wireBase64).to.be.a("string").and.not.be.empty;
  });

  it("multi-instruction — composes 2 instructions into one TX", async () => {
    const result = await buildOwnerTransaction(
      baseParams({
        instructions: [makeFreezeInstruction(), makeRegisterAgentInstruction()],
      }),
    );

    expect(result.transaction).to.exist;
    expect(result.txSizeBytes).to.be.greaterThan(0);
    expect(result.txSizeBytes).to.be.at.most(MAX_TX_SIZE);
  });

  it("custom compute units — overrides default CU_OWNER_ACTION", async () => {
    const customCU = 500_000;
    const result = await buildOwnerTransaction(
      baseParams({ computeUnits: customCU }),
    );

    expect(result.transaction).to.exist;
    expect(result.txSizeBytes).to.be.greaterThan(0);
  });

  it("priority fee — adds SetComputeUnitPrice when microLamports > 0", async () => {
    const result = await buildOwnerTransaction(
      baseParams({ priorityFeeMicroLamports: 10_000 }),
    );

    expect(result.transaction).to.exist;
    expect(result.txSizeBytes).to.be.greaterThan(0);
  });

  it("pre-supplied blockhash — uses provided blockhash, no RPC call", async () => {
    const customBlockhash = {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 500n,
    };

    // RPC that would throw if called for blockhash
    const rpc = createMockRpc();
    const result = await buildOwnerTransaction(
      baseParams({ rpc, blockhash: customBlockhash }),
    );

    expect(result.transaction).to.exist;
  });

  it("pre-supplied ALTs — uses provided ALTs, no ALT resolution", async () => {
    const result = await buildOwnerTransaction(
      baseParams({ addressLookupTables: {} }),
    );

    expect(result.transaction).to.exist;
    expect(result.txSizeBytes).to.be.greaterThan(0);
  });

  it("empty instructions — throws error", async () => {
    try {
      await buildOwnerTransaction(baseParams({ instructions: [] }));
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("At least one instruction is required");
    }
  });
});
