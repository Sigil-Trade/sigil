// ---------------------------------------------------------------------------
// Squads V4 Multisig integration for Phalnx
// Enables N-of-M governance over vault policies — institutional users can
// require "3-of-5 board approval" before AI agent spending limits change.
//
// Architecture: A Squads vault PDA becomes the Phalnx vault `owner`.
// Policy changes go through Squads proposals. The agent runtime is unaffected.
// ---------------------------------------------------------------------------

import {
  PublicKey,
  Connection,
  TransactionInstruction,
  TransactionMessage,
  Keypair,
} from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import * as multisig from "@sqds/multisig";
import type {
  Phalnx,
  UpdatePolicyParams,
  QueuePolicyUpdateParams,
  InitializeVaultParams,
} from "../types";
import {
  buildInitializeVault,
  buildUpdatePolicy,
  buildQueuePolicyUpdate,
  buildApplyPendingPolicy,
  buildSyncPositions,
} from "../instructions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SQUADS_V4_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SquadsMember {
  key: PublicKey;
  permissions: {
    initiate: boolean;
    vote: boolean;
    execute: boolean;
  };
}

export interface CreateSquadsMultisigParams {
  /** Fresh keypair used to derive the multisig PDA. */
  createKey: Keypair;
  members: SquadsMember[];
  /** Number of approvals required. */
  threshold: number;
  /** Delay (seconds) between approval and execution. Default 0. */
  timeLock?: number;
  /** Account that collects rent from closed transactions. */
  rentCollector?: PublicKey | null;
  memo?: string;
}

export interface ProposeVaultActionParams {
  multisigPda: PublicKey;
  /** Squads vault authority index (default 0). */
  vaultIndex?: number;
  /** Phalnx instruction(s) to wrap in the proposal. */
  instructions: TransactionInstruction[];
  memo?: string;
}

export interface ApproveProposalParams {
  multisigPda: PublicKey;
  transactionIndex: bigint;
  memo?: string;
}

export interface RejectProposalParams {
  multisigPda: PublicKey;
  transactionIndex: bigint;
}

export interface ExecuteVaultTransactionParams {
  multisigPda: PublicKey;
  transactionIndex: bigint;
}

export interface MultisigInfo {
  address: PublicKey;
  threshold: number;
  memberCount: number;
  members: Array<{
    key: PublicKey;
    permissions: { initiate: boolean; vote: boolean; execute: boolean };
  }>;
  transactionIndex: bigint;
  timeLock: number;
  /** Default vault PDA (index 0). */
  vaultPda: PublicKey;
}

export interface ProposalInfo {
  address: PublicKey;
  multisig: PublicKey;
  transactionIndex: bigint;
  status: string;
  statusTimestamp?: bigint;
  approvals: PublicKey[];
  rejections: PublicKey[];
  cancellations: PublicKey[];
}

// -- Convenience function param types --

export interface ProposeInitializeVaultParams {
  multisigPda: PublicKey;
  vaultIndex?: number;
  initParams: InitializeVaultParams;
  memo?: string;
}

export interface ProposeUpdatePolicyParams {
  multisigPda: PublicKey;
  vaultIndex?: number;
  /** The Phalnx vault PDA whose policy is being changed. */
  phalnxVault: PublicKey;
  policyUpdate: UpdatePolicyParams;
  memo?: string;
}

export interface ProposeQueuePolicyUpdateParams {
  multisigPda: PublicKey;
  vaultIndex?: number;
  phalnxVault: PublicKey;
  policyUpdate: QueuePolicyUpdateParams;
  memo?: string;
}

export interface ProposeApplyPendingPolicyParams {
  multisigPda: PublicKey;
  vaultIndex?: number;
  phalnxVault: PublicKey;
  memo?: string;
}

export interface ProposeSyncPositionsParams {
  multisigPda: PublicKey;
  vaultIndex?: number;
  phalnxVault: PublicKey;
  actualPositions: number;
  memo?: string;
}

// ---------------------------------------------------------------------------
// PDA Helpers
// ---------------------------------------------------------------------------

export function getSquadsMultisigPda(
  createKey: PublicKey,
): [PublicKey, number] {
  return multisig.getMultisigPda({ createKey });
}

export function getSquadsVaultPda(
  multisigPda: PublicKey,
  index: number = 0,
): [PublicKey, number] {
  return multisig.getVaultPda({ multisigPda, index });
}

export function getSquadsTransactionPda(
  multisigPda: PublicKey,
  index: bigint,
): [PublicKey, number] {
  return multisig.getTransactionPda({ multisigPda, index });
}

