/**
 * Kit SDK Devnet — Composed Transaction Tests
 *
 * Proves TransactionExecutor can compose, simulate, sign, and send
 * real transactions against devnet using Codama-generated builders.
 */

import { createHash } from "node:crypto";
import { expect } from "chai";
import {
  AccountRole,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type KeyPairSigner,
} from "@solana/kit";

import {
  createDevnetRpc,
  loadOwnerSigner,
  createFundedAgent,
  ensureStablecoinBalance,
  provisionVault,
  type ProvisionVaultResult,
} from "../../src/testing/devnet.js";

import { TransactionExecutor } from "../../src/transaction-executor.js";
import { getValidateAndAuthorizeInstructionAsync } from "../../src/generated/instructions/validateAndAuthorize.js";
import { getFinalizeSessionInstructionAsync } from "../../src/generated/instructions/finalizeSession.js";
import { resolveVaultState } from "../../src/state-resolver.js";
import { deriveAta } from "../../src/x402/transfer-builder.js";
import { computeScalarIntentDigest } from "../../src/seal/intent-digest.js";
import { USDC_MINT_DEVNET, PROTOCOL_TREASURY } from "../../src/types.js";

// Skip entire file if no devnet env
const SKIP = !process.env.ANCHOR_PROVIDER_URL;

// Mock-defi fixture program, DEPLOYED on devnet (tests/fixtures/mock-defi-src/,
// id mirrors tests/helpers/devnet-setup.ts MOCK_DEFI_PROGRAM_ID). V2's F-Q2
// requires EXACTLY ONE counted DeFi instruction between validate and finalize,
// and that ix's program_id must equal the authorized target_protocol. Real
// Jupiter needs live route accounts + liquidity (flaky); the fixture's
// `open_position` no-op is the canonical counted-but-zero-spend leg used by
// the on-chain suites for authorization-flow tests.
const MOCK_DEFI_PROGRAM =
  "2heRcfqPUcSiWpH1rAp2Zf4c4ZxfKmKaaVbJWGRa7Qm6" as Address;

/** Anchor discriminator: sha256("global:<name>")[0..8]. */
function anchorDisc(name: string): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
  );
}

/**
 * Mock-defi `open_position` — a true no-op (single agent signer, handler does
 * nothing). The counted DeFi leg of the sandwich: targeting the allowlisted
 * MOCK_DEFI_PROGRAM satisfies F-Q2 (defi_ix_count == 1) while moving zero
 * tokens, so finalize_session measures actual_spend == 0 (no SpendTracker is
 * created — see the `if (state.tracker)` guard in the state-update test).
 */
function buildMockDefiNoopIx(agent: KeyPairSigner): Instruction {
  return {
    programAddress: MOCK_DEFI_PROGRAM,
    accounts: [{ address: agent.address, role: AccountRole.READONLY_SIGNER }],
    data: anchorDisc("open_position"),
  };
}

/** Build the [validate, mock-defi no-op, finalize] sandwich for a stablecoin spend. */
async function buildSwapInstructions(
  rpc: Rpc<SolanaRpcApi>,
  agent: KeyPairSigner,
  vault: ProvisionVaultResult,
  vaultTokenAta: Address,
  protocolTreasuryAta: Address,
  amount: bigint,
) {
  // D-1 (Bucket 2): the on-chain verifier recomputes the canonical scalar
  // intent digest from validate_and_authorize's typed args (vault, agent,
  // token_mint, amount, target_protocol, network) and rejects a byte-mismatch
  // with ErrIntentDigestMismatch (6102). The target_protocol MUST be the
  // mock-defi program (the DeFi leg's program_id, which validate cross-checks
  // against target_protocol — ProtocolMismatch otherwise).
  const expectedIntentDigest = computeScalarIntentDigest({
    vault: vault.vaultAddress,
    agent: agent.address,
    tokenMint: USDC_MINT_DEVNET,
    amount,
    targetProtocol: MOCK_DEFI_PROGRAM,
    network: "devnet",
  });

  // PolicyVersionMismatch (6052): validate require!s expected_policy_version ==
  // the live policy.policy_version. Seating the OPERATOR agent (apply_agent_grant)
  // bumps the version, so a hardcoded 0n always mismatches — read it live.
  const { fetchPolicyConfig } =
    await import("../../src/generated/accounts/policyConfig.js");
  const livePolicy = await fetchPolicyConfig(rpc, vault.policyAddress);

  const validateIx = await getValidateAndAuthorizeInstructionAsync({
    agent,
    vault: vault.vaultAddress,
    agentSpendOverlay: vault.overlayPDA,
    vaultTokenAccount: vaultTokenAta,
    tokenMintAccount: USDC_MINT_DEVNET,
    // C-1 fix: fee accounts relocated to finalize_session.
    tokenMint: USDC_MINT_DEVNET,
    amount,
    targetProtocol: MOCK_DEFI_PROGRAM,
    expectedPolicyVersion: livePolicy.data.policyVersion,
    // AC-10 (Phase 4): fresh session always starts at nonce=0.
    expectedNonce: 0n,
    expectedIntentDigest,
  });

  // F-Q1a completeness: the no-op DeFi ix lists the agent signer, which is the
  // writable fee-payer in the compiled v0 message. validate's destination-
  // completeness guard requires every writable DeFi meta be resolvable in
  // remaining_accounts, so append the agent (mirrors seal() and sigil.ts).
  const validateIxWithRemaining: Instruction = {
    ...(validateIx as Instruction),
    accounts: [
      ...(validateIx as Instruction).accounts!,
      { address: agent.address, role: AccountRole.READONLY },
    ],
  };

  const defiIx = buildMockDefiNoopIx(agent);

  const finalizeIx = await getFinalizeSessionInstructionAsync({
    payer: agent,
    vault: vault.vaultAddress,
    session: (validateIx as any).accounts[5].address, // session PDA auto-derived by validate
    sessionRentRecipient: agent.address,
    agentSpendOverlay: vault.overlayPDA,
    vaultTokenAccount: vaultTokenAta,
    // C-1 fix: fees collected at finalize on the measured spend.
    protocolTreasuryTokenAccount: protocolTreasuryAta,
  });

  return {
    validateIx: validateIxWithRemaining,
    defiIx,
    finalizeIx: finalizeIx as Instruction,
  };
}

