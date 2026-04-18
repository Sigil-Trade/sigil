// Helpers for the mock-defi test program (programs/mock-defi/).
//
// This module is imported by on-chain test suites that need the vault's
// position counter to auto-update via Sigil's ConstraintEntry matching.
// The mock program exposes two no-op instructions (open_position,
// close_position) with stable 8-byte Anchor discriminators — routing an
// instruction to it through a composed [validate, mockDefiIx, finalize]
// transaction causes ConstraintEntry.position_effect to be read and
// applied to vault.open_positions in finalize_session.
//
// Without this harness, tests must use SystemProgram.transfer as a mock,
// which has no matching DiscriminatorFormat variant, so position_effect
// always resolves to None and the counter doesn't move (tracked in #209).

import { PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { Sigil } from "../../target/types/sigil";
import { createConstraintsAccount } from "./litesvm-setup";

// Stable program ID (matches declare_id! in programs/mock-defi/src/lib.rs
// and target/deploy/mock_defi-keypair.json).
export const MOCK_DEFI_PROGRAM_ID = new PublicKey(
  "2pB26qKW73sToF7ETcdhXQTj8biYwAk9TCArVwgHBe24",
);

// Anchor discriminators: SHA256("global:<method_name>")[0..8].
// Pre-computed so tests don't need to recompute per-invocation and so
// constraint entries have a literal byte pattern to match.
export const MOCK_DEFI_DISC_OPEN = Buffer.from([
  135, 128, 47, 77, 15, 152, 240, 49,
]);
export const MOCK_DEFI_DISC_CLOSE = Buffer.from([
  123, 134, 81, 0, 49, 68, 98, 98,
]);

// DiscriminatorFormat::Anchor8 matches the mock's 8-byte prefix.
// isSpending=2 (NonSpending) skips token-delegation + fee collection —
// the mock doesn't actually move funds, so treating it as spending would
// trigger Sigil's actual_spend>0 gate and block the position update.
// positionEffect=1 (Increment) for open, =2 (Decrement) for close.
const OPEN_ENTRY = {
  programId: MOCK_DEFI_PROGRAM_ID,
  dataConstraints: [
    {
      offset: 0,
      operator: { eq: {} },
      value: MOCK_DEFI_DISC_OPEN,
    },
  ],
  accountConstraints: [],
  isSpending: 2,
  positionEffect: 1,
  discriminatorFormat: { anchor8: {} },
};

const CLOSE_ENTRY = {
  programId: MOCK_DEFI_PROGRAM_ID,
  dataConstraints: [
    {
      offset: 0,
      operator: { eq: {} },
      value: MOCK_DEFI_DISC_CLOSE,
    },
  ],
  accountConstraints: [],
  isSpending: 2,
  positionEffect: 2,
  discriminatorFormat: { anchor8: {} },
};

/**
 * Configure InstructionConstraints on the given vault so that subsequent
 * `open_position`/`close_position` calls to the mock program auto-update
 * the vault's position counter in finalize_session.
 *
 * Allocates + extends + populates the constraints PDA in one atomic tx.
 * Call from a test's `before` hook after vault + policy are initialized.
 */
export function setupPositionConstraints(
  program: Program<Sigil>,
  svm: LiteSVM,
  owner: Keypair,
  vault: PublicKey,
  policy: PublicKey,
): void {
  createConstraintsAccount(
    program,
    svm,
    owner,
    vault,
    policy,
    [OPEN_ENTRY, CLOSE_ENTRY] as any,
    false, // strictMode = false; other instructions in the TX are allowed
  );
}

/**
 * Build an instruction that invokes mock-defi's `open_position`.
 * The 8-byte discriminator + zero account args produces a tx payload that
 * Sigil's constraint scanner will match against OPEN_ENTRY above.
 */
export function mockOpenPositionIx(payer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MOCK_DEFI_PROGRAM_ID,
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    data: Buffer.from(MOCK_DEFI_DISC_OPEN),
  });
}

/**
 * Build an instruction that invokes mock-defi's `close_position`.
 */
export function mockClosePositionIx(payer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MOCK_DEFI_PROGRAM_ID,
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    data: Buffer.from(MOCK_DEFI_DISC_CLOSE),
  });
}
