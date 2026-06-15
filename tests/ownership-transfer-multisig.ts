/**
 * Phase 8 Batch 4 — C26 ownership transfer (Squads V4 multisig accept variant).
 *
 * DISABLED in V1 (audit 2026-06-11, finding H-1). Transferring Sigil vault
 * ownership to a Squads V4 multisig is architecturally incompatible with
 * Sigil's top-level-only (`reject_cpi!`) model — a Squads multisig acts on
 * external programs only by CPI from `vault_transaction_execute`, but every
 * Sigil owner instruction rejects any CPI. The prior code path also let an
 * unsignable Squads state account be set as owner, permanently bricking the
 * vault. V1 disables the path:
 *   - `initiate_ownership_transfer` rejects `is_multisig_target = true`
 *     (ErrMultisigCustodyUnsupported, 6111); and
 *   - `accept_ownership_transfer_multisig` rejects unconditionally (6111).
 *
 * This suite verifies BOTH rejections. Multisig custody is deferred to a
 * future release with a proper design + re-audit.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  accountExists,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// 6111 — ErrMultisigCustodyUnsupported (multisig custody disabled in V1).
const ERR_MULTISIG_CUSTODY_UNSUPPORTED = 6111;

/**
 * Forge an opaque account to pass as `multisig_pda` (an UncheckedAccount). The
 * handler rejects before reading it, so only a valid writable meta is needed.
 */
function forgeMockMultisig(svm: LiteSVM): PublicKey {
  const kp = Keypair.generate();
  const data = Buffer.alloc(200);
  const rentExempt = Number(svm.minimumBalanceForRentExemption(BigInt(200)));
  svm.setAccount(kp.publicKey, {
    lamports: rentExempt,
    data,
    owner: SystemProgram.programId,
    executable: false,
  });
  return kp.publicKey;
}

describe("ownership-transfer-multisig (Phase 8 Batch 4 — DISABLED in V1, H-1)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 1000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  async function initVault(vaultId: BN) {
    const [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [tracker] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [auditSuccess] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), vault.toBuffer()],
      program.programId,
    );
    const [auditRejected] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_rejected"), vault.toBuffer()],
      program.programId,
    );
    const [pendingOwner] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_owner"), vault.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1,
        [jupiterProgramId],
        0,
        100,
        STANDARD_INIT_TIMELOCK,
        [],
        [],
        false,
        0x00ffffff,
        false,
        5,
        new BN(0),
        new BN(0),
        false,
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: STANDARD_INIT_TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          cosignRequired: false,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        auditLogRejected: auditRejected,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { vault, policy, auditSuccess, pendingOwner };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. initiate(is_multisig_target=true) is rejected — no multisig-target
  //    pending can be armed (H-1 disable at the source).
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate with is_multisig_target=true → reject 6111 (multisig custody disabled in V1)", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9100),
    );
    const target = Keypair.generate().publicKey;

    let caughtCode: number | null = null;
    try {
      await program.methods
        .initiateOwnershipTransfer(target, true)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "is_multisig_target=true MUST reject").to.equal(
      ERR_MULTISIG_CUSTODY_UNSUPPORTED,
    );
    // No pending was created.
    expect(accountExists(svm, pendingOwner)).to.equal(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. The accept handler rejects unconditionally (defense-in-depth for any
  //    pending that might pre-date the fix). We create a valid EOA-target
  //    pending (is_multisig_target=false, allowed) so account validation
  //    passes and the handler body is reached — it returns 6111 regardless.
  // ─────────────────────────────────────────────────────────────────────────
  it("accept_ownership_transfer_multisig rejects unconditionally → reject 6111", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9101),
    );

    // Arm a STANDARD (EOA) pending so the pending PDA exists and validates.
    const eoaTarget = Keypair.generate().publicKey;
    await program.methods
      .initiateOwnershipTransfer(eoaTarget, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    expect(accountExists(svm, pendingOwner)).to.equal(true);

    const mockMultisig = forgeMockMultisig(svm);

    let caughtCode: number | null = null;
    try {
      await program.methods
        .acceptOwnershipTransferMultisig()
        .accounts({
          multisigPda: mockMultisig,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(
      caughtCode,
      "accept_ownership_transfer_multisig MUST reject (disabled in V1)",
    ).to.equal(ERR_MULTISIG_CUSTODY_UNSUPPORTED);

    // Vault.owner unchanged; pending PDA still alive (no mutation, no close).
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(owner.publicKey.toString());
    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });
});
