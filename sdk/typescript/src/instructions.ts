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
  InitializeOracleRegistryParams,
  UpdateOracleRegistryParams,
} from "./types";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getOracleRegistryPDA,
} from "./accounts";

export function buildInitializeOracleRegistry(
  program: Program<AgentShield>,
  authority: PublicKey,
  params: InitializeOracleRegistryParams,
) {
  const [oracleRegistry] = getOracleRegistryPDA(program.programId);

  return program.methods
    .initializeOracleRegistry(params.entries as any)
    .accounts({
      authority,
      oracleRegistry,
      systemProgram: SystemProgram.programId,
    } as any);
}

export function buildUpdateOracleRegistry(
  program: Program<AgentShield>,
  authority: PublicKey,
  params: UpdateOracleRegistryParams,
) {
  const [oracleRegistry] = getOracleRegistryPDA(program.programId);

  return program.methods
    .updateOracleRegistry(params.entriesToAdd as any, params.mintsToRemove)
    .accounts({
      authority,
      oracleRegistry,
    } as any);
}

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
 *
 * @param oracleFeedAccount - Required for non-stablecoin tokens. Omitting this
 *   for tokens that have an oracle feed in the registry will cause an on-chain
 *   `OracleAccountMissing` error (6032). Use `resolveOracleFeed()` to look up
 *   the correct feed account for a given token mint.
 */
export function buildValidateAndAuthorize(
  program: Program<AgentShield>,
  agent: PublicKey,
  vault: PublicKey,
  vaultTokenAccount: PublicKey,
  params: AuthorizeParams,
  oracleFeedAccount?: PublicKey,
  fallbackOracleFeedAccount?: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);
  const [oracleRegistry] = getOracleRegistryPDA(program.programId);
  const [session] = getSessionPDA(
    vault,
    agent,
    params.tokenMint,
    program.programId,
  );

  let builder = program.methods
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
      oracleRegistry,
      session,
      vaultTokenAccount,
      tokenMintAccount: params.tokenMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any);

  if (oracleFeedAccount) {
    const remaining: {
      pubkey: PublicKey;
      isWritable: boolean;
      isSigner: boolean;
    }[] = [{ pubkey: oracleFeedAccount, isWritable: false, isSigner: false }];
    if (fallbackOracleFeedAccount) {
      remaining.push({
        pubkey: fallbackOracleFeedAccount,
        isWritable: false,
        isSigner: false,
      });
    }
    builder = builder.remainingAccounts(remaining);
  }

  return builder;
}

export function buildFinalizeSession(
  program: Program<AgentShield>,
  payer: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
  success: boolean,
  vaultTokenAccount: PublicKey,
  feeDestinationTokenAccount?: PublicKey | null,
  protocolTreasuryTokenAccount?: PublicKey | null,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [session] = getSessionPDA(vault, agent, tokenMint, program.programId);

  return program.methods.finalizeSession(success).accounts({
    payer,
    vault,
    policy,
    session,
    sessionRentRecipient: agent,
    vaultTokenAccount,
    feeDestinationTokenAccount: feeDestinationTokenAccount ?? null,
    protocolTreasuryTokenAccount: protocolTreasuryTokenAccount ?? null,
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
 *
 * @param oracleFeedAccount - Required for non-stablecoin tokens. Omitting this
 *   for tokens that have an oracle feed in the registry will cause an on-chain
 *   `OracleAccountMissing` error (6032). Use `resolveOracleFeed()` to look up
 *   the correct feed account for a given token mint.
 */
export function buildAgentTransfer(
  program: Program<AgentShield>,
  agent: PublicKey,
  vault: PublicKey,
  params: AgentTransferParams,
  oracleFeedAccount?: PublicKey,
  fallbackOracleFeedAccount?: PublicKey,
) {
  const [policy] = getPolicyPDA(vault, program.programId);
  const [tracker] = getTrackerPDA(vault, program.programId);
  const [oracleRegistry] = getOracleRegistryPDA(program.programId);

  let builder = program.methods.agentTransfer(params.amount).accounts({
    agent,
    vault,
    policy,
    tracker,
    oracleRegistry,
    vaultTokenAccount: params.vaultTokenAccount,
    tokenMintAccount: params.tokenMintAccount,
    destinationTokenAccount: params.destinationTokenAccount,
    feeDestinationTokenAccount: params.feeDestinationTokenAccount ?? null,
    protocolTreasuryTokenAccount: params.protocolTreasuryTokenAccount ?? null,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as any);

  if (oracleFeedAccount) {
    const remaining: {
      pubkey: PublicKey;
      isWritable: boolean;
      isSigner: boolean;
    }[] = [{ pubkey: oracleFeedAccount, isWritable: false, isSigner: false }];
    if (fallbackOracleFeedAccount) {
      remaining.push({
        pubkey: fallbackOracleFeedAccount,
        isWritable: false,
        isSigner: false,
      });
    }
    builder = builder.remainingAccounts(remaining);
  }

  return builder;
}
