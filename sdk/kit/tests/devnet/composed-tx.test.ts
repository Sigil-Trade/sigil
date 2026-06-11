/**
 * Kit SDK Devnet — Composed Transaction Tests
 *
 * Proves TransactionExecutor can compose, simulate, sign, and send
 * real transactions against devnet using Codama-generated builders.
 */

import { expect } from "chai";
import {
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
import {
  USDC_MINT_DEVNET,
  PROTOCOL_TREASURY,
  JUPITER_PROGRAM_ADDRESS,
} from "../../src/types.js";

// Skip entire file if no devnet env
const SKIP = !process.env.ANCHOR_PROVIDER_URL;

/** Build validate + finalize instructions for a stablecoin swap. */
async function buildSwapInstructions(
  agent: KeyPairSigner,
  vault: ProvisionVaultResult,
  vaultTokenAta: Address,
  protocolTreasuryAta: Address,
  amount: bigint,
) {
  // D-1 (Bucket 2): the on-chain verifier recomputes the canonical scalar
  // intent digest from validate_and_authorize's typed args (vault, agent,
  // token_mint, amount, target_protocol, network) and rejects a byte-mismatch
  // with ErrIntentDigestMismatch (6102). Compute the real digest here — a
  // zero-filled placeholder would always reject. Must mirror exactly the
  // scalar args passed to the instruction below.
  const expectedIntentDigest = computeScalarIntentDigest({
    vault: vault.vaultAddress,
    agent: agent.address,
    tokenMint: USDC_MINT_DEVNET,
    amount,
    targetProtocol: JUPITER_PROGRAM_ADDRESS,
    network: "devnet",
  });

  const validateIx = await getValidateAndAuthorizeInstructionAsync({
    agent,
    vault: vault.vaultAddress,
    agentSpendOverlay: vault.overlayPDA,
    vaultTokenAccount: vaultTokenAta,
    tokenMintAccount: USDC_MINT_DEVNET,
    protocolTreasuryTokenAccount: protocolTreasuryAta,
    tokenMint: USDC_MINT_DEVNET,
    amount,
    targetProtocol: JUPITER_PROGRAM_ADDRESS,
    expectedPolicyVersion: 0n,
    // AC-10 (Phase 4): fresh session always starts at nonce=0.
    expectedNonce: 0n,
    expectedIntentDigest,
  });

  const finalizeIx = await getFinalizeSessionInstructionAsync({
    payer: agent,
    vault: vault.vaultAddress,
    session: (validateIx as any).accounts[5].address, // session PDA auto-derived by validate
    sessionRentRecipient: agent.address,
    agentSpendOverlay: vault.overlayPDA,
    vaultTokenAccount: vaultTokenAta,
  });

  return {
    validateIx: validateIx as Instruction,
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
    // then rejects any target_protocol not in the allowlist (ProtocolNotAllowed),
    // so the swap target (Jupiter) MUST be allowlisted here. Default
    // capability is OPERATOR (FULL_CAPABILITY) → provisionVault routes the
    // agent through queue→wait(600s)→apply (one real timelock wait).
    vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
      protocols: [JUPITER_PROGRAM_ADDRESS],
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
    const { validateIx, finalizeIx } = await buildSwapInstructions(
      agent,
      vault,
      vaultTokenAta,
      protocolTreasuryAta,
      1_000_000n,
    );

    const { compiledTx, computeUnits } = await executor.composeTransaction({
      feePayer: agent.address,
      validateIx,
      defiInstructions: [],
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
    const { validateIx, finalizeIx } = await buildSwapInstructions(
      agent,
      vault,
      vaultTokenAta,
      protocolTreasuryAta,
      1_000_000n,
    );

    const result = await executor.executeTransaction({
      feePayer: agent.address,
      validateIx,
      defiInstructions: [],
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
