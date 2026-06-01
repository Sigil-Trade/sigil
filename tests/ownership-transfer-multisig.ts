/**
 * Phase 8 Batch 4 — C26 ownership transfer (Squads V4 multisig accept variant).
 *
 * Sibling suite to `ownership-transfer.ts` (Batch 3). Covers the multisig
 * accept path where `pending.is_multisig_target == true` and the new owner is
 * a Squads V4 multisig vault PDA (program-owned, no private key).
 *
 * Mock multisig strategy:
 *   LiteSVM has no real Squads V4 deployment. We forge a "mock multisig PDA"
 *   by generating a fresh Keypair and using `svm.setAccount(...)` to set its
 *   `.owner` field to `SQUADS_V4_PROGRAM_ID`. The handler's only structural
 *   check on the multisig is `multisig_pda.owner == &SQUADS_V4_PROGRAM_ID`,
 *   which this forgery satisfies. The keypair's private key is NEVER signed
 *   with — the ix passes the multisig PDA as an UncheckedAccount, not Signer.
 *
 * Coverage map (Council ISC labels in parens):
 *   1. Happy: initiate(is_multisig_target=true) → wait → multisig accept     (ISC-42..48)
 *   2. Wrong owner program: forge multisig owned by SystemProgram → REJECT   (ISC-A7, 6107)
 *   3. new_owner mismatch: pass mock_B when pending bound to mock_A          → REJECT (6104)
 *   4. is_multisig_target=false reject: standard pending via multisig handler → REJECT (6104)
 *   5. Timelock not elapsed: accept at queued_at + min_delay - 1             → REJECT (6104)
 *
 * Each test uses a unique vault_id (9100+) to keep state isolated from the
 * Batch 3 suite (9000-9010 range).
 *
 * Audit-log discriminator sanity: happy path also asserts disc=8 written
 * (mirrors the EOA accept path — the via_multisig flag lives in the event,
 * not a separate disc byte).
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
  advanceTime,
  accountExists,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// Mirrors PendingOwnershipTransfer::DEFAULT_MIN_DELAY (48h).
const DEFAULT_MIN_DELAY = 172_800;

// Audit-log discriminators (mirrors state/audit_log_success.rs).
const DISC_OWNERSHIP_ACCEPT = 8;

// Per-entry layout — must match programs/sigil/src/state/audit_log_success.rs.
const ENTRY_SIZE = 64;
const SUCCESS_CAPACITY = 128;
const ENTRIES_OFFSET = 8 + 32;

/**
 * Squads V4 program ID — mirrors `programs/sigil/src/state/mod.rs`.
 * Base58: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
 *
 * IMPORTANT: any drift between this constant and the on-chain
 * `SQUADS_V4_PROGRAM_ID` must FAIL the test suite (the mock-multisig
 * "owned by Squads" forgery would no longer satisfy the handler's check).
 */
const SQUADS_V4_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);

/** Decode the last-written audit-log success buffer entry's discriminator. */
function lastSuccessDisc(svm: LiteSVM, auditSuccess: PublicKey): number {
  const acct = svm.getAccount(auditSuccess);
  if (!acct) throw new Error("audit log missing");
  const buf = Buffer.from(acct.data);
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  const head = buf[entriesEnd];
  const count = buf[entriesEnd + 1];
  if (count === 0) throw new Error("audit log empty");
  const lastIdx = (head + SUCCESS_CAPACITY - 1) % SUCCESS_CAPACITY;
  return buf[ENTRIES_OFFSET + lastIdx * ENTRY_SIZE + 63];
}

/**
 * Forge a mock multisig PDA owned by the supplied owner program. The data
 * payload is opaque to the Sigil handler — only the `.owner` field is
 * structurally checked. Generates a fresh Keypair so each call returns a
 * unique pubkey; the keypair's private key is NEVER used (the ix passes the
 * multisig as an UncheckedAccount, not Signer).
 *
 * Returns the forged pubkey.
 */
