/**
 * Kit SDK Devnet — Vault Lifecycle Tests
 *
 * Proves Codama-generated instruction builders and account decoders
 * work against the real deployed program.
 */

import { expect } from "chai";
import type { Address, Rpc, SolanaRpcApi, KeyPairSigner } from "@solana/kit";

import {
  createDevnetRpc,
  loadOwnerSigner,
  createFundedAgent,
  ensureStablecoinBalance,
  provisionVault,
  sendKitTransaction,
  type ProvisionVaultResult,
} from "../../src/testing/devnet.js";

import { resolveVaultState } from "../../src/state-resolver.js";
import { fetchMaybeAgentVault } from "../../src/generated/accounts/agentVault.js";
import { getQueuePolicyUpdateInstructionAsync } from "../../src/generated/instructions/queuePolicyUpdate.js";
import { getCancelPendingPolicyInstructionAsync } from "../../src/generated/instructions/cancelPendingPolicy.js";
import { USDC_MINT_DEVNET, FULL_CAPABILITY } from "../../src/types.js";
import type { Instruction } from "@solana/kit";

// Skip entire file if no devnet env
const SKIP = !process.env.ANCHOR_PROVIDER_URL;

describe("Kit SDK Devnet — Vault Lifecycle", function () {
  if (SKIP) return;

  this.timeout(300_000);

  let rpc: Rpc<SolanaRpcApi>;
  let owner: KeyPairSigner;
  let agent: KeyPairSigner;
  let vault: ProvisionVaultResult;
  let rpcUrl: string;

  before(async function () {
    rpc = createDevnetRpc();
    rpcUrl = process.env.ANCHOR_PROVIDER_URL!;
    const { signer, bytes } = await loadOwnerSigner();
    owner = signer;

    agent = await createFundedAgent(rpc, owner);
    await ensureStablecoinBalance(
      rpcUrl,
      bytes,
      USDC_MINT_DEVNET,
      2_000_000_000,
    );
  });

  it("provisions vault via Codama instruction builders", async function () {
    vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
      skipDeposit: false,
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      protocolMode: 0, // allow all
    });

    // Verify the vault account exists on-chain
    const accountInfo = await rpc
      .getAccountInfo(vault.vaultAddress, { encoding: "base64" })
      .send();
    expect(accountInfo.value).to.not.be.null;
  });

  it("resolveVaultState() decodes on-chain accounts", async function () {
    const state = await resolveVaultState(
      rpc,
      vault.vaultAddress,
      agent.address,
    );

    expect(state.vault).to.exist;
    expect(state.policy).to.exist;

    // Check owner matches
    const ownerFromVault = state.vault.owner;
    expect(ownerFromVault).to.equal(owner.address);

    // Check agent is registered with FULL_CAPABILITY
    const agentEntry = state.vault.agents.find(
      (a) => a.pubkey === agent.address,
    );
    expect(agentEntry).to.exist;
    expect(agentEntry!.capability).to.equal(FULL_CAPABILITY);

    // Check daily spending cap
    expect(Number(state.policy.dailySpendingCapUsd)).to.equal(500_000_000);
  });

  it("fetchMaybeAgentVault() returns decoded vault", async function () {
    const fetchedVault = await fetchMaybeAgentVault(rpc, vault.vaultAddress);
    expect(fetchedVault.exists).to.be.true;
    if (fetchedVault.exists) {
      expect(fetchedVault.data.owner).to.equal(owner.address);

      const agentEntry = fetchedVault.data.agents.find(
        (a) => a.pubkey === agent.address,
      );
      expect(agentEntry).to.exist;
    }
  });

  it("resolveVaultState() returns budget info", async function () {
    const state = await resolveVaultState(
      rpc,
      vault.vaultAddress,
      agent.address,
    );

    expect(Number(state.globalBudget.cap)).to.be.greaterThan(0);
    expect(state.globalBudget.spent24h).to.equal(0n);
    expect(state.globalBudget.remaining).to.deep.equal(state.globalBudget.cap);
  });

  it("queuePolicyUpdate + cancel via Codama builder (can't apply on devnet — 30min timelock)", async function () {
    const newCap = 1_000_000_000n; // $1000

    // Phase 2 TA-19: re-compute the merged policy digest off-chain and bind
    // it to the queue. We fetch live policy + vault so the projection is
    // accurate; only daily_spending_cap_usd is changing in this test.
    const { fetchAgentVault } =
      await import("../../src/generated/accounts/agentVault.js");
    const { fetchPolicyConfig } =
      await import("../../src/generated/accounts/policyConfig.js");
    const { computePolicyPreviewDigest } =
      await import("../../src/policy/compute-policy-preview-digest.js");
    const livePolicy = await fetchPolicyConfig(rpc, vault.policyAddress);
    const liveVault = await fetchAgentVault(rpc, vault.vaultAddress);
    const newPolicyPreviewDigest = computePolicyPreviewDigest({
      dailySpendingCapUsd: newCap, // changed
      maxTransactionSizeUsd: livePolicy.data.maxTransactionSizeUsd,
      maxSlippageBps: livePolicy.data.maxSlippageBps,
      developerFeeRate: livePolicy.data.developerFeeRate,
      protocolMode: livePolicy.data.protocolMode,
      protocols: livePolicy.data.protocols,
      destinationMode: livePolicy.data.destinationMode,
      allowedDestinations: livePolicy.data.allowedDestinations,
      timelockDuration: livePolicy.data.timelockDuration,
      sessionExpirySeconds: livePolicy.data.sessionExpirySeconds,
      observeOnly: liveVault.data.observeOnly,
      hasPostAssertions: livePolicy.data.hasPostAssertions,
      // PEN-CROSS-2: created_at_slot is immutable post-init.
      createdAtSlot: livePolicy.data.createdAtSlot,
      // TA-05 (Phase 3): operating_hours is policy-owned.
      operatingHours: livePolicy.data.operatingHours,
      // TA-07/17 (Phase 3): pass-through from live policy.
      autoPromoteGrays: livePolicy.data.autoPromoteGrays,
      autoRevokeThreshold: livePolicy.data.autoRevokeThreshold,
      // TA-12/14 (Phase 5): pass-through from live policy.
      stableBalanceFloor: livePolicy.data.stableBalanceFloor,
      perRecipientDailyCapUsd: livePolicy.data.perRecipientDailyCapUsd,
    });

    const queueIx = await getQueuePolicyUpdateInstructionAsync({
      owner,
      vault: vault.vaultAddress,
      dailySpendingCapUsd: newCap,
      maxTransactionAmountUsd: null,
      protocolMode: null,
      protocols: null,
      developerFeeRate: null,
      maxSlippageBps: null,
      timelockDuration: null,
      allowedDestinations: null,
      sessionExpirySeconds: null,
      hasProtocolCaps: null,
      protocolCaps: null,
      destinationMode: null,
      operatingHours: null,
      // TA-12/14 (Phase 5): non-elevated path — pass null for fall-through.
      stableBalanceFloor: null,
      perRecipientDailyCapUsd: null,
      // G6 (audit 2026-05-18 cosign opt-in): non-elevated path —
      // pass null for fall-through. cosign opt-in is left at the
      // initial-vault value for this lifecycle test.
      cosignRequired: null,
      // D-5 (Bucket 2 audit 2026-05-21, F-RP3-1): non-elevated path —
      // pass null for fall-through. Owner sets cosign_session_pubkey via
      // a dedicated elevated helper that verifies the new pubkey isn't a
      // Sigil-protected PDA at queue time.
      cosignSessionPubkey: null,
      // TA-09 (Phase 3): zero pubkey for non-elevated path.
      cosignSession: "11111111111111111111111111111111" as unknown as Address,
      newPolicyPreviewDigest,
    });

    await sendKitTransaction(rpc, owner, [queueIx as Instruction]);

    // Cancel the pending update (can't wait 30min on devnet)
    const cancelIx = await getCancelPendingPolicyInstructionAsync({
      owner,
      vault: vault.vaultAddress,
    });
    await sendKitTransaction(rpc, owner, [cancelIx as Instruction]);

    // Verify the policy was NOT updated (cancelled)
    const state = await resolveVaultState(
      rpc,
      vault.vaultAddress,
      agent.address,
    );
    // Cap should be unchanged (queue was cancelled, not applied)
    expect(Number(state.policy.dailySpendingCapUsd)).to.not.equal(
      Number(newCap),
    );
  });
});
