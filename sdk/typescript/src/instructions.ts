import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type {
  Phalnx,
  InitializeVaultParams,
  UpdatePolicyParams,
  QueuePolicyUpdateParams,
  AgentTransferParams,
  AuthorizeParams,
  ConstraintEntry,
} from "./types";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getEscrowPDA,
  getConstraintsPDA,
  getPendingConstraintsPDA,
  getAgentOverlayPDA,
} from "./accounts";

export function buildInitializeVault(
  program: Program<Phalnx>,
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
      params.protocolCaps ?? [],
    )
    .accounts({
      owner,
      vault,
      policy,
      tracker,
      agentSpendOverlay: getAgentOverlayPDA(vault, program.programId)[0],
      feeDestination: params.feeDestination,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildDepositFunds(
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
  permissions: BN,
  spendingLimitUsd: BN = new BN(0),
) {
  const [agentSpendOverlay] = getAgentOverlayPDA(vault, program.programId);
  return program.methods
    .registerAgent(agent, permissions, spendingLimitUsd)
    .accounts({
      owner,
      vault,
      agentSpendOverlay,
    } as any);
}

export function buildUpdatePolicy(
  program: Program<Phalnx>,
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
      params.sessionExpirySlots ?? null,
      params.hasProtocolCaps ?? null,
      params.protocolCaps ?? null,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  agentToRemove: PublicKey,
) {
  return program.methods.revokeAgent(agentToRemove).accounts({
    owner,
    vault,
  } as any);
}

export function buildReactivateVault(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  newAgent?: PublicKey | null,
  newAgentPermissions?: BN | null,
) {
  return program.methods
    .reactivateVault(newAgent ?? null, newAgentPermissions ?? null)
    .accounts({
      owner,
      vault,
    } as any);
}

export function buildWithdrawFunds(
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
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
      params.sessionExpirySlots ?? null,
      params.hasProtocolCaps ?? null,
      params.protocolCaps ?? null,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
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
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  actualPositions: number,
) {
  return program.methods.syncPositions(actualPositions).accounts({
    owner,
    vault,
  } as any);
}

// --- Multi-Agent Instructions ---

export function buildUpdateAgentPermissions(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
  newPermissions: BN,
  spendingLimitUsd: BN = new BN(0),
) {
  const [policy] = getPolicyPDA(vault, program.programId);

  return program.methods
    .updateAgentPermissions(agent, newPermissions, spendingLimitUsd)
    .accounts({
      owner,
      vault,
      policy,
    } as any);
}

// --- Escrow Instructions ---

export function buildCreateEscrow(
  program: Program<Phalnx>,
  agent: PublicKey,
  sourceVault: PublicKey,
  destinationVault: PublicKey,
  escrowId: BN,
  amount: BN,
  expiresAt: BN,
  conditionHash: number[],
  tokenMint: PublicKey,
  sourceVaultAta: PublicKey,
  protocolTreasuryAta?: PublicKey | null,
  feeDestinationAta?: PublicKey | null,
) {
  const [policy] = getPolicyPDA(sourceVault, program.programId);
  const [tracker] = getTrackerPDA(sourceVault, program.programId);
  const [escrow] = getEscrowPDA(
    sourceVault,
    destinationVault,
    escrowId,
    program.programId,
  );
  const escrowAta = getAssociatedTokenAddressSync(tokenMint, escrow, true);

  return program.methods
    .createEscrow(escrowId, amount, expiresAt, conditionHash)
    .accounts({
      agent,
      sourceVault,
      policy,
      tracker,
      destinationVault,
      escrow,
      sourceVaultAta,
      escrowAta,
      protocolTreasuryAta: protocolTreasuryAta ?? null,
      feeDestinationAta: feeDestinationAta ?? null,
      tokenMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as any);
}

export function buildSettleEscrow(
  program: Program<Phalnx>,
  destinationAgent: PublicKey,
  destinationVault: PublicKey,
  sourceVault: PublicKey,
  escrow: PublicKey,
  escrowAta: PublicKey,
  destinationVaultAta: PublicKey,
  tokenMint: PublicKey,
  proof: Buffer,
) {
  return program.methods.settleEscrow(proof).accounts({
    destinationAgent,
    destinationVault,
    sourceVault,
    escrow,
    escrowAta,
    destinationVaultAta,
    tokenMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as any);
}

export function buildRefundEscrow(
  program: Program<Phalnx>,
  sourceSigner: PublicKey,
  sourceVault: PublicKey,
  escrow: PublicKey,
  escrowAta: PublicKey,
  sourceVaultAta: PublicKey,
  tokenMint: PublicKey,
) {
  return program.methods.refundEscrow().accounts({
    sourceSigner,
    sourceVault,
    escrow,
    escrowAta,
    sourceVaultAta,
    tokenMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as any);
}

export function buildCloseSettledEscrow(
  program: Program<Phalnx>,
  signer: PublicKey,
  sourceVault: PublicKey,
  destinationVaultKey: PublicKey,
  escrow: PublicKey,
  escrowId: BN,
) {
  return program.methods.closeSettledEscrow(escrowId).accounts({
    signer,
    sourceVault,
    destinationVaultKey,
    escrow,
  } as any);
}

// --- Constraint Instructions ---

export function buildCreateInstructionConstraints(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  entries: ConstraintEntry[],
  strictMode?: boolean,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [constraints] = getConstraintsPDA(vault, program.programId);

  return program.methods
    .createInstructionConstraints(entries as any, strictMode ?? false)
    .accounts({
      owner,
      vault,
      policy,
      constraints,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildCloseInstructionConstraints(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [constraints] = getConstraintsPDA(vault, program.programId);

  return program.methods.closeInstructionConstraints().accounts({
    owner,
    vault,
    policy,
    constraints,
  } as any);
}

export function buildUpdateInstructionConstraints(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  entries: ConstraintEntry[],
  strictMode?: boolean,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [constraints] = getConstraintsPDA(vault, program.programId);

  return program.methods
    .updateInstructionConstraints(entries as any, strictMode ?? false)
    .accounts({
      owner,
      vault,
      policy,
      constraints,
    } as any);
}

export function buildQueueConstraintsUpdate(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
  entries: ConstraintEntry[],
  strictMode?: boolean,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [constraints] = getConstraintsPDA(vault, program.programId);
  const [pendingConstraints] = getPendingConstraintsPDA(
    vault,
    program.programId,
  );

  return program.methods
    .queueConstraintsUpdate(entries as any, strictMode ?? false)
    .accounts({
      owner,
      vault,
      policy,
      constraints,
      pendingConstraints,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildApplyConstraintsUpdate(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [constraints] = getConstraintsPDA(vault, program.programId);
  const [pendingConstraints] = getPendingConstraintsPDA(
    vault,
    program.programId,
  );

  return program.methods.applyConstraintsUpdate().accounts({
    owner,
    vault,
    policy,
    constraints,
    pendingConstraints,
  } as any);
}

export function buildCancelConstraintsUpdate(
  program: Program<Phalnx>,
  owner: PublicKey,
  vault: PublicKey,
) {
  const [pendingConstraints] = getPendingConstraintsPDA(
    vault,
    program.programId,
  );

  return program.methods.cancelConstraintsUpdate().accounts({
    owner,
    vault,
    pendingConstraints,
  } as any);
}
