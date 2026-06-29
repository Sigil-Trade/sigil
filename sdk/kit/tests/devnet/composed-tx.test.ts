/**
 * Kit SDK Devnet — Composed Transaction Tests
 *
 * Proves TransactionExecutor can compose, simulate, sign, and send
 * real transactions against devnet using Codama-generated builders.
 *
 * The spending sandwich routes a REAL acquiring swap (mock-defi `swap_to_vault`)
 * as its counted DeFi leg: it pulls stablecoin out of the vault AND delivers a
 * different mint into a vault-owned output. On the deployed binary a spending
 * session (amount > 0) whose DeFi leg measures zero stablecoin movement is
 * rejected by the require-measurable-outcome guard (ErrUnmeasurableSpend 6115),
 * and every stablecoin-input spend must acquire a vault-owned output (M1
 * output-ownership ErrOutputNotVaultOwned 6112) — so a no-op leg can no longer
 * stand in for a spend. See `tests/devnet-fees.ts` (anchor) for the same pattern.
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
  setupSwapOutput,
  type ProvisionVaultResult,
  type SwapOutputFixture,
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
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/types.js";

// Skip entire file if no devnet env
const SKIP = !process.env.ANCHOR_PROVIDER_URL;

// Mock-defi fixture program, DEPLOYED on devnet (tests/fixtures/mock-defi-src/,
// id mirrors tests/helpers/devnet-setup.ts MOCK_DEFI_PROGRAM_ID). V2's F-Q2
// requires EXACTLY ONE counted DeFi instruction between validate and finalize,
// and that ix's program_id must equal the authorized target_protocol. Real
// Jupiter needs live route accounts + liquidity (flaky); the fixture's
// `swap_to_vault` ix is the canonical counted, MEASURABLE-spend leg used by the
// on-chain suites for spending-flow tests — it pulls stablecoin out of the vault
// (so finalize measures actual_spend > 0) AND delivers a different mint into a
// vault-owned output (so the M1 output-ownership gate, 6112, is satisfied).
const MOCK_DEFI_PROGRAM =
  "2heRcfqPUcSiWpH1rAp2Zf4c4ZxfKmKaaVbJWGRa7Qm6" as Address;

/** Anchor discriminator: sha256("global:<name>")[0..8]. */
function anchorDisc(name: string): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
  );
}

/**
 * Mock-defi `swap_to_vault(in_amount, out_amount)` — models an ACQUIRING swap
 * (kit-native mirror of tests/helpers/devnet-setup.ts `buildMockSwapToVaultIx`).
 * Leg 1 pulls `inAmount` of the stablecoin input out of `source` (the vault's
 * token ATA) via the agent's validate-time delegation, routing it to `inputSink`
 * (an agent-owned stablecoin ATA); leg 2 delivers `outAmount` of a DIFFERENT mint
 * from `outputSource` (an agent-owned reserve) into `vaultOutput` (the vault-owned
 * acquisition account finalize's M1 gate verifies increased). Both legs are
 * authorized by `authority` (the agent signer). Accounts/data layout mirrors the
 * fixture's `SwapToVault` struct exactly: [source, inputSink, outputSource,
 * vaultOutput, authority(signer), token_program]; data = 8-byte disc + u64
 * inAmount LE + u64 outAmount LE.
 */