function forgeMockMultisig(svm: LiteSVM, ownerProgram: PublicKey): PublicKey {
  const kp = Keypair.generate();
  const data = Buffer.alloc(200); // arbitrary opaque payload
  // Rent-exempt for 200 bytes (LiteSVM uses Solana's standard rent math).
  const rentExempt = Number(svm.minimumBalanceForRentExemption(BigInt(200)));
  svm.setAccount(kp.publicKey, {
    lamports: rentExempt,
    data,
    owner: ownerProgram,
    executable: false,
  });
  return kp.publicKey;
}

describe("ownership-transfer-multisig (Phase 8 Batch 4 — Squads V4 accept)", () => {
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

  /**
   * Initialize a fresh vault. Returns the PDAs the ownership-transfer
   * handlers consume. Mirrors the Batch 3 suite's helper exactly.
   */
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
  // 1. HAPPY PATH — initiate(is_multisig_target=true) → wait → multisig accept.
  // ─────────────────────────────────────────────────────────────────────────
  it("happy path: initiate(multisig_target=true) + wait + multisig accept → vault.owner mutates to multisig PDA, pending closes", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9100),
    );

    // Forge a mock Squads-owned multisig PDA. The handler will accept this as
    // a valid Squads multisig because its `.owner == SQUADS_V4_PROGRAM_ID`.
    const mockMultisig = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);

    // Initiate WITH is_multisig_target=true bound to the mock multisig pubkey.
    await program.methods
      .initiateOwnershipTransfer(mockMultisig, true)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // ASSERT — pending PDA bound to multisig + flag set.
    const pendingState =
      await program.account.pendingOwnershipTransfer.fetch(pendingOwner);
    expect(pendingState.newOwner.toString()).to.equal(mockMultisig.toString());
    expect(pendingState.isMultisigTarget).to.equal(true);

    // Advance past the timelock window.
    advanceTime(svm, DEFAULT_MIN_DELAY);

    // ACT — multisig accept. No `.signers([...])` — multisig PDA is UncheckedAccount.
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

    // ASSERT — vault.owner mutated to multisig PDA, pending closed, audit disc=8.
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(mockMultisig.toString());
    expect(accountExists(svm, pendingOwner)).to.equal(false);
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(DISC_OWNERSHIP_ACCEPT);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. WRONG OWNER PROGRAM — forge multisig owned by SystemProgram, not Squads.
  //    Handler's `multisig_pda.owner == &SQUADS_V4_PROGRAM_ID` check rejects.
  // ─────────────────────────────────────────────────────────────────────────
  it("wrong owner program: forge multisig owned by SystemProgram → reject 6107 ErrInvalidOwnershipTarget", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9101),
    );

    // Forge an account owned by SystemProgram (NOT Squads V4).
    const fakeMultisig = forgeMockMultisig(svm, SystemProgram.programId);

    // Initiate bound to the fake multisig (initiate doesn't verify owner program;
    // it just records the target pubkey).
    await program.methods
      .initiateOwnershipTransfer(fakeMultisig, true)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, DEFAULT_MIN_DELAY);

    let caughtCode: number | null = null;
    try {
      await program.methods
        .acceptOwnershipTransferMultisig()
        .accounts({
          multisigPda: fakeMultisig,
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
    expect(caughtCode, "wrong-owner-program multisig accept MUST reject").to.not
      .be.null;
    expect(caughtCode).to.equal(6098); // ErrInvalidOwnershipTarget

    // Pending PDA still alive.
    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. new_owner MISMATCH — initiate bound to mock_A, pass mock_B at accept.
  //    Handler's `require_keys_eq!(multisig_pda.key(), pending.new_owner)`
  //    catches the substitution.
  // ─────────────────────────────────────────────────────────────────────────
  it("new_owner mismatch: initiate to mock_A, accept passes mock_B → reject 6104 ErrPendingOwnershipNotReady", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9102),
    );

    const mockA = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);
    const mockB = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);

    // Initiate to mock_A.
    await program.methods
      .initiateOwnershipTransfer(mockA, true)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, DEFAULT_MIN_DELAY);

    // Accept passes mock_B — both are Squads-owned (so the owner-program gate
    // passes), but only mock_A is the queued target.
    let caughtCode: number | null = null;
    try {
      await program.methods
        .acceptOwnershipTransferMultisig()
        .accounts({
          multisigPda: mockB,
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
    expect(caughtCode, "mock_B substituted for mock_A MUST reject").to.not.be
      .null;
    expect(caughtCode).to.equal(6095); // ErrPendingOwnershipNotReady

    // Pending PDA still alive (no mutation occurred).
    expect(accountExists(svm, pendingOwner)).to.equal(true);

    // ASSERT — vault.owner UNCHANGED.
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(owner.publicKey.toString());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. is_multisig_target=false on multisig handler.
  //    Symmetric with Batch 3 test 11 (EOA handler rejects multisig pending).
  //    Multisig handler MUST reject standard-target pendings to prevent the
  //    inverse back-door.
  // ─────────────────────────────────────────────────────────────────────────
  it("is_multisig_target=false pending on multisig handler → reject 6104 ErrPendingOwnershipNotReady", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9103),
    );

    // Forge a Squads-owned mock multisig (so the owner-program gate passes).
    const mockMultisig = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);

    // Initiate WITH is_multisig_target=false (standard EOA flow). Even though
    // we bind to a Squads-owned pubkey, the multisig handler must reject
    // because the pending flag says "standard."
    await program.methods
      .initiateOwnershipTransfer(mockMultisig, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, DEFAULT_MIN_DELAY);

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
      "standard-target pending on multisig handler MUST reject",
    ).to.not.be.null;
    expect(caughtCode).to.equal(6095); // ErrPendingOwnershipNotReady

    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. TIMELOCK NOT ELAPSED — accept at queued_at + min_delay - 1.
  //    Mirrors the Batch 3 boundary test but on the multisig handler.
  // ─────────────────────────────────────────────────────────────────────────
  it("boundary: multisig accept at queued_at + min_delay - 1 → reject 6104", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9104),
    );

    const mockMultisig = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);

    await program.methods
      .initiateOwnershipTransfer(mockMultisig, true)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Advance to ONE SECOND BEFORE the timelock window.
    advanceTime(svm, DEFAULT_MIN_DELAY - 1);

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
    expect(caughtCode, "pre-timelock multisig accept MUST reject").to.not.be
      .null;
    expect(caughtCode).to.equal(6095); // ErrPendingOwnershipNotReady

    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // M1-02: freeze is terminal on the multisig accept path too.
  //
  // Mirror of the single-sig EXPLOIT-BLOCKED test for the Squads V4 multisig
  // accept handler. A phished owner queues a multisig-target transfer, the real
  // owner freezes, and the attacker waits out the 48h timelock. The status==Active
  // gate at the head of accept_ownership_transfer_multisig
  // (require!(status == Active, VaultNotActive) === 6000) must reject the accept,
  // leaving vault.owner unchanged and the pending PDA intact.
  // ───────────────────────────────────────────────────────────────────────────
  it("M1-02 EXPLOIT-BLOCKED: multisig accept on a frozen vault after timelock → reject 6000, owner unchanged", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9300),
    );
    const originalOwner = owner.publicKey;
    const mockMultisig = forgeMockMultisig(svm, SQUADS_V4_PROGRAM_ID);

    // ACT 1 — initiate with is_multisig_target=true (vault still Active).
    await program.methods
      .initiateOwnershipTransfer(mockMultisig, true)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // ACT 2 — real owner freezes the vault (kill-switch).
    await program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();

    // ACT 3 — advance past the full timelock and attempt the multisig accept.
    advanceTime(svm, DEFAULT_MIN_DELAY);
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

    // ASSERT — accept rejected with VaultNotActive (6000); freeze held:
    // vault.owner is STILL the original owner, not the multisig PDA, and the
    // pending PDA survives (accept never executed).
    expect(
      caughtCode,
      "frozen-vault multisig accept MUST reject 6000",
    ).to.equal(6000);
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(originalOwner.toString());
    expect(vaultState.owner.toString()).to.not.equal(mockMultisig.toString());
    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });
});