export function getSquadsProposalPda(
  multisigPda: PublicKey,
  transactionIndex: bigint,
): [PublicKey, number] {
  return multisig.getProposalPda({ multisigPda, transactionIndex });
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function toSquadsMember(m: SquadsMember): { key: PublicKey; permissions: any } {
  const perms: Array<
    (typeof multisig.types.Permission)[keyof typeof multisig.types.Permission]
  > = [];
  if (m.permissions.initiate) perms.push(multisig.types.Permission.Initiate);
  if (m.permissions.vote) perms.push(multisig.types.Permission.Vote);
  if (m.permissions.execute) perms.push(multisig.types.Permission.Execute);
  return {
    key: m.key,
    permissions: multisig.types.Permissions.fromPermissions(perms as any),
  };
}

function fromSquadsMask(mask: number): SquadsMember["permissions"] {
  return {
    initiate: (mask & multisig.types.Permission.Initiate) !== 0,
    vote: (mask & multisig.types.Permission.Vote) !== 0,
    execute: (mask & multisig.types.Permission.Execute) !== 0,
  };
}

function resolveStatus(status: any): { name: string; timestamp?: bigint } {
  const kind: string = status?.__kind ?? "Unknown";
  const ts =
    status?.timestamp != null ? BigInt(status.timestamp.toString()) : undefined;
  switch (kind) {
    case "Draft":
    case "Active":
    case "Approved":
    case "Rejected":
    case "Executed":
    case "Cancelled":
      return { name: kind, timestamp: ts };
    case "Executing":
      return { name: "Executing" };
    default:
      return { name: "Unknown" };
  }
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Create a new Squads V4 multisig.
 *
 * Returns the transaction signature, the derived multisig PDA, and the
 * default vault PDA (index 0). Use the vault PDA as the `owner` when
 * creating an Phalnx vault governed by this multisig.
 */
export async function createSquadsMultisig(
  connection: Connection,
  feePayer: Keypair,
  params: CreateSquadsMultisigParams,
): Promise<{ signature: string; multisigPda: PublicKey; vaultPda: PublicKey }> {
  const [multisigPda] = getSquadsMultisigPda(params.createKey.publicKey);
  const [vaultPda] = getSquadsVaultPda(multisigPda, 0);

  const members = params.members.map(toSquadsMember);

  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    treasury: vaultPda,
    createKey: params.createKey,
    creator: feePayer,
    multisigPda,
    configAuthority: null,
    threshold: params.threshold,
    members,
    timeLock: params.timeLock ?? 0,
    rentCollector: params.rentCollector ?? null,
    memo: params.memo,
  });

  return { signature, multisigPda, vaultPda };
}

/**
 * Wrap one or more instructions in a Squads vault transaction + proposal.
 *
 * Performs three sequential on-chain transactions:
 * 1. `vaultTransactionCreate` — stores the instruction message on-chain
 * 2. `proposalCreate` — creates a governance proposal (draft)
 * 3. `proposalActivate` — opens the proposal for voting
 *
 * The `feePayer` must be a multisig member with the Initiate permission.
 */
export async function proposeVaultAction(
  connection: Connection,
  feePayer: Keypair,
  params: ProposeVaultActionParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const msAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    params.multisigPda,
  );
  const transactionIndex = BigInt(msAccount.transactionIndex.toString()) + 1n;

  const vaultIndex = params.vaultIndex ?? 0;
  const [vaultPda] = getSquadsVaultPda(params.multisigPda, vaultIndex);

  const { blockhash } = await connection.getLatestBlockhash();
  const txMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: params.instructions,
  });

  // Step 1 — store the instruction message on-chain
  await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer,
    multisigPda: params.multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: txMessage,
    memo: params.memo,
  });

  // Step 2 — create the proposal (as draft)
  await multisig.rpc.proposalCreate({
    connection,
    feePayer,
    creator: feePayer,
    multisigPda: params.multisigPda,
    transactionIndex,
    isDraft: true,
  });

  // Step 3 — activate for voting
  const signature = await multisig.rpc.proposalActivate({
    connection,
    feePayer,
    member: feePayer,
    multisigPda: params.multisigPda,
    transactionIndex,
  });

  return { signature, transactionIndex };
}

/**
 * Cast an approval vote on an active proposal.
 * The member must have the Vote permission.
 */
export async function approveProposal(
  connection: Connection,
  member: Keypair,
  params: ApproveProposalParams,
): Promise<string> {
  return multisig.rpc.proposalApprove({
    connection,
    feePayer: member,
    member,
    multisigPda: params.multisigPda,
    transactionIndex: params.transactionIndex,
    memo: params.memo,
  });
}

/**
 * Cast a rejection vote on an active proposal.
 * The member must have the Vote permission.
 */
export async function rejectProposal(
  connection: Connection,
  member: Keypair,
  params: RejectProposalParams,
): Promise<string> {
  return multisig.rpc.proposalReject({
    connection,
    feePayer: member,
    member,
    multisigPda: params.multisigPda,
    transactionIndex: params.transactionIndex,
  });
}

/**
 * Execute an approved vault transaction.
 * The member must have the Execute permission and the proposal must be Approved.
 */
export async function executeVaultTransaction(
  connection: Connection,
  member: Keypair,
  params: ExecuteVaultTransactionParams,
): Promise<string> {
  return multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: member,
    multisigPda: params.multisigPda,
    transactionIndex: params.transactionIndex,
    member: member.publicKey,
  });
}

// ---------------------------------------------------------------------------
// Account Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch and normalize a Squads multisig account.
 */