function buildMockSwapToVaultIx(params: {
  source: Address;
  inputSink: Address;
  outputSource: Address;
  vaultOutput: Address;
  authority: Address;
  inAmount: bigint;
  outAmount: bigint;
}): Instruction {
  const data = new Uint8Array(24);
  data.set(anchorDisc("swap_to_vault"), 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, params.inAmount, true);
  view.setBigUint64(16, params.outAmount, true);
  return {
    programAddress: MOCK_DEFI_PROGRAM,
    accounts: [
      { address: params.source, role: AccountRole.WRITABLE },
      { address: params.inputSink, role: AccountRole.WRITABLE },
      { address: params.outputSource, role: AccountRole.WRITABLE },
      { address: params.vaultOutput, role: AccountRole.WRITABLE },
      { address: params.authority, role: AccountRole.READONLY_SIGNER },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data,
  };
}

/**
 * Build the [validate, mock-defi swap_to_vault, finalize] sandwich for a REAL
 * measurable stablecoin spend. `inAmount == amount` (the full measured spend, so
 * finalize charges the fee on `amount` exactly — mirrors `tests/devnet-fees.ts`
 * test 1 post-C-1), and `outAmount > 0` so the vault-owned output increases.
 */
async function buildSwapInstructions(
  rpc: Rpc<SolanaRpcApi>,
  agent: KeyPairSigner,
  vault: ProvisionVaultResult,
  vaultTokenAta: Address,
  protocolTreasuryAta: Address,
  swap: SwapOutputFixture,
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
    // M1 output-ownership pin (6112): validate snapshots this vault-owned,
    // non-input-mint account's pre-DeFi balance; finalize requires it INCREASED
    // when actual_spend > 0. Must be supplied to BOTH validate and finalize.
    outputSwapAccount: swap.vaultOutputAta,
    tokenMint: USDC_MINT_DEVNET,
    amount,
    targetProtocol: MOCK_DEFI_PROGRAM,
    expectedPolicyVersion: livePolicy.data.policyVersion,
    // AC-10 (Phase 4): fresh session always starts at nonce=0.
    expectedNonce: 0n,
    expectedIntentDigest,
  });

  // The counted DeFi leg: a real acquiring swap. inAmount == amount → the vault
  // stablecoin balance drops by `amount`, so finalize measures actual_spend ==
  // amount (> 0); outAmount > 0 → the vault-owned output increases, satisfying
  // the M1 gate (6112). Together these satisfy require-measurable-outcome (6115).
  const defiIx = buildMockSwapToVaultIx({
    source: vaultTokenAta,
    inputSink: swap.agentStablecoinAta,
    outputSource: swap.agentReserve,
    vaultOutput: swap.vaultOutputAta,
    authority: agent.address,
    inAmount: amount,
    outAmount: 1_000n,
  });

  // F-Q1a/F-Q1b completeness (6105 at validate, 6113 at finalize): every WRITABLE
  // meta of the counted DeFi ix — plus the fee payer (the agent, which is
  // compiled-writable in every v0 message regardless of its declared role) — must
  // be resolvable as a remaining account on BOTH wrapper ixs so the guard can
  // read each account's owner byte. Fed READONLY (the compiled message de-dups by
  // pubkey, keeping the DeFi ix's WRITABLE role). Mirrors seal()'s satisfier and
  // the anchor authorizeAndFinalize autoRemaining set exactly.
  const seen = new Set<Address>();
  const completenessMetas: { address: Address; role: AccountRole }[] = [];
  for (const acc of defiIx.accounts ?? []) {
    if (acc.role !== AccountRole.WRITABLE) continue;
    if (seen.has(acc.address)) continue;
    seen.add(acc.address);
    completenessMetas.push({
      address: acc.address,
      role: AccountRole.READONLY,
    });
  }
  if (!seen.has(agent.address)) {
    seen.add(agent.address);
    completenessMetas.push({
      address: agent.address,
      role: AccountRole.READONLY,
    });
  }

  const validateIxWithRemaining: Instruction = {
    ...(validateIx as Instruction),
    accounts: [...(validateIx as Instruction).accounts!, ...completenessMetas],
  };

  const finalizeIx = await getFinalizeSessionInstructionAsync({
    payer: agent,
    vault: vault.vaultAddress,
    session: (validateIx as any).accounts[5].address, // session PDA auto-derived by validate
    sessionRentRecipient: agent.address,
    agentSpendOverlay: vault.overlayPDA,
    vaultTokenAccount: vaultTokenAta,
    // M1 output-ownership pin (6112): finalize verifies this EXACT vault-owned
    // account increased vs the validate-time snapshot when actual_spend > 0.
    outputSwapAccount: swap.vaultOutputAta,
    // C-1 fix: fees collected at finalize on the measured spend.
    protocolTreasuryTokenAccount: protocolTreasuryAta,
  });

  // F-Q1b finalize-side completeness (6113): finalize's per-recipient cap + floor
  // sum walk the SAME writable DeFi metas validate does, so feed it the identical
  // READONLY set.
  const finalizeIxWithRemaining: Instruction = {
    ...(finalizeIx as Instruction),
    accounts: [...(finalizeIx as Instruction).accounts!, ...completenessMetas],
  };

  return {
    validateIx: validateIxWithRemaining,
    defiIx,
    finalizeIx: finalizeIxWithRemaining,
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
  let swap: SwapOutputFixture;

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

    // Stand up the acquiring-swap fixture ONCE: a fresh non-stablecoin output
    // mint, a vault-owned ATA receiving that output (the M1 6112 acquisition),
    // an agent-owned reserve funding the swap's output leg, and the agent's
    // stablecoin ATA (the swap's leg-1 input sink). The single real spend
    // (executeTransaction test) reuses these; the compose-only test never
    // executes, so one fixture suffices.
    swap = await setupSwapOutput(
      process.env.ANCHOR_PROVIDER_URL!,
      bytes,
      vault.vaultAddress,
      agent.address,
      USDC_MINT_DEVNET,
    );
  });

  it("TransactionExecutor composes and simulates", async function () {
    const executor = new TransactionExecutor(rpc, agent);
    const { validateIx, defiIx, finalizeIx } = await buildSwapInstructions(
      rpc,
      agent,
      vault,
      vaultTokenAta,
      protocolTreasuryAta,
      swap,
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
      swap,
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
