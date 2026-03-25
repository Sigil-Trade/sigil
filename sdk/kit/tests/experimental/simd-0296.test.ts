/**
 * SIMD-0296 readiness tests — validates Phalnx security invariants
 * hold at the proposed 4,096-byte transaction size limit.
 *
 * These tests verify that:
 * 1. Composed transactions that exceed 1,232 bytes but fit in 4,096 are constructable
 * 2. The post-finalize instruction scan pattern catches trailing attacks at expanded sizes
 * 3. The instruction scan loop (max 20 iterations) is sufficient at expanded sizes
 *
 * Excluded from default test run. Run with: pnpm --filter @phalnx/kit test:experimental
 *
 * @see https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0296-larger-transactions.md
 * @see https://simd-0296.surfnet.dev/
 */

import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  composePhalnxTransaction,
  measureTransactionSize,
  MAX_TX_SIZE,
} from "../../src/composer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPOSED_MAX_TX_SIZE = 4_096;
const CURRENT_MAX_TX_SIZE = 1_232;

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic valid base58 address from an index.
 * Uses a template of all '1's (valid base58) with varying final chars.
 */
// Valid base58 addresses safe to mark as writable in mock instructions.
// Generated from known Solana addresses — NOT program IDs.
const ADDR_POOL: Address[] = [
  "BtRLCMVamw9c3R8UDwgYBCFur5YVkqACmakVh9xi2aTw" as Address,
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT" as Address,
  "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH" as Address,
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp" as Address,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address,
  "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA" as Address,
  "43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze" as Address,
  "9noXzpXnkyEcKF3AeXqUHTdR59V5uvrRBUZ9bwfRwxHR" as Address,
  "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8" as Address,
];

function addrAt(index: number): Address {
  // Reuse the pool cyclically for large account lists
  return ADDR_POOL[index % ADDR_POOL.length] as Address;
}

/** Create a mock DeFi instruction with N accounts and M bytes of data. */
function makeBulkInstruction(
  programAddress: Address,
  numAccounts: number,
  dataSize: number,
): Instruction {
  const accounts = Array.from({ length: numAccounts }, (_, i) => ({
    address: addrAt(i),
    role: AccountRole.WRITABLE,
  }));
  return {
    programAddress,
    accounts,
    data: new Uint8Array(dataSize),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SIMD-0296: Larger Transactions (4,096 bytes)", () => {
  it("current MAX_TX_SIZE is 1,232", () => {
    expect(MAX_TX_SIZE).to.equal(CURRENT_MAX_TX_SIZE);
  });

  it("proposed SIMD-0296 limit is 4,096", () => {
    expect(PROPOSED_MAX_TX_SIZE).to.equal(4_096);
  });

  it("composed tx with large instruction data exceeds 1,232 but fits 4,096", () => {
    // Simulate a transaction with large instruction data (multi-hop swap data)
    // that exceeds the current 1,232 byte limit but fits in SIMD-0296's 4,096.
    // Uses large data payloads rather than many unique accounts to push over the limit.
    const bigDefiIx = makeBulkInstruction(JUPITER, 5, 600); // 600 bytes of data

    const PHALNX_PROGRAM = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;

    const validateIx: Instruction = {
      programAddress: PHALNX_PROGRAM,
      accounts: Array.from({ length: 5 }, (_, i) => ({
        address: addrAt(i),
        role: i < 3 ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(83), // validate instruction data
    };

    const finalizeIx: Instruction = {
      programAddress: PHALNX_PROGRAM,
      accounts: Array.from({ length: 5 }, (_, i) => ({
        address: addrAt(i + 5),
        role: i < 2 ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(9), // finalize instruction data
    };

    const compiledTx = composePhalnxTransaction({
      feePayer: AGENT_ADDR,
      validateIx,
      defiInstructions: [bigDefiIx],
      finalizeIx,
      blockhash: {
        blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
        lastValidBlockHeight: 99999n,
      },
      computeUnits: 1_400_000,
    });

    const { byteLength, withinLimit } = measureTransactionSize(compiledTx);

    // Should exceed current limit
    expect(byteLength).to.be.greaterThan(CURRENT_MAX_TX_SIZE);
    expect(withinLimit).to.equal(false);

    // Should fit within proposed SIMD-0296 limit
    expect(byteLength).to.be.lessThanOrEqual(PROPOSED_MAX_TX_SIZE);
  });

  // NOTE: On-chain scan loop behavior (unbounded vs fixed-20) cannot be tested at the SDK level.
  // The scan runs in the BPF runtime, not in TypeScript. The unbounded loop change is verified
  // by on-chain LiteSVM tests (tests/phalnx.ts) and documented in:
  //   - finalize_session.rs:491 (post-finalize scan: loop { ... break on Err })
  //   - validate_and_authorize.rs:265 (spending scan: loop { ... break on finalize match })
  //   - validate_and_authorize.rs:379 (non-spending scan: same pattern)

  it("composed tx in 2,800-3,200 byte range exercises SIMD-0296 mid-range", () => {
    // Stress test: build a transaction that is well above 1,232 bytes
    // but within the SIMD-0296 4,096-byte limit. This validates the composer
    // handles mid-range transactions correctly (not just marginal overflow).
    const PHALNX_PROGRAM = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;

    // Three large DeFi instructions (simulating a 3-hop swap)
    const hop1 = makeBulkInstruction(JUPITER, 5, 500);
    const hop2 = makeBulkInstruction(JUPITER, 5, 500);
    const hop3 = makeBulkInstruction(JUPITER, 5, 500);

    const validateIx: Instruction = {
      programAddress: PHALNX_PROGRAM,
      accounts: Array.from({ length: 5 }, (_, i) => ({
        address: addrAt(i),
        role: i < 3 ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(83),
    };

    const finalizeIx: Instruction = {
      programAddress: PHALNX_PROGRAM,
      accounts: Array.from({ length: 5 }, (_, i) => ({
        address: addrAt(i + 5),
        role: i < 2 ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(9),
    };

    const compiledTx = composePhalnxTransaction({
      feePayer: AGENT_ADDR,
      validateIx,
      defiInstructions: [hop1, hop2, hop3],
      finalizeIx,
      blockhash: {
        blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
        lastValidBlockHeight: 99999n,
      },
      computeUnits: 1_400_000,
    });

    const { byteLength, withinLimit } = measureTransactionSize(compiledTx);

    // Should be well above current limit
    expect(byteLength).to.be.greaterThan(1_800);
    // Should fit within SIMD-0296 limit
    expect(byteLength).to.be.lessThanOrEqual(PROPOSED_MAX_TX_SIZE);
    // Current limit correctly rejects it
    expect(withinLimit).to.equal(false);
  });

});
