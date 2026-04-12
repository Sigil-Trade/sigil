/**
 * Constraint PDA read helpers for OwnerClient.
 *
 * Derives constraint PDA addresses and fetches/decodes the on-chain
 * InstructionConstraints, PendingConstraintsUpdate, and
 * PendingCloseConstraints accounts.
 *
 * Phase A1.5 — these helpers close the SDK read gap. The dashboard
 * imports these instead of hand-rolling PDA derivation + zero-copy
 * decoding.
 */

import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  getProgramDerivedAddress,
  getAddressEncoder,
} from "@solana/kit";

import { SIGIL_PROGRAM_ADDRESS } from "../generated/programs/sigil.js";

// ─── PDA Derivation ─────────────────────────────────────────────────────

const CONSTRAINTS_SEED = new TextEncoder().encode("constraints");
const PENDING_CONSTRAINTS_SEED = new TextEncoder().encode(
  "pending_constraints",
);
const PENDING_CLOSE_CONSTRAINTS_SEED = new TextEncoder().encode(
  "pending_close_constraints",
);

/**
 * Derive the InstructionConstraints PDA for a vault.
 * Seeds: [b"constraints", vault.key()]
 */
export async function findConstraintsPda(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [CONSTRAINTS_SEED, encoder.encode(vault)],
  });
  return pda;
}

/**
 * Derive the PendingConstraintsUpdate PDA for a vault.
 * Seeds: [b"pending_constraints", vault.key()]
 */
export async function findPendingConstraintsPda(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [PENDING_CONSTRAINTS_SEED, encoder.encode(vault)],
  });
  return pda;
}

/**
 * Derive the PendingCloseConstraints PDA for a vault.
 * Seeds: [b"pending_close_constraints", vault.key()]
 */
export async function findPendingCloseConstraintsPda(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [PENDING_CLOSE_CONSTRAINTS_SEED, encoder.encode(vault)],
  });
  return pda;
}

// ─── Account Fetching ───────────────────────────────────────────────────

export interface ConstraintsPdaInfo {
  /** Whether the constraints PDA exists (has been allocated). */
  exists: boolean;
  /** Raw account data (base64-decoded) if exists. */
  data: Uint8Array | null;
  /** The PDA address. */
  address: Address;
}

/**
 * Fetch the InstructionConstraints account for a vault.
 * Returns raw bytes — decoding is the caller's responsibility
 * (the zero-copy layout is complex and may change).
 */
export async function fetchConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<ConstraintsPdaInfo> {
  const address = await findConstraintsPda(vault, programAddress);
  const accountInfo = await rpc
    .getAccountInfo(address, { encoding: "base64" })
    .send();

  if (!accountInfo.value) {
    return { exists: false, data: null, address };
  }

  const rawData = accountInfo.value.data;
  if (Array.isArray(rawData) && typeof rawData[0] === "string") {
    return {
      exists: true,
      data: new Uint8Array(Buffer.from(rawData[0], "base64")),
      address,
    };
  }

  return { exists: true, data: null, address };
}

/**
 * Fetch the PendingConstraintsUpdate account for a vault.
 */
export async function fetchPendingConstraintsUpdate(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<ConstraintsPdaInfo> {
  const address = await findPendingConstraintsPda(vault, programAddress);
  const accountInfo = await rpc
    .getAccountInfo(address, { encoding: "base64" })
    .send();

  if (!accountInfo.value) {
    return { exists: false, data: null, address };
  }

  const rawData = accountInfo.value.data;
  if (Array.isArray(rawData) && typeof rawData[0] === "string") {
    return {
      exists: true,
      data: new Uint8Array(Buffer.from(rawData[0], "base64")),
      address,
    };
  }

  return { exists: true, data: null, address };
}

/**
 * Fetch the PendingCloseConstraints account for a vault.
 */
export async function fetchPendingCloseConstraints(
  rpc: Rpc<SolanaRpcApi>,
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<ConstraintsPdaInfo> {
  const address = await findPendingCloseConstraintsPda(vault, programAddress);
  const accountInfo = await rpc
    .getAccountInfo(address, { encoding: "base64" })
    .send();

  if (!accountInfo.value) {
    return { exists: false, data: null, address };
  }

  const rawData = accountInfo.value.data;
  if (Array.isArray(rawData) && typeof rawData[0] === "string") {
    return {
      exists: true,
      data: new Uint8Array(Buffer.from(rawData[0], "base64")),
      address,
    };
  }

  return { exists: true, data: null, address };
}
