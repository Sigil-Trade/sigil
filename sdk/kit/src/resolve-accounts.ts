/**
 * Kit-native PDA resolution for Phalnx accounts.
 *
 * Uses Kit's `getProgramDerivedAddress()` and `getAddressEncoder()` for
 * seed encoding. All 8 PDA types are derivable.
 */

import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { PHALNX_PROGRAM_ADDRESS } from "./generated/programs/phalnx.js";

// ─── PDA Derivation ──────────────────────────────────────────────────────────

const encoder = getAddressEncoder();
const textEncoder = new TextEncoder();

type Seed = ReadonlyUint8Array | Uint8Array;

function seedString(s: string): Seed {
  return textEncoder.encode(s);
}

function seedAddress(addr: Address): Seed {
  return encoder.encode(addr);
}

function seedU64Le(value: bigint): Seed {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, value, true); // little-endian
  return buf;
}

function seedU8(value: number): Seed {
  return new Uint8Array([value]);
}

export async function getVaultPDA(
  owner: Address,
  vaultId: bigint,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("vault"), seedAddress(owner), seedU64Le(vaultId)],
  });
  return [pda, bump];
}

export async function getPolicyPDA(
  vault: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("policy"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getTrackerPDA(
  vault: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("tracker"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getSessionPDA(
  vault: Address,
  agent: Address,
  tokenMint: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      seedString("session"),
      seedAddress(vault),
      seedAddress(agent),
      seedAddress(tokenMint),
    ],
  });
  return [pda, bump];
}

export async function getPendingPolicyPDA(
  vault: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("pending_policy"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getEscrowPDA(
  sourceVault: Address,
  destinationVault: Address,
  escrowId: bigint,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      seedString("escrow"),
      seedAddress(sourceVault),
      seedAddress(destinationVault),
      seedU64Le(escrowId),
    ],
  });
  return [pda, bump];
}

export async function getAgentOverlayPDA(
  vault: Address,
  shardIndex: number = 0,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("agent_spend"), seedAddress(vault), seedU8(shardIndex)],
  });
  return [pda, bump];
}

export async function getConstraintsPDA(
  vault: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("constraints"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getPendingConstraintsPDA(
  vault: Address,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("pending_constraints"), seedAddress(vault)],
  });
  return [pda, bump];
}

// ─── Composite Account Resolution ────────────────────────────────────────────

export interface ResolveAccountsInput {
  vault: Address;
  agent: Address;
  tokenMint: Address;
  outputMint?: Address;
  feeDestination?: Address;
  hasConstraints?: boolean;
}

export interface ResolvedAccounts {
  vault: Address;
  policyPda: Address;
  trackerPda: Address;
  sessionPda: Address;
  constraintsPda?: Address;
  agentOverlayPda?: Address;
}

/**
 * Auto-derive all PDA accounts needed for a composed Phalnx transaction.
 * Token ATAs must be derived separately using `@solana-program/token`.
 */
export async function resolveAccounts(
  input: ResolveAccountsInput,
  programAddress: Address = PHALNX_PROGRAM_ADDRESS,
): Promise<ResolvedAccounts> {
  const [policyPda] = await getPolicyPDA(input.vault, programAddress);
  const [trackerPda] = await getTrackerPDA(input.vault, programAddress);
  const [sessionPda] = await getSessionPDA(
    input.vault,
    input.agent,
    input.tokenMint,
    programAddress,
  );

  const result: ResolvedAccounts = {
    vault: input.vault,
    policyPda,
    trackerPda,
    sessionPda,
  };

  if (input.hasConstraints) {
    const [constraintsPda] = await getConstraintsPDA(
      input.vault,
      programAddress,
    );
    result.constraintsPda = constraintsPda;
  }

  return result;
}
