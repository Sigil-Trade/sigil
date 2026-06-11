/**
 * Ownership-transfer helpers — Phase 9 Batch E (ISC-25..29).
 *
 * Thin wrappers around the four generated ownership-transfer instruction
 * builders. Sigil V2 (Phase 8) shipped three on-chain instructions for
 * ownership rotation:
 *
 *   1. `initiate_ownership_transfer` — owner queues a `PendingOwnershipTransfer`
 *      PDA with a 48h default timelock. The `is_multisig_target` flag tells
 *      the apply handler to demand the Squads V4 multisig acceptance
 *      variant (closes the "frozen funds via wrong multisig" footgun).
 *   2. `accept_ownership_transfer` — the new owner (a wallet signer)
 *      finalises the rotation after the timelock elapses.
 *   3. `accept_ownership_transfer_multisig` — same finaliser, but routed
 *      through the Squads V4 multisig program-derived PDA path. Caller
 *      passes the multisig PDA in place of the new-owner signer.
 *   4. `cancel_ownership_transfer` — owner aborts during the timelock.
 *
 * These four functions are intentionally tiny — they exist to (a) give
 * callers a single import path, (b) keep the public type names readable
 * (`buildXxxIx` vs the verbose `getXxxInstruction`), and (c) provide a
 * stable surface that survives future Codama regenerations.
 */

import type { Address, TransactionSigner } from "@solana/kit";
import {
  getInitiateOwnershipTransferInstruction,
  type InitiateOwnershipTransferInstruction,
} from "./generated/instructions/initiateOwnershipTransfer.js";
import {
  getAcceptOwnershipTransferInstruction,
  type AcceptOwnershipTransferInstruction,
} from "./generated/instructions/acceptOwnershipTransfer.js";
import {
  getAcceptOwnershipTransferMultisigInstruction,
  type AcceptOwnershipTransferMultisigInstruction,
} from "./generated/instructions/acceptOwnershipTransferMultisig.js";
import {
  getCancelOwnershipTransferInstruction,
  type CancelOwnershipTransferInstruction,
} from "./generated/instructions/cancelOwnershipTransfer.js";

// ── Type re-exports ──────────────────────────────────────────────────────────
//
// Wrapper return types match the generated instruction shapes 1:1 so
// downstream code keeps full type inference.
export type {
  InitiateOwnershipTransferInstruction,
  AcceptOwnershipTransferInstruction,
  AcceptOwnershipTransferMultisigInstruction,
  CancelOwnershipTransferInstruction,
};

// ── 1. Initiate ──────────────────────────────────────────────────────────────

export interface BuildInitiateOwnershipTransferInputs {
  owner: TransactionSigner;
  vault: Address;
  policy: Address;
  pending: Address;
  auditLogSuccess: Address;
  newOwner: Address;
  /**
   * `true` when `newOwner` is a Squads V4 multisig PDA. The on-chain
   * accept handler validates the multisig path matches this flag.
   * `false` for wallet-keypair owners.
   */
  isMultisigTarget: boolean;
}

export function buildInitiateOwnershipTransferIx(
  inputs: BuildInitiateOwnershipTransferInputs,
): InitiateOwnershipTransferInstruction {
  return getInitiateOwnershipTransferInstruction({
    owner: inputs.owner,
    vault: inputs.vault,
    policy: inputs.policy,
    pending: inputs.pending,
    auditLogSuccess: inputs.auditLogSuccess,
    newOwner: inputs.newOwner,
    isMultisigTarget: inputs.isMultisigTarget,
  } as Parameters<
    typeof getInitiateOwnershipTransferInstruction
  >[0]) as InitiateOwnershipTransferInstruction;
}

// ── 2. Accept (wallet signer) ────────────────────────────────────────────────

export interface BuildAcceptOwnershipTransferInputs {
  newOwner: TransactionSigner;
  vault: Address;
  policy: Address;
  pending: Address;
  auditLogSuccess: Address;
}

export function buildAcceptOwnershipTransferIx(
  inputs: BuildAcceptOwnershipTransferInputs,
): AcceptOwnershipTransferInstruction {
  return getAcceptOwnershipTransferInstruction({
    newOwner: inputs.newOwner,
    vault: inputs.vault,
    policy: inputs.policy,
    pending: inputs.pending,
    auditLogSuccess: inputs.auditLogSuccess,
  } as Parameters<
    typeof getAcceptOwnershipTransferInstruction
  >[0]) as AcceptOwnershipTransferInstruction;
}

// ── 3. Accept (Squads V4 multisig variant) ──────────────────────────────────

export interface BuildAcceptOwnershipTransferMultisigInputs {
  /**
   * The Squads V4 multisig program-derived address that becomes the new
   * vault owner. The on-chain handler verifies this account's `owner`
   * field equals the Squads V4 program ID. Not a signer — the Squads
   * program is the caller via CPI.
   */
  multisigPda: Address;
  vault: Address;
  policy: Address;
  pending: Address;
  auditLogSuccess: Address;
}

export function buildAcceptOwnershipTransferMultisigIx(
  inputs: BuildAcceptOwnershipTransferMultisigInputs,
): AcceptOwnershipTransferMultisigInstruction {
  return getAcceptOwnershipTransferMultisigInstruction({
    multisigPda: inputs.multisigPda,
    vault: inputs.vault,
    policy: inputs.policy,
    pending: inputs.pending,
    auditLogSuccess: inputs.auditLogSuccess,
  } as Parameters<
    typeof getAcceptOwnershipTransferMultisigInstruction
  >[0]) as AcceptOwnershipTransferMultisigInstruction;
}

// ── 4. Cancel ────────────────────────────────────────────────────────────────

export interface BuildCancelOwnershipTransferInputs {
  /**
   * The vault's CURRENT owner (the one who initiated the transfer).
   * The on-chain handler enforces `current_owner.key() == pending.current_owner`.
   */
  currentOwner: TransactionSigner;
  vault: Address;
  policy: Address;
  pending: Address;
  auditLogSuccess: Address;
}

export function buildCancelOwnershipTransferIx(
  inputs: BuildCancelOwnershipTransferInputs,
): CancelOwnershipTransferInstruction {
  return getCancelOwnershipTransferInstruction({
    currentOwner: inputs.currentOwner,
    vault: inputs.vault,
    policy: inputs.policy,
    pending: inputs.pending,
    auditLogSuccess: inputs.auditLogSuccess,
  } as Parameters<
    typeof getCancelOwnershipTransferInstruction
  >[0]) as CancelOwnershipTransferInstruction;
}
