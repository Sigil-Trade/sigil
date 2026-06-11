/**
 * AL3 — `SealResult.intentDigest` integration test.
 *
 * The unit suite at `tests/intent-digest.test.ts` verifies the standalone
 * helper produces the right hash for synthesized inputs. This file
 * verifies the FULL `seal()` pipeline populates `result.intentDigest`
 * AND that the populated digest is byte-equal to what
 * `computeSealInputDigest(...)` returns when called on the same
 * pre-filter projection.
 *
 * Why this matters
 * ────────────────
 * Two classes of regression the unit suite cannot catch:
 *   1. `seal()` forgets to call `computeSealInputDigest` — the helper
 *      is correct, but `SealResult.intentDigest` ships empty or stale.
 *      ISC-69 + ISC-70 explicitly call out this risk.
 *   2. `seal()` calls the helper with the WRONG inputs — for example,
 *      hashing the post-rewrite vault-ATA bundle instead of the user-
 *      approved agent-ATA bundle. The helper output would be correct
 *      for what it was given, but it would no longer mean "the intent
 *      the user approved".
 *
 * Negative path locks the tamper-detection contract: a different
 * SealParams (different recipient/amount/etc) MUST produce a different
 * `SealResult.intentDigest`. This is what makes the digest useful for
 * preview→execute binding.
 *
 * Implementation note: `seal()` filters out COMPUTE_BUDGET and SYSTEM
 * program instructions BEFORE hashing (`seal.ts:514-518`). Tests that
 * want byte-equality with the helper MUST apply the same filter, OR
 * pass instructions that don't include those programs. We choose the
 * latter — the suite uses a real Jupiter instruction so the input
 * survives the filter unmodified.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";

import { seal, type SealParams } from "../../src/seal.js";
import { computeSealInputDigest } from "../../src/seal/intent-digest.js";
import {
  createMockAgent,
  createMockVaultState,
} from "../../src/testing/index.js";
import { USDC_MINT_DEVNET } from "../../src/types.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
const FEE_DEST = "11111111111111111111111111111115" as Address;
const RECIPIENT_A = "DRiP2Pn2K6fuMLKQmt5rZWxa91q2hHC1mU9hZuMHFmGw" as Address;
const RECIPIENT_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

function jupiterIx(recipient: Address = RECIPIENT_A): Instruction {
  return {
    programAddress: JUPITER,
    accounts: [
      { address: VAULT, role: AccountRole.WRITABLE_SIGNER },
      { address: recipient, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([1, 2, 3, 4]),
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function baseParams(overrides?: Partial<SealParams>): SealParams {
  return {
    vault: VAULT,
    agent: createMockAgent(AGENT_ADDR),
    instructions: [jupiterIx()],
    rpc: {} as never,
    network: "devnet",
    tokenMint: USDC_MINT_DEVNET,
    amount: 500_000_000n, // $500
    targetProtocol: JUPITER,
    cachedState: createMockVaultState({
      vault: VAULT,
      agent: AGENT_ADDR,
      owner: OWNER_ADDR,
      feeDestination: FEE_DEST,
    }),
    blockhash: {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    },
    addressLookupTables: {},
    ...overrides,
  };
}

// ─── Happy path: seal() populates intentDigest correctly ───────────────────

describe("AL3 — SealResult.intentDigest integration (Phase 9 Batch I)", () => {
  it("happy path — seal() populates intentDigest with a 32-byte value", async () => {
    const result = await seal(baseParams());
    expect(result.intentDigest).to.exist;
    expect(result.intentDigest).to.be.instanceOf(Uint8Array);
    expect(result.intentDigest).to.have.lengthOf(32);
  });

  it("happy path — SealResult.intentDigest byte-equals computeSealInputDigest(params)", async () => {
    // ISC-69 + ISC-70: the published digest MUST be the same hash the
    // helper would produce on the same inputs. seal() must not forget
    // to call the helper, nor pass it stale/mutated data.
    const params = baseParams();
    const result = await seal(params);

    const helperDigest = computeSealInputDigest({
      vault: params.vault,
      agent: params.agent.address,
      tokenMint: params.tokenMint,
      amount: params.amount,
      targetProtocol: params.targetProtocol,
      network: params.network,
      // The Jupiter ix already survives seal()'s filter (it's neither
      // ComputeBudget nor SystemProgram), so we pass it through as-is.
      instructions: params.instructions,
    });

    expect(toHex(result.intentDigest)).to.equal(toHex(helperDigest));
  });

  it("happy path — determinism across two seal() calls with identical params", async () => {
    // Locks the "no per-call randomness" contract. Without this, a
    // future commit could mistakenly bind a correlationId or wall-clock
    // value into the digest and silently break preview→execute binding.
    const a = await seal(baseParams());
    const b = await seal(baseParams());
    expect(toHex(a.intentDigest)).to.equal(toHex(b.intentDigest));
  });

  it("happy path — non-spending seal (amount=0n) also populates intentDigest", async () => {
    // A non-spending seal still needs an intentDigest. The owner may
    // be approving a read-only DeFi action (deposit metadata, registry
    // update) and the digest still binds the bundle they saw.
    const params = baseParams({ amount: 0n });
    const result = await seal(params);
    expect(result.intentDigest).to.have.lengthOf(32);
    const helperDigest = computeSealInputDigest({
      vault: params.vault,
      agent: params.agent.address,
      tokenMint: params.tokenMint,
      amount: params.amount,
      targetProtocol: params.targetProtocol,
      network: params.network,
      instructions: params.instructions,
    });
    expect(toHex(result.intentDigest)).to.equal(toHex(helperDigest));
  });
});

// ─── Negative path: tampering at execute-time changes the digest ───────────

describe("AL3 — tampering detection at executeAndConfirm time", () => {
  it("recipient swap: preview digest ≠ submitted digest", async () => {
    // The owner sees and approves a bundle sending to RECIPIENT_A,
    // captures its digest (typical preview UI flow), then the agent
    // submits a bundle sending to RECIPIENT_B. The submitted SealResult
    // MUST carry a different intentDigest — that mismatch is the
    // signal a preview-verifying caller looks for.
    const previewParams = baseParams({
      instructions: [jupiterIx(RECIPIENT_A)],
    });
    const previewDigest = computeSealInputDigest({
      vault: previewParams.vault,
      agent: previewParams.agent.address,
      tokenMint: previewParams.tokenMint,
      amount: previewParams.amount,
      targetProtocol: previewParams.targetProtocol,
      network: previewParams.network,
      instructions: previewParams.instructions,
    });

    const submittedParams = baseParams({
      instructions: [jupiterIx(RECIPIENT_B)],
    });
    const submitted = await seal(submittedParams);

    expect(toHex(submitted.intentDigest)).to.not.equal(toHex(previewDigest));
  });

  it("amount tamper: $500 preview vs $5000 submit produces different digests", async () => {
    const previewDigest = computeSealInputDigest({
      vault: VAULT,
      agent: AGENT_ADDR,
      tokenMint: USDC_MINT_DEVNET,
      amount: 500_000_000n, // $500
      targetProtocol: JUPITER,
      network: "devnet",
      instructions: [jupiterIx()],
    });

    const submitted = await seal(
      baseParams({
        amount: 5_000_000_000n, // $5000
        // Bump the daily cap so the seal succeeds — we want to verify
        // the DIGEST changes, not assert the cap check.
        cachedState: createMockVaultState({
          vault: VAULT,
          agent: AGENT_ADDR,
          owner: OWNER_ADDR,
          dailyCap: 10_000_000_000n, // $10,000
        }),
      }),
    );

    expect(toHex(submitted.intentDigest)).to.not.equal(toHex(previewDigest));
  });

  it("ix data tamper: same shape, different bytes → different digest", async () => {
    const previewDigest = computeSealInputDigest({
      vault: VAULT,
      agent: AGENT_ADDR,
      tokenMint: USDC_MINT_DEVNET,
      amount: 500_000_000n,
      targetProtocol: JUPITER,
      network: "devnet",
      instructions: [
        {
          programAddress: JUPITER,
          accounts: [
            { address: VAULT, role: AccountRole.WRITABLE_SIGNER },
            { address: RECIPIENT_A, role: AccountRole.WRITABLE },
          ],
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    });

    const submitted = await seal(
      baseParams({
        instructions: [
          {
            programAddress: JUPITER,
            accounts: [
              { address: VAULT, role: AccountRole.WRITABLE_SIGNER },
              { address: RECIPIENT_A, role: AccountRole.WRITABLE },
            ],
            data: new Uint8Array([1, 2, 3, 5]), // last byte flipped
          },
        ],
      }),
    );

    expect(toHex(submitted.intentDigest)).to.not.equal(toHex(previewDigest));
  });

  it("network mismatch: devnet preview vs mainnet submit produces different digests (AL4 binding)", async () => {
    // The network_id byte at canonical position 2 is what stops a
    // devnet-approved bundle from being replayed on mainnet. We can't
    // actually seal() on mainnet without mainnet fixtures (token mint
    // diverges), so the load-bearing assertion compares two helper
    // digests with only network flipped. The integration check is
    // covered by the same-network happy path above — together they
    // pin the contract.
    const sameInputDifferentNetwork = (network: "devnet" | "mainnet") =>
      computeSealInputDigest({
        vault: VAULT,
        agent: AGENT_ADDR,
        tokenMint: USDC_MINT_DEVNET,
        amount: 500_000_000n,
        targetProtocol: JUPITER,
        network,
        instructions: [jupiterIx()],
      });

    const devnet = sameInputDifferentNetwork("devnet");
    const mainnet = sameInputDifferentNetwork("mainnet");
    expect(toHex(devnet)).to.not.equal(toHex(mainnet));
  });
});
