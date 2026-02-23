import { PublicKey } from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import type {
  AgentShield,
  AgentVaultAccount,
  PolicyConfigAccount,
  SpendTrackerAccount,
  SessionAuthorityAccount,
  PendingPolicyUpdateAccount,
  OracleRegistryAccount,
} from "./types";
import { AGENT_SHIELD_PROGRAM_ID } from "./types";

// --- PDA Derivation ---

export function getVaultPDA(
  owner: PublicKey,
  vaultId: BN,
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
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
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vault.toBuffer()],
    programId,
  );
}

export function getTrackerPDA(
  vault: PublicKey,
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
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
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
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
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pending_policy"), vault.toBuffer()],
    programId,
  );
}

export function getOracleRegistryPDA(
  programId: PublicKey = AGENT_SHIELD_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_registry")],
    programId,
  );
}

// --- Account Fetching ---
// Note: Anchor 0.32.1 generates PascalCase type names but creates camelCase
// properties at runtime. We cast through `any` to bridge this mismatch.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function accounts(program: Program<AgentShield>): any {
  return program.account;
}

export async function fetchVault(
  program: Program<AgentShield>,
  owner: PublicKey,
  vaultId: BN,
): Promise<AgentVaultAccount> {
  const [vaultPda] = getVaultPDA(owner, vaultId, program.programId);
  return (await accounts(program).agentVault.fetch(
    vaultPda,
  )) as AgentVaultAccount;
}

export async function fetchPolicy(
  program: Program<AgentShield>,
  vault: PublicKey,
): Promise<PolicyConfigAccount> {
  const [policyPda] = getPolicyPDA(vault, program.programId);
  return (await accounts(program).policyConfig.fetch(
    policyPda,
  )) as PolicyConfigAccount;
}

export async function fetchTracker(
  program: Program<AgentShield>,
  vault: PublicKey,
): Promise<SpendTrackerAccount> {
  const [trackerPda] = getTrackerPDA(vault, program.programId);
  return (await accounts(program).spendTracker.fetch(
    trackerPda,
  )) as SpendTrackerAccount;
}

export async function fetchSession(
  program: Program<AgentShield>,
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
  program: Program<AgentShield>,
  address: PublicKey,
): Promise<AgentVaultAccount> {
  return (await accounts(program).agentVault.fetch(
    address,
  )) as AgentVaultAccount;
}

export async function fetchPolicyByAddress(
  program: Program<AgentShield>,
  address: PublicKey,
): Promise<PolicyConfigAccount> {
  return (await accounts(program).policyConfig.fetch(
    address,
  )) as PolicyConfigAccount;
}

export async function fetchTrackerByAddress(
  program: Program<AgentShield>,
  address: PublicKey,
): Promise<SpendTrackerAccount> {
  return (await accounts(program).spendTracker.fetch(
    address,
  )) as SpendTrackerAccount;
}

export async function fetchPendingPolicy(
  program: Program<AgentShield>,
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

export async function fetchOracleRegistry(
  program: Program<AgentShield>,
): Promise<OracleRegistryAccount> {
  const [pda] = getOracleRegistryPDA(program.programId);
  return (await accounts(program).oracleRegistry.fetch(
    pda,
  )) as OracleRegistryAccount;
}
