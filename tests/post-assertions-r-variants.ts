/**
 * Phase 6 (Maestro borrows) — R-1 / R-2 / R-3 / R-4 adversarial tests.
 *
 * Covers BOTH positive (configuration accepted, action succeeds) AND
 * negative (attack rejected with the right error code) paths for each
 * of the four new post-execution assertion variants. Phase 6 Audit #2
 * F-15 noted the prior commits had "3 REJECT 0 PASS" — these tests
 * close that gap by exercising positive paths too.
 *
 * Scope tradeoff: a full validate→DeFi→finalize sandwich for each
 * variant would require either (a) a mock DeFi program registered with
 * LiteSVM that we can drive deterministically, or (b) the actual
 * Jupiter/Drift/etc. binaries surfpooled in. Both are heavier than the
 * Phase 6 budget. Instead these tests exercise:
 *
 *   1. `create_post_assertions` happy-path acceptance — proves the new
 *      entry schema serializes/deserializes round-trip through Anchor
 *      Borsh, and that validate_entries accepts the entry shape.
 *   2. `create_post_assertions` rejection paths — proves the new
 *      validate_entries rules fire on each malformed entry shape.
 *
 * The finalize-time enforcement is exercised by the Rust unit tests at
 * programs/sigil/src/state/post_assertions.rs (218 cases as of HEAD).
 * Full sandwich-level coverage is owned by the Phase 6 follow-on
 * integration suite (see Phase 6 §RP closure document).
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
import { expectAnchorError, expectSigilError } from "./helpers/strict-errors";
import {
  initVaultPreviewDigest,
  siblingHandlerDigest,
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

describe("post-assertions: Phase 6 Maestro borrows (R-1..R-4)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();

  // Counter to give each vault a distinct vault_id so test setup state
  // doesn't bleed across cases.
  let vaultIdCounter = 9000;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;
    airdropSol(svm, owner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);
  });

  /**
   * Fresh observe-only vault with all post-assertion-related PDAs derived.
   * Returns the PDAs the create_post_assertions ix needs.
   */
  async function freshVault(): Promise<{
    vaultPda: PublicKey;
    policyPda: PublicKey;
    postAssertionsPda: PublicKey;
  }> {
    const vaultId = new BN(vaultIdCounter++);

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    const [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [postAssertionsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("post_assertions"), vaultPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        [],
        0,
        100,
        new BN(1800),
        [],
        [],
        true, // observeOnly (F-11)
        0x00ffffff,
        false,
        5,
        new BN(0),
        new BN(0),
        false,
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          observeOnly: true,
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

    return { vaultPda, policyPda, postAssertionsPda };
  }

  /**
   * Helper: build a fresh-vault digest for create_post_assertions where the
   * mutation is "set has_post_assertions = 1".
   */
  async function digestForCreatePA(
    policyPda: PublicKey,
    vaultPda: PublicKey,
  ): Promise<number[]> {
    return siblingHandlerDigest(program, policyPda, vaultPda, {
      hasPostAssertions: 1,
    });
  }

  // ─── R-1 MintDeltaCap ────────────────────────────────────────────────

  describe("R-1 MintDeltaCap (mode=4) — validate-time acceptance", () => {
    it("PASS: scope=0 vault-wide MintDeltaCap entry is accepted", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;

      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);

      const digest = await digestForCreatePA(policyPda, vaultPda);
      await program.methods
        .createPostAssertions(
          [
            {
              targetAccount: PublicKey.default,
              offset: 0,
              valueLen: 0,
              operator: 0,
              expectedValue: expected,
              assertionMode: 4,
              auxValue: Array.from(new BN(1_000_000).toArray("le", 8)),
              auxByte: 0,
            } as any,
          ],
          digest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Read raw bytes to bypass Anchor's struct-shape inference (older
      // Anchor versions may silently drop unknown fields when the
      // PostAssertionEntry shape evolves). Layout of PostAssertionEntryZC:
      //   [0..32]   target_account
      //   [32..34]  offset (u16)
      //   [34]      value_len
      //   [35]      operator
      //   [36..68]  expected_value
      //   [68]      assertion_mode
      //   [69..77]  aux_value (u64 LE)
      //   [77]      aux_byte
      const acct = svm.getAccount(postAssertionsPda);
      expect(acct).to.not.equal(null);
      const data = Buffer.from(acct!.data);
      // PostExecutionAssertions: disc [0..8] + vault [8..40] + entries
      // start at byte 40, each 78 bytes.
      const entry0 = data.subarray(40, 40 + 78);
      expect(entry0[68]).to.equal(4); // assertion_mode
      expect(entry0.readBigUInt64LE(69)).to.equal(1_000_000n);
      expect(entry0[77]).to.equal(0); // aux_byte
      // entry_count is at byte 40 + (78*8) = 664
      expect(data[40 + 78 * 8]).to.equal(1);
    });

    it("PASS: scope=1 single-account MintDeltaCap entry is accepted", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;
      const targetAta = Keypair.generate().publicKey;

      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      await program.methods
        .createPostAssertions(
          [
            {
              targetAccount: targetAta,
              offset: 0,
              valueLen: 0,
              operator: 0,
              expectedValue: expected,
              assertionMode: 4,
              auxValue: Array.from(new BN(500_000).toArray("le", 8)),
              auxByte: 1,
            } as any,
          ],
          digest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Use raw byte read — Anchor's fetcher may camelCase fields differently
      // across versions; raw bytes are the authoritative wire format.
      const acct = svm.getAccount(postAssertionsPda);
      const data = Buffer.from(acct!.data);
      const entry0 = data.subarray(40, 40 + 78);
      expect(entry0[68]).to.equal(4);
      expect(entry0[77]).to.equal(1); // scope=1
    });

    it("REJECT: MintDeltaCap with scope > 1 fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: PublicKey.default,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 4,
                auxValue: Array.from(new BN(100).toArray("le", 8)),
                auxByte: 2, // invalid scope
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected scope=2 to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });

    it("REJECT: MintDeltaCap with zero max_net_decrease fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: PublicKey.default,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 4,
                auxValue: Array.from(new BN(0).toArray("le", 8)), // 0 cap
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected zero max_net_decrease to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });
  });

  // ─── R-2 AtaAuthorityPin ─────────────────────────────────────────────

  describe("R-2 AtaAuthorityPin (mode=5) — validate-time acceptance", () => {
    it("PASS: AtaAuthorityPin entry with a real target is accepted", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const ata = Keypair.generate().publicKey;
      const digest = await digestForCreatePA(policyPda, vaultPda);

      await program.methods
        .createPostAssertions(
          [
            {
              targetAccount: ata,
              offset: 0,
              valueLen: 0,
              operator: 0,
              expectedValue: Buffer.alloc(0),
              assertionMode: 5,
              auxValue: Array.from(new BN(0).toArray("le", 8)),
              auxByte: 0,
            } as any,
          ],
          digest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct = svm.getAccount(postAssertionsPda);
      const data = Buffer.from(acct!.data);
      const entry0 = data.subarray(40, 40 + 78);
      expect(entry0[68]).to.equal(5); // mode AtaAuthorityPin
      expect(entry0.subarray(0, 32).equals(ata.toBuffer())).to.equal(true);
    });

    it("REJECT: AtaAuthorityPin with default(zero) target fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: PublicKey.default,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: Buffer.alloc(0),
                assertionMode: 5,
                auxValue: Array.from(new BN(0).toArray("le", 8)),
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected default target to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });

    it("REJECT: AtaAuthorityPin with non-zero aux_value fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const ata = Keypair.generate().publicKey;
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: ata,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: Buffer.alloc(0),
                assertionMode: 5,
                auxValue: Array.from(new BN(1).toArray("le", 8)), // forbidden
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected non-zero aux_value on mode 5 to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });
  });

  // ─── R-3 OutputBalanceFloor ──────────────────────────────────────────

  describe("R-3 OutputBalanceFloor (mode=6) — validate-time acceptance", () => {
    it("PASS: OutputBalanceFloor entry is accepted and round-trips", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const tokenAccount = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      await program.methods
        .createPostAssertions(
          [
            {
              targetAccount: tokenAccount,
              offset: 0,
              valueLen: 0,
              operator: 0,
              expectedValue: expected,
              assertionMode: 6,
              auxValue: Array.from(new BN(2_500_000).toArray("le", 8)),
              auxByte: 0,
            } as any,
          ],
          digest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct = svm.getAccount(postAssertionsPda);
      const data = Buffer.from(acct!.data);
      const entry0 = data.subarray(40, 40 + 78);
      expect(entry0[68]).to.equal(6); // mode OutputBalanceFloor
      expect(entry0.readBigUInt64LE(69)).to.equal(2_500_000n);
    });

    it("REJECT: OutputBalanceFloor with zero min_increase fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const tokenAccount = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: tokenAccount,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 6,
                auxValue: Array.from(new BN(0).toArray("le", 8)),
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected zero min_increase to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });

    it("REJECT: OutputBalanceFloor with default target fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: PublicKey.default,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 6,
                auxValue: Array.from(new BN(1000).toArray("le", 8)),
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected default target to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });
  });

  // ─── R-4 DeclarationConsistency ──────────────────────────────────────

  describe("R-4 DeclarationConsistency (mode=7) — validate-time acceptance", () => {
    it("PASS: DeclarationConsistency entry is accepted and round-trips", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const recipient = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      await program.methods
        .createPostAssertions(
          [
            {
              targetAccount: recipient,
              offset: 0,
              valueLen: 0,
              operator: 0,
              expectedValue: expected,
              assertionMode: 7,
              auxValue: Array.from(new BN(0).toArray("le", 8)),
              auxByte: 3, // meta index
            } as any,
          ],
          digest,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct = svm.getAccount(postAssertionsPda);
      const data = Buffer.from(acct!.data);
      const entry0 = data.subarray(40, 40 + 78);
      expect(entry0[68]).to.equal(7); // mode DeclarationConsistency
      expect(entry0[77]).to.equal(3); // aux_byte = meta_index
      expect(entry0.subarray(0, 32).equals(recipient.toBuffer())).to.equal(
        true,
      );
    });

    it("REJECT: DeclarationConsistency with meta_index >= 64 fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const recipient = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: recipient,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 7,
                auxValue: Array.from(new BN(0).toArray("le", 8)),
                auxByte: 64,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected meta_index=64 to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });

    it("REJECT: DeclarationConsistency with default recipient fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const mint = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32);
      mint.toBuffer().copy(expected, 0);
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: PublicKey.default,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 7,
                auxValue: Array.from(new BN(0).toArray("le", 8)),
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected default recipient to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });

    it("REJECT: DeclarationConsistency with zero declared_mint fails validate_entries", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const recipient = Keypair.generate().publicKey;
      const expected = Buffer.alloc(32); // all zeros = default mint
      const digest = await digestForCreatePA(policyPda, vaultPda);

      try {
        await program.methods
          .createPostAssertions(
            [
              {
                targetAccount: recipient,
                offset: 0,
                valueLen: 0,
                operator: 0,
                expectedValue: expected,
                assertionMode: 7,
                auxValue: Array.from(new BN(0).toArray("le", 8)),
                auxByte: 0,
              } as any,
            ],
            digest,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected default declared_mint to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });
  });

  // ─── Multi-entry capacity ────────────────────────────────────────────

  describe("capacity — MAX_POST_ASSERTION_ENTRIES = 8", () => {
    it("PASS: 8 mixed-mode entries are accepted on a single PDA", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const digest = await digestForCreatePA(policyPda, vaultPda);
      const mint = Keypair.generate().publicKey;
      const mintBytes = Buffer.alloc(32);
      mint.toBuffer().copy(mintBytes, 0);

      // Mix all four Phase 6 modes plus a legacy Absolute entry to
      // exhaust capacity. R-1, R-2, R-3, R-4, then 4 Absolute legacy.
      const entries = [
        // R-1 scope=0
        {
          targetAccount: PublicKey.default,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: mintBytes,
          assertionMode: 4,
          auxValue: Array.from(new BN(1_000_000).toArray("le", 8)),
          auxByte: 0,
        },
        // R-2
        {
          targetAccount: Keypair.generate().publicKey,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: Buffer.alloc(0),
          assertionMode: 5,
          auxValue: Array.from(new BN(0).toArray("le", 8)),
          auxByte: 0,
        },
        // R-3
        {
          targetAccount: Keypair.generate().publicKey,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: mintBytes,
          assertionMode: 6,
          auxValue: Array.from(new BN(500_000).toArray("le", 8)),
          auxByte: 0,
        },
        // R-4
        {
          targetAccount: Keypair.generate().publicKey,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: mintBytes,
          assertionMode: 7,
          auxValue: Array.from(new BN(0).toArray("le", 8)),
          auxByte: 0,
        },
        // 4× legacy Absolute (mode 0) entries
        ...Array.from({ length: 4 }, () => ({
          targetAccount: Keypair.generate().publicKey,
          offset: 0,
          valueLen: 8,
          operator: 3, // Lte
          expectedValue: Buffer.from(new BN(1_000_000).toArray("le", 8)),
          assertionMode: 0,
          auxValue: Array.from(new BN(0).toArray("le", 8)),
          auxByte: 0,
        })),
      ];

      await program.methods
        .createPostAssertions(entries as any, digest)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct = svm.getAccount(postAssertionsPda);
      const data = Buffer.from(acct!.data);
      // entry_count at byte 40 + 78*8 = 664
      expect(data[40 + 78 * 8]).to.equal(8);
      // Modes appear in the order provided; mode byte is at offset 68 within each entry.
      for (let i = 0; i < 4; i++) {
        const modeOffset = 40 + 78 * i + 68;
        expect(data[modeOffset]).to.equal(4 + i);
      }
    });

    it("REJECT: 9 entries exceeds MAX_POST_ASSERTION_ENTRIES=8", async () => {
      const { vaultPda, policyPda, postAssertionsPda } = await freshVault();
      const digest = await digestForCreatePA(policyPda, vaultPda);

      const tooMany = Array.from({ length: 9 }, () => ({
        targetAccount: Keypair.generate().publicKey,
        offset: 0,
        valueLen: 8,
        operator: 3,
        expectedValue: Buffer.from(new BN(1).toArray("le", 8)),
        assertionMode: 0,
        auxValue: Array.from(new BN(0).toArray("le", 8)),
        auxByte: 0,
      }));

      try {
        await program.methods
          .createPostAssertions(tooMany as any, digest)
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            postAssertions: postAssertionsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("expected 9 entries to reject");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidConstraintConfig" });
      }
    });
  });
});
