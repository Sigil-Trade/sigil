/**
 * Item 3 — verified-build gate (PR-C) LiteSVM coverage.
 *
 * The gate (validate_and_authorize.rs::enforce_verified_build_if_armed +
 * utils/program_hash.rs::enforce_program_build_hash) lets a vault owner pin the
 * SHA-256 of an allowlisted protocol's deployed ELF into
 * `PolicyConfig.protocol_hashes` (index-aligned to `protocols`). At
 * validate-time, if the target protocol has a non-zero pinned hash, the program
 * recomputes the hash of the target's currently-deployed ELF (the
 * BPFLoaderUpgradeable `ProgramData` account, data past the 45-byte header) and
 * rejects the bundle if it differs — closing the upgrade-TOCTOU.
 *
 * Cases covered:
 *   (a) armed hash == deployed ELF                → validate PASSES
 *   (b) armed hash + ProgramData absent           → 6116 ErrProgramDataUnresolvable
 *   (c) armed hash != actual ELF hash             → 6117 ErrProgramBuildMismatch
 *   (d) all-zero (default) hash                   → gate skipped, PASSES
 *   (e) arming via queue→apply changes the policy digest (round-trip)
 *   (f) disarming (nonzero→zero) on a cosign vault is ELEVATED (needs cosign)
 *
 * The expected ELF hash is computed exactly as the SDK `getProgramDataHash`
 * does: sha256 of the ProgramData account data past the 45-byte header. The
 * mock-defi fixture's ELF is `tests/fixtures/mock-defi.so` (the same bytes
 * LiteSVM loads for execution); we additionally publish an upgradeable
 * ProgramData account for it so the gate can resolve + hash it.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import { fetchAndComputeQueueDigest } from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  mintToHelper,
  sendVersionedTx,
  advanceTime,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "./helpers/litesvm-setup";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import { expectSigilError } from "./helpers/strict-errors";

const MAX_ALLOWED_PROTOCOLS = 10;
const PROGRAM_DATA_HEADER_LEN = 45;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

// Mock-defi ELF (the bytes LiteSVM also loads for execution).
const MOCK_DEFI_SO_PATH = path.resolve(__dirname, "fixtures/mock-defi.so");

/** sha256(elf) — the value the SDK `getProgramDataHash` pins and the on-chain
 *  gate recomputes (it hashes `ProgramData.data[45..]`, which is exactly the
 *  ELF we write below). */
function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** Derive the canonical ProgramData PDA for an upgradeable program. */
function programDataPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

/**
 * Build the 45-byte `UpgradeableLoaderState::ProgramData` header followed by the
 * ELF, matching the layout the on-chain gate + SDK assume:
 *   4 bytes  enum discriminant (variant 3, LE)
 *   8 bytes  slot (u64 LE)
 *   1 byte   Option<Pubkey> tag (1 = Some)
 *  32 bytes  upgrade authority pubkey
 *   ...      raw ELF to EOF
 */
function buildProgramDataAccount(elf: Buffer, authority: PublicKey): Buffer {
  const header = Buffer.alloc(PROGRAM_DATA_HEADER_LEN);
  header.writeUInt32LE(3, 0); // ProgramData enum variant
  header.writeBigUInt64LE(0n, 4); // slot
  header.writeUInt8(1, 12); // Option tag = Some
  authority.toBuffer().copy(header, 13); // 32-byte authority
  return Buffer.concat([header, elf]);
}

/** Full 10-entry protocol_hashes array (number[][]) with `hash` at `idx`. */
function hashArrayAt(idx: number, hash: Buffer | null): number[][] {
  const arr: number[][] = [];
  for (let i = 0; i < MAX_ALLOWED_PROTOCOLS; i++) {
    if (i === idx && hash) arr.push(Array.from(hash));
    else arr.push(Array.from(Buffer.alloc(32)));
  }
  return arr;
}

