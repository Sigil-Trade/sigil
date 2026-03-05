import { PublicKey } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import type {
  Phalnx,
  AgentVaultAccount,
  PolicyConfigAccount,
  SpendTrackerAccount,
  SessionAuthorityAccount,
  PendingPolicyUpdateAccount,
  EscrowDepositAccount,
  InstructionConstraintsAccount,
  PendingConstraintsUpdateAccount,
} from "./types";
import { PHALNX_PROGRAM_ID } from "./types";

// --- PDA Derivation ---

export function getVaultPDA(
  owner: PublicKey,
  vaultId: BN,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

export function getPolicyPDA(
  vault: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vault.toBuffer()],
    programId,
  );
}

export function getTrackerPDA(
  vault: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tracker"), vault.toBuffer()],
    programId,
  );
}

export function getSessionPDA(
  vault: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("session"),
      vault.toBuffer(),
      agent.toBuffer(),
      tokenMint.toBuffer(),
    ],
    programId,
  );
}

export function getPendingPolicyPDA(
  vault: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pending_policy"), vault.toBuffer()],
    programId,
  );
}

// --- Account Fetching ---
// Note: Anchor 0.32.1 generates PascalCase type names but creates camelCase
// properties at runtime. We cast through `any` to bridge this mismatch.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function accounts(program: Program<Phalnx>): any {
  return program.account;
}

export async function fetchVault(
  program: Program<Phalnx>,
  owner: PublicKey,
  vaultId: BN,
): Promise<AgentVaultAccount> {
  const [vaultPda] = getVaultPDA(owner, vaultId, program.programId);
  return (await accounts(program).agentVault.fetch(
    vaultPda,
  )) as AgentVaultAccount;
}

export async function fetchPolicy(
  program: Program<Phalnx>,
  vault: PublicKey,
): Promise<PolicyConfigAccount> {
  const [policyPda] = getPolicyPDA(vault, program.programId);
  return (await accounts(program).policyConfig.fetch(
    policyPda,
  )) as PolicyConfigAccount;
}

export async function fetchTracker(
  program: Program<Phalnx>,
  vault: PublicKey,
): Promise<SpendTrackerAccount> {
  const [trackerPda] = getTrackerPDA(vault, program.programId);
  return (await accounts(program).spendTracker.fetch(
    trackerPda,
  )) as SpendTrackerAccount;
}

export async function fetchSession(
  program: Program<Phalnx>,
  vault: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
): Promise<SessionAuthorityAccount> {
  const [sessionPda] = getSessionPDA(
    vault,
    agent,
    tokenMint,
    program.programId,
  );
  return (await accounts(program).sessionAuthority.fetch(
    sessionPda,
  )) as SessionAuthorityAccount;
}

export async function fetchVaultByAddress(
  program: Program<Phalnx>,
  address: PublicKey,
): Promise<AgentVaultAccount> {
  return (await accounts(program).agentVault.fetch(
    address,
  )) as AgentVaultAccount;
}

export async function fetchPolicyByAddress(
  program: Program<Phalnx>,
  address: PublicKey,
): Promise<PolicyConfigAccount> {
  return (await accounts(program).policyConfig.fetch(
    address,
  )) as PolicyConfigAccount;
}

export async function fetchTrackerByAddress(
  program: Program<Phalnx>,
  address: PublicKey,
): Promise<SpendTrackerAccount> {
  return (await accounts(program).spendTracker.fetch(
    address,
  )) as SpendTrackerAccount;
}

export async function fetchPendingPolicy(
  program: Program<Phalnx>,
  vault: PublicKey,
): Promise<PendingPolicyUpdateAccount | null> {
  const [pda] = getPendingPolicyPDA(vault, program.programId);
  try {
    return (await accounts(program).pendingPolicyUpdate.fetch(
      pda,
    )) as PendingPolicyUpdateAccount;
  } catch {
    return null;
  }
}

// --- Escrow PDAs ---

export function getEscrowPDA(
  sourceVault: PublicKey,
  destinationVault: PublicKey,
  escrowId: BN,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      sourceVault.toBuffer(),
      destinationVault.toBuffer(),
      escrowId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

export async function fetchEscrow(
  program: Program<Phalnx>,
  sourceVault: PublicKey,
  destinationVault: PublicKey,
  escrowId: BN,
): Promise<EscrowDepositAccount> {
  const [pda] = getEscrowPDA(
    sourceVault,
    destinationVault,
    escrowId,
    program.programId,
  );
  return (await accounts(program).escrowDeposit.fetch(
    pda,
  )) as EscrowDepositAccount;
}

export async function fetchEscrowByAddress(
  program: Program<Phalnx>,
  address: PublicKey,
): Promise<EscrowDepositAccount> {
  return (await accounts(program).escrowDeposit.fetch(
    address,
  )) as EscrowDepositAccount;
}

// --- Constraint PDAs ---

export function getConstraintsPDA(
  vault: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("constraints"), vault.toBuffer()],
    programId,
  );
}

export function getPendingConstraintsPDA(
  vault: PublicKey,
  programId: PublicKey = PHALNX_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pending_constraints"), vault.toBuffer()],
    programId,
  );
}

export async function fetchConstraints(
  program: Program<Phalnx>,
  vault: PublicKey,
): Promise<InstructionConstraintsAccount | null> {
  const [pda] = getConstraintsPDA(vault, program.programId);
  try {
    return (await accounts(program).instructionConstraints.fetch(
      pda,
    )) as InstructionConstraintsAccount;
  } catch {
    return null;
  }
}

export async function fetchPendingConstraints(
  program: Program<Phalnx>,
  vault: PublicKey,
): Promise<PendingConstraintsUpdateAccount | null> {
  const [pda] = getPendingConstraintsPDA(vault, program.programId);
  try {
    return (await accounts(program).pendingConstraintsUpdate.fetch(
      pda,
    )) as PendingConstraintsUpdateAccount;
  } catch {
    return null;
  }
}