export async function fetchMultisigInfo(
  connection: Connection,
  multisigPda: PublicKey,
): Promise<MultisigInfo> {
  const acct = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );

  const [vaultPda] = getSquadsVaultPda(multisigPda, 0);

  return {
    address: multisigPda,
    threshold: acct.threshold,
    memberCount: acct.members.length,
    members: acct.members.map((m: any) => ({
      key: m.key,
      permissions: fromSquadsMask(
        typeof m.permissions === "object" && "mask" in m.permissions
          ? m.permissions.mask
          : Number(m.permissions),
      ),
    })),
    transactionIndex: BigInt(acct.transactionIndex.toString()),
    timeLock: acct.timeLock,
    vaultPda,
  };
}

/**
 * Fetch and normalize a Squads proposal account.
 */
export async function fetchProposalInfo(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
): Promise<ProposalInfo> {
  const [proposalPda] = getSquadsProposalPda(multisigPda, transactionIndex);
  const acct = await multisig.accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda,
  );

  const { name, timestamp } = resolveStatus(acct.status);

  return {
    address: proposalPda,
    multisig: acct.multisig,
    transactionIndex: BigInt(acct.transactionIndex.toString()),
    status: name,
    statusTimestamp: timestamp,
    approvals: acct.approved ?? [],
    rejections: acct.rejected ?? [],
    cancellations: acct.cancelled ?? [],
  };
}

// ---------------------------------------------------------------------------
// Phalnx Convenience Functions
//
// Each builds an Phalnx owner instruction, then wraps it in a Squads
// proposal via proposeVaultAction(). The Squads vault PDA is used as the
// `owner` signer — when the proposal is executed, Squads CPI-calls into
// Phalnx with the vault PDA as authority.
// ---------------------------------------------------------------------------

export async function proposeInitializeVault(
  program: Program<Phalnx>,
  connection: Connection,
  feePayer: Keypair,
  params: ProposeInitializeVaultParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const [squadsVault] = getSquadsVaultPda(
    params.multisigPda,
    params.vaultIndex ?? 0,
  );
  const ix = await buildInitializeVault(
    program,
    squadsVault,
    params.initParams,
  ).instruction();

  return proposeVaultAction(connection, feePayer, {
    multisigPda: params.multisigPda,
    vaultIndex: params.vaultIndex,
    instructions: [ix],
    memo: params.memo,
  });
}

export async function proposeUpdatePolicy(
  program: Program<Phalnx>,
  connection: Connection,
  feePayer: Keypair,
  params: ProposeUpdatePolicyParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const [squadsVault] = getSquadsVaultPda(
    params.multisigPda,
    params.vaultIndex ?? 0,
  );
  const ix = await buildUpdatePolicy(
    program,
    squadsVault,
    params.phalnxVault,
    params.policyUpdate,
  ).instruction();

  return proposeVaultAction(connection, feePayer, {
    multisigPda: params.multisigPda,
    vaultIndex: params.vaultIndex,
    instructions: [ix],
    memo: params.memo,
  });
}

export async function proposeQueuePolicyUpdate(
  program: Program<Phalnx>,
  connection: Connection,
  feePayer: Keypair,
  params: ProposeQueuePolicyUpdateParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const [squadsVault] = getSquadsVaultPda(
    params.multisigPda,
    params.vaultIndex ?? 0,
  );
  const ix = await buildQueuePolicyUpdate(
    program,
    squadsVault,
    params.phalnxVault,
    params.policyUpdate,
  ).instruction();

  return proposeVaultAction(connection, feePayer, {
    multisigPda: params.multisigPda,
    vaultIndex: params.vaultIndex,
    instructions: [ix],
    memo: params.memo,
  });
}

export async function proposeApplyPendingPolicy(
  program: Program<Phalnx>,
  connection: Connection,
  feePayer: Keypair,
  params: ProposeApplyPendingPolicyParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const [squadsVault] = getSquadsVaultPda(
    params.multisigPda,
    params.vaultIndex ?? 0,
  );
  const ix = await buildApplyPendingPolicy(
    program,
    squadsVault,
    params.phalnxVault,
  ).instruction();

  return proposeVaultAction(connection, feePayer, {
    multisigPda: params.multisigPda,
    vaultIndex: params.vaultIndex,
    instructions: [ix],
    memo: params.memo,
  });
}

export async function proposeSyncPositions(
  program: Program<Phalnx>,
  connection: Connection,
  feePayer: Keypair,
  params: ProposeSyncPositionsParams,
): Promise<{ signature: string; transactionIndex: bigint }> {
  const [squadsVault] = getSquadsVaultPda(
    params.multisigPda,
    params.vaultIndex ?? 0,
  );
  const ix = await buildSyncPositions(
    program,
    squadsVault,
    params.phalnxVault,
    params.actualPositions,
  ).instruction();

  return proposeVaultAction(connection, feePayer, {
    multisigPda: params.multisigPda,
    vaultIndex: params.vaultIndex,
    instructions: [ix],
    memo: params.memo,
  });
}