describe("Kit SDK Devnet — Composed Transaction", function () {
  if (SKIP) return;

  // 15 min: the `before` hook provisions a FULL_CAPABILITY (operator) vault,
  // which routes through the F-Q6 queue → on-chain 600s single-key timelock
  // floor → apply path (one real ~600s cluster-clock wait) on top of the
  // normal RPC roundtrips.
  this.timeout(900_000);

  let rpc: Rpc<SolanaRpcApi>;
  let owner: KeyPairSigner;
  let agent: KeyPairSigner;
  let vault: ProvisionVaultResult;
  let vaultTokenAta: Address;
  let protocolTreasuryAta: Address;

  before(async function () {
    rpc = createDevnetRpc();
    const { signer, bytes } = await loadOwnerSigner();
    owner = signer;
    agent = await createFundedAgent(rpc, owner);

    await ensureStablecoinBalance(
      process.env.ANCHOR_PROVIDER_URL!,
      bytes,
      USDC_MINT_DEVNET,
      2_000_000_000,
    );

    // On-chain V2 (initialize_vault.rs:123-126) requires ALLOWLIST mode (1) —
    // the permissive ALL/DENYLIST modes were deleted. validate_and_authorize
    // then rejects any target_protocol not in the allowlist (ProtocolNotAllowed)
    // and cross-checks the DeFi leg's program_id == target_protocol, so the
    // sandwich's DeFi program (the mock-defi fixture) MUST be allowlisted here.
    // Default capability is OPERATOR (FULL_CAPABILITY) → provisionVault routes
    // the agent through queue→wait(600s)→apply (one real timelock wait).
    vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
      protocols: [MOCK_DEFI_PROGRAM],
      dailySpendingCapUsd: 500_000_000n,
      // Unique high id so inscribe skips its first-unused-id probe. The shared
      // devnet wallet has many accumulated vaults and the public RPC's view can
      // be stale, so the probe otherwise picks an already-allocated id and init
      // fails with the system program's "account already in use" (custom 0x0).
      vaultId: BigInt(Date.now()),
    });

    vaultTokenAta = await deriveAta(vault.vaultAddress, USDC_MINT_DEVNET);
    protocolTreasuryAta = await deriveAta(PROTOCOL_TREASURY, USDC_MINT_DEVNET);
  });

  it("TransactionExecutor composes and simulates", async function () {
    const executor = new TransactionExecutor(rpc, agent);
    const { validateIx, defiIx, finalizeIx } = await buildSwapInstructions(
      rpc,
      agent,
      vault,
      vaultTokenAta,
      protocolTreasuryAta,
      1_000_000n,
    );

    const { compiledTx, computeUnits } = await executor.composeTransaction({
      feePayer: agent.address,
      validateIx,
      defiInstructions: [defiIx],
      finalizeIx,
      computeUnits: 400_000,
    });

    expect(compiledTx).to.exist;
    expect(computeUnits).to.equal(400_000);
  });

  it("TransactionExecutor.executeTransaction() succeeds", async function () {
    const executor = new TransactionExecutor(rpc, agent, {
      skipSimulation: true,
    });
    const { validateIx, defiIx, finalizeIx } = await buildSwapInstructions(
      rpc,
      agent,
      vault,
      vaultTokenAta,
      protocolTreasuryAta,
      1_000_000n,
    );

    const result = await executor.executeTransaction({
      feePayer: agent.address,
      validateIx,
      defiInstructions: [defiIx],
      finalizeIx,
      computeUnits: 400_000,
    });

    expect(result.signature).to.be.a("string");
    expect(result.signature.length).to.be.greaterThan(40);
  });

  it("vault state updates after composed transaction", async function () {
    await new Promise((r) => setTimeout(r, 2_000));

    const state = await resolveVaultState(
      rpc,
      vault.vaultAddress,
      agent.address,
    );

    expect(Number(state.vault.totalTransactions)).to.be.greaterThanOrEqual(1);

    if (state.tracker) {
      expect(Number(state.globalBudget.spent24h)).to.be.greaterThan(0);
    }
  });
});