describe("verified-build-gate (Item 3)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(7);

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let pendingPolicyPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  // The single allowlisted protocol is the real, loaded mock-defi program; the
  // sandwich's middle ix is its no-op open_position (zero spend) so the gate is
  // exercised independently of any spending path.
  const targetProtocol = MOCK_DEFI_PROGRAM_ID;
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  // mock-defi ELF + the hash the gate expects when armed to the real build.
  let mockDefiElf: Buffer;
  let correctHash: Buffer;
  let mockDefiProgramData: PublicKey;

  const TIMELOCK = new BN(1800);

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    [pendingPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vaultPda.toBuffer()],
      program.programId,
    );

    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });
    createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      feeDestination.publicKey,
    );
    protocolTreasuryUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
    );

    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      10_000_000_000n,
    );

    // Initialize the vault with mock-defi as the SOLE allowlisted protocol.
    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000),
        new BN(500_000_000),
        1,
        [targetProtocol],
        0,
        5000,
        TIMELOCK,
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
          dailySpendingCapUsd: new BN(1_000_000_000),
          maxTransactionSizeUsd: new BN(500_000_000),
          maxSlippageBps: 5000,
          protocolMode: 1,
          protocols: [targetProtocol],
          allowedDestinations: [],
          timelockDuration: TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });

    await program.methods
      .depositFunds(new BN(5_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Read the deployed mock-defi ELF + derive the expected build hash.
    mockDefiElf = fs.readFileSync(MOCK_DEFI_SO_PATH);
    correctHash = sha256(mockDefiElf);
    mockDefiProgramData = programDataPda(targetProtocol);

    // Publish an upgradeable ProgramData account for mock-defi whose ELF the
    // gate will hash. (addProgramFromFile loads mock-defi as a non-upgradeable
    // BPFLoader2 program with no ProgramData account; the gate reads the
    // upgradeable ProgramData PDA, which we create here.)
    publishProgramData(mockDefiElf);
  });

  /** (re)write the mock-defi ProgramData account with the given ELF bytes. */
  function publishProgramData(elf: Buffer): void {
    const data = buildProgramDataAccount(elf, owner.publicKey);
    const rentExempt = Number(
      svm.minimumBalanceForRentExemption(BigInt(data.length)),
    );
    svm.setAccount(mockDefiProgramData, {
      lamports: rentExempt,
      data,
      owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      executable: false,
    });
  }

  function removeProgramData(): void {
    // Zero-lamport, empty, system-owned account == "does not exist" for the
    // gate's `find` (the derived PDA won't be in remaining_accounts).
    svm.setAccount(mockDefiProgramData, {
      lamports: 0,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });
  }

  function getSessionPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    )[0];
  }

  /**
   * Build the validate ix. `includeProgramData` controls whether the mock-defi
   * ProgramData account is appended to remaining_accounts (the SDK seal()
   * satisfier appends it whenever a hash is armed). The F-Q1a agent
   * completeness account is always included (mirrors seal()).
   */
  async function buildValidateIx(amount: BN, includeProgramData: boolean) {
    const livePolicy = await program.account.policyConfig.fetch(policyPda);
    const remaining: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[] = [{ pubkey: agent.publicKey, isSigner: false, isWritable: false }];
    if (includeProgramData) {
      remaining.push({
        pubkey: mockDefiProgramData,
        isSigner: false,
        isWritable: false,
      });
    }
    return program.methods
      .validateAndAuthorize(
        usdcMint,
        amount,
        targetProtocol,
        livePolicy.policyVersion,
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount,
            targetProtocol,
          }),
        ),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: getSessionPda(),
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(remaining)
      .instruction();
  }

  async function buildFinalizeIx() {
    return program.methods
      .finalizeSession()
      .accountsPartial({
        payer: agent.publicKey,
        vault: vaultPda,
        session: getSessionPda(),
        sessionRentRecipient: agent.publicKey,
        policy: policyPda,
        tracker: trackerPda,
        vaultTokenAccount: vaultUsdcAta,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
      })
      .instruction();
  }

  /** Run a non-spending [validate, defi-noop, finalize] bundle. */
  async function runNoopSession(includeProgramData: boolean): Promise<void> {
    const validateIx = await buildValidateIx(new BN(0), includeProgramData);
    const defiIx = buildMockDefiNoopIx(agent.publicKey);
    const finalizeIx = await buildFinalizeIx();
    sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], agent);
  }

  /**
   * Owner-only queue→advance→apply that sets `protocol_hashes` to the given
   * full 10-entry array. Uses the merged-effective TA-19 digest helper so the
   * on-chain PolicyPreviewMismatch (6071) check passes.
   */
  async function setProtocolHashes(hashAtZero: Buffer | null): Promise<void> {
    const fullArray = hashArrayAt(0, hashAtZero);
    const overrideHashes =
      hashAtZero === null
        ? [Buffer.alloc(32)] // disarm index 0 (was armed); index-aligned to 1 protocol
        : [hashAtZero];
    const digest = await fetchAndComputeQueueDigest(
      program,
      policyPda,
      vaultPda,
      { protocolHashes: overrideHashes },
    );
    await program.methods
      .queuePolicyUpdate(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        fullArray, // protocol_hashes (Item 3)
        PublicKey.default, // cosign_session (non-elevated)
        digest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, TIMELOCK.toNumber() + 1);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
      } as any)
      .rpc();
  }

  // ─── Tests ───────────────────────────────────────────────────────────────

  it("(d) all-zero hash (default) → gate skipped, validate passes", async () => {
    // Fresh vault: protocol_hashes is all-zero. No ProgramData needed.
    const policy = await program.account.policyConfig.fetch(policyPda);
    expect(
      Buffer.from(policy.protocolHashes[0]).equals(Buffer.alloc(32)),
      "index 0 starts disarmed",
    ).to.equal(true);
    await runNoopSession(/* includeProgramData */ false);
  });

  it("(e) arming a hash via queue→apply changes the policy digest (round-trip)", async () => {
    const before = await program.account.policyConfig.fetch(policyPda);
    const versionBefore = before.policyVersion;

    await setProtocolHashes(correctHash);

    const after = await program.account.policyConfig.fetch(policyPda);
    // The pinned hash now lives at index 0, index-aligned to the sole protocol.
    expect(
      Buffer.from(after.protocolHashes[0]).equals(correctHash),
      "index 0 now holds the pinned build hash",
    ).to.equal(true);
    // Applying a policy mutation bumps the policy version (digest round-trip).
    expect(after.policyVersion.toString()).to.not.equal(
      versionBefore.toString(),
    );
  });

  it("(a) armed hash matching the deployed ELF → validate passes", async () => {
    // Precondition: armed from test (e). ProgramData published in `before`.
    const policy = await program.account.policyConfig.fetch(policyPda);
    expect(Buffer.from(policy.protocolHashes[0]).equals(correctHash)).to.equal(
      true,
    );
    await runNoopSession(/* includeProgramData */ true);
  });

  it("(b) armed hash + ProgramData absent from remaining_accounts → 6116", async () => {
    // Armed, but DO NOT include the ProgramData account → fail-closed.
    try {
      await runNoopSession(/* includeProgramData */ false);
      expect.fail("expected ErrProgramDataUnresolvable (6116)");
    } catch (err) {
      expectSigilError(err, { name: "ErrProgramDataUnresolvable" });
    }
  });

  it("(b2) armed hash + ProgramData account removed entirely → 6116", async () => {
    removeProgramData();
    try {
      await runNoopSession(/* includeProgramData */ true);
      expect.fail("expected ErrProgramDataUnresolvable (6116)");
    } catch (err) {
      expectSigilError(err, { name: "ErrProgramDataUnresolvable" });
    } finally {
      // Restore the genuine ProgramData for subsequent tests.
      publishProgramData(mockDefiElf);
    }
  });

  it("(c) armed hash != actual ELF hash → 6117 ErrProgramBuildMismatch", async () => {
    // Re-pin to a WRONG (but non-zero) hash; the deployed ELF is unchanged, so
    // the on-chain recompute diverges. Re-pinning to a different non-zero hash
    // is non-elevated (tightening/neutral) → standard timelock queue/apply.
    const wrongHash = sha256(Buffer.concat([mockDefiElf, Buffer.from([0xff])]));
    await setProtocolHashes(wrongHash);
    try {
      await runNoopSession(/* includeProgramData */ true);
      expect.fail("expected ErrProgramBuildMismatch (6117)");
    } catch (err) {
      expectSigilError(err, { name: "ErrProgramBuildMismatch" });
    }
  });

  it("(c2) tampered ELF (real hash pinned, deployed build changed) → 6117", async () => {
    // Re-pin to the CORRECT hash, then tamper the deployed ELF so the recompute
    // diverges — the upgrade-TOCTOU the gate exists to close.
    await setProtocolHashes(correctHash);
    const tampered = Buffer.concat([mockDefiElf, Buffer.from([0x00])]);
    publishProgramData(tampered);
    try {
      await runNoopSession(/* includeProgramData */ true);
      expect.fail("expected ErrProgramBuildMismatch (6117)");
    } catch (err) {
      expectSigilError(err, { name: "ErrProgramBuildMismatch" });
    } finally {
      publishProgramData(mockDefiElf); // restore genuine build
    }
  });

  it("(a2) after restoring the genuine build, armed validate passes again", async () => {
    // protocol_hashes[0] == correctHash (from c2 setup); deployed ELF restored.
    await runNoopSession(/* includeProgramData */ true);
  });

  it("(f) disarming (nonzero→zero) on a cosign-required vault is ELEVATED", async () => {
    // Bind a cosigner + enable cosign_required (non-elevated safety improvement),
    // then attempt to DISARM the build hash with a non-elevated (default cosign
    // session) queue — the on-chain `disarms_build_hash` trigger must reject it
    // as elevated (ErrCosignRequired) because disarming weakens the gate.
    const cosigner = Keypair.generate();

    // Step 1: enable cosign + bind the cosigner pubkey (both non-elevated).
    const enableDigest = await fetchAndComputeQueueDigest(
      program,
      policyPda,
      vaultPda,
      { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
    );
    await program.methods
      .queuePolicyUpdate(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        true, // cosign_required → enable
        cosigner.publicKey, // cosign_session_pubkey → bind
        null,
        null, // protocol_hashes (no change)
        PublicKey.default, // cosign_session (enabling cosign is non-elevated)
        enableDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    advanceTime(svm, TIMELOCK.toNumber() + 1);
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
      } as any)
      .rpc();

    const armed = await program.account.policyConfig.fetch(policyPda);
    expect(armed.cosignRequired).to.equal(true);
    expect(
      Buffer.from(armed.protocolHashes[0]).equals(correctHash),
      "still armed before the disarm attempt",
    ).to.equal(true);

    // Step 2: attempt to DISARM with a NON-elevated (default) cosign session.
    // disarms_build_hash makes this elevated on a cosign vault → ErrCosignRequired.
    const disarmArray = hashArrayAt(0, null); // all-zero
    const disarmDigest = await fetchAndComputeQueueDigest(
      program,
      policyPda,
      vaultPda,
      { protocolHashes: [Buffer.alloc(32)] },
    );
    try {
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          disarmArray, // protocol_hashes → DISARM (nonzero→zero)
          PublicKey.default, // cosign_session = default → NOT the bound cosigner
          disarmDigest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          pendingPolicy: pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail(
        "expected ErrCosignRequired (disarm is elevated on a cosign vault)",
      );
    } catch (err) {
      expectSigilError(err, { name: "ErrCosignRequired" });
    }

    // The disarm was rejected — the gate is still armed.
    const stillArmed = await program.account.policyConfig.fetch(policyPda);
    expect(
      Buffer.from(stillArmed.protocolHashes[0]).equals(correctHash),
      "disarm rejected — hash unchanged",
    ).to.equal(true);
  });
});
