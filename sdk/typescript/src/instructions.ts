import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type {
  AgentShield,
  InitializeVaultParams,
  UpdatePolicyParams,
  QueuePolicyUpdateParams,
  AgentTransferParams,
  AuthorizeParams,
} from "./types";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
} from "./accounts";

export function buildInitializeVault(
  program: Program<AgentShield>,
  owner: PublicKey,
  params: InitializeVaultParams,
) {
  const [vault] = getVaultPDA(owner, params.vaultId, program.programId);
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);

  return program.methods
    .initializeVault(
      params.vaultId,
      params.dailySpendingCapUsd,
      params.maxTransactionSizeUsd,
      params.protocolMode ?? 0,
      params.protocols ?? [],
      params.maxLeverageBps,
      params.maxConcurrentPositions,
      params.developerFeeRate ?? 0,
      params.maxSlippageBps ?? 100,
      params.timelockDuration ?? new BN(0),
      params.allowedDestinations ?? [],
    )
    .accounts({
      owner,
      vault,
      policy,
      tracker,
      feeDestination: params.feeDestination,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildDepositFunds(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  amount: BN,
) {
  const ownerTokenAccount = getAssociatedTokenAddressSync(mint, owner);
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);

  return program.methods.depositFunds(amount).accounts({
    owner,
    vault,
    mint,
    ownerTokenAccount,
    vaultTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  } as any);
}

export function buildRegisterAgent(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
) {
  return program.methods.registerAgent(agent).accounts({
    owner,
    vault,
  } as any);
}

export function buildUpdatePolicy(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  params: UpdatePolicyParams,
) {
  const [policy] = getPolicyPDA(vault, program.programId);

  return program.methods
    .updatePolicy(
      params.dailySpendingCapUsd ?? null,
      params.maxTransactionSizeUsd ?? null,
      params.protocolMode ?? null,
      params.protocols ?? null,
      params.maxLeverageBps ?? null,
      params.canOpenPositions ?? null,
      params.maxConcurrentPositions ?? null,
      params.developerFeeRate ?? null,
      params.maxSlippageBps ?? null,
      params.timelockDuration ?? null,
      params.allowedDestinations ?? null,
    )
    .accounts({
      owner,
      vault,
      policy,
    } as any);
}

/**
 * Build a validate_and_authorize instruction.
 */
export function buildValidateAndAuthorize(
  program: Program<AgentShield>,
  agent: PublicKey,
  vault: PublicKey,
  vaultTokenAccount: PublicKey,
  params: AuthorizeParams,
  protocolTreasuryTokenAccount?: PublicKey | null,
  feeDestinationTokenAccount?: PublicKey | null,
  outputStablecoinAccount?: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);
  const [session] = getSessionPDA(
    vault,
    agent,
    params.tokenMint,
    program.programId,
  );

  return program.methods
    .validateAndAuthorize(
      params.actionType as any,
      params.tokenMint,
      params.amount,
      params.targetProtocol,
      params.leverageBps ?? null,
    )
    .accounts({
      agent,
      vault,
      policy,
      tracker,
      session,
      vaultTokenAccount,
      tokenMintAccount: params.tokenMint,
      protocolTreasuryTokenAccount: protocolTreasuryTokenAccount ?? null,
      feeDestinationTokenAccount: feeDestinationTokenAccount ?? null,
      outputStablecoinAccount: outputStablecoinAccount ?? null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildFinalizeSession(
  program: Program<AgentShield>,
  payer: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
  success: boolean,
  vaultTokenAccount: PublicKey,
  outputStablecoinAccount?: PublicKey,
) {
  const [session] = getSessionPDA(vault, agent, tokenMint, program.programId);
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);

  return program.methods.finalizeSession(success).accounts({
    payer,
    vault,
    session,
    sessionRentRecipient: agent,
    policy,
    tracker,
    vaultTokenAccount,
    outputStablecoinAccount: outputStablecoinAccount ?? null,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  } as any);
}

export function buildRevokeAgent(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
) {
  return program.methods.revokeAgent().accounts({
    owner,
    vault,
  } as any);
}

export function buildReactivateVault(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  newAgent?: PublicKey | null,
) {
  return program.methods.reactivateVault(newAgent ?? null).accounts({
    owner,
    vault,
  } as any);
}

export function buildWithdrawFunds(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  mint: PublicKey,
  amount: BN,
) {
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);
  const ownerTokenAccount = getAssociatedTokenAddressSync(mint, owner);

  return program.methods.withdrawFunds(amount).accounts({
    owner,
    vault,
    mint,
    vaultTokenAccount,
    ownerTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as any);
}

export function buildCloseVault(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);

  return program.methods.closeVault().accounts({
    owner,
    vault,
    policy,
    tracker,
    systemProgram: SystemProgram.programId,
  } as any);
}

export function buildQueuePolicyUpdate(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  params: QueuePolicyUpdateParams,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [pendingPolicy] = getPendingPolicyPDA(vault, program.programId);

  return program.methods
    .queuePolicyUpdate(
      params.dailySpendingCapUsd ?? null,
      params.maxTransactionAmountUsd ?? null,
      params.protocolMode ?? null,
      params.protocols ?? null,
      params.maxLeverageBps ?? null,
      params.canOpenPositions ?? null,
      params.maxConcurrentPositions ?? null,
      params.developerFeeRate ?? null,
      params.maxSlippageBps ?? null,
      params.timelockDuration ?? null,
      params.allowedDestinations ?? null,
    )
    .accounts({
      owner,
      vault,
      policy,
      pendingPolicy,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildApplyPendingPolicy(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [pendingPolicy] = getPendingPolicyPDA(vault, program.programId);

  return program.methods.applyPendingPolicy().accounts({
    owner,
    vault,
    policy,
    pendingPolicy,
  } as any);
}

export function buildCancelPendingPolicy(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [pendingPolicy] = getPendingPolicyPDA(vault, program.programId);

  return program.methods.cancelPendingPolicy().accounts({
    owner,
    vault,
    pendingPolicy,
  } as any);
}

/**
 * Build an agent_transfer instruction.
 */
export function buildAgentTransfer(
  program: Program<AgentShield>,
  agent: PublicKey,
  vault: PublicKey,
  params: AgentTransferParams,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);

  return program.methods.agentTransfer(params.amount).accounts({
    agent,
    vault,
    policy,
    tracker,
    vaultTokenAccount: params.vaultTokenAccount,
    tokenMintAccount: params.tokenMintAccount,
    destinationTokenAccount: params.destinationTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
    protocolTreasuryTokenAccount: params.protocolTreasuryTokenAccount ?? null,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as any);
}

/**
 * Build a sync_positions instruction.
 * Owner-only: corrects the vault's open position counter
 * after keeper-executed trigger orders or filled limit orders.
 */
export function buildSyncPositions(
  program: Program<AgentShield>,
  owner: PublicKey,
  vault: PublicKey,
  actualPositions: number,
) {
  return program.methods.syncPositions(actualPositions).accounts({
    owner,
    vault,
  } as any);
}
