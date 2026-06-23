/**
 * M1-03 — Systemic frozen-status gate sweep (LiteSVM behavioral coverage).
 *
 * Principle (locked 2026-05-31): when a vault is FROZEN, "additive" owner
 * actions (those that ADD capability/risk, or that a phished owner key could
 * abuse) MUST be rejected with VaultNotActive (6000); "subtractive/defensive"
 * actions (those that REMOVE capability/risk, letting the owner mitigate during
 * a freeze) MUST still work. Only the owner's deliberate `reactivate_vault`
 * (separate cooldown + cosign-on-FULL) re-enables the additive surface.
 *
 * GATED (reject 6000 on a frozen vault) — proven below:
 *   register_agent, unpause_agent, promote_graylist_destination,
 *   queue_policy_update, queue_agent_permissions_update,
 *   apply_pending_policy, apply_agent_permissions_update,
 *   set_observe_only(false)  [only the additive direction is gated]
 *
 * EXCEPTION (still succeed while frozen) — proven below:
 *   set_observe_only(true), revoke_agent, pause_agent,
 *   cancel_pending_policy, deposit_funds
 *
 * NOTE on auto-freeze: `revoke_agent` auto-freezes the vault when it removes
 * the LAST agent (revoke_agent.rs:94, FreezeReason::AutoRevoke). Tests that need
 * an agent present on a still-frozen vault therefore register TWO agents before
 * freezing, so a single revoke/pause leaves the vault frozen-with-agents.
 *
 * Shapes (account structs, arg orders, the 19-arg queuePolicyUpdate, the
 * applyAgentPermissionsUpdate remaining-accounts workaround, deposit ATA setup)
 * are copied verbatim from tests/audit-log-coverage.ts + tests/missing-coverage.ts.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  createAtaHelper,
  mintToHelper,
  DEVNET_USDC_MINT,
  advanceTime,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

const CAPABILITY_VIEWER = 1; // no cosign gate on reactivate (FULL=2 would gate)
const CAPABILITY_OPERATOR = 2;
const REACTIVATE_COOLDOWN_SECONDS = 300; // reactivate_vault.rs C28 cooldown

const VAULT_NOT_ACTIVE = 6000;

/** Capture the on-chain error code from a rejected ix (null if it succeeded). */
async function expectCode(p: Promise<unknown>): Promise<number | null> {
  try {
    await p;
    return null;
  } catch (err: any) {
    return err?.error?.errorCode?.number ?? null;
  }
}

describe("M1-03: systemic frozen-gate", () => {
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
          createdAtSlot: Number(svm.getClock().slot),
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

    return { vault, policy, tracker, overlay, auditSuccess, auditRejected };
  }

  function pendingPolicyPda(vault: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    )[0];
  }
  function pendingAgentPermsPda(vault: PublicKey, agent: PublicKey): PublicKey {
    // seeds = ["pending_agent_perms", vault, agent] (queue_agent_permissions_update.rs:34)
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_perms"), vault.toBuffer(), agent.toBuffer()],
      program.programId,
    )[0];
  }

  const freeze = (vault: PublicKey) =>
    program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();

  // F-Q6 (2026-06-02): an instant OPERATOR grant on a single-key vault now
  // reverts ErrOperatorGrantRequiresTimelock (6107) — only the timelocked
  // queue→apply path can seat an OPERATOR. Every register() here is setup-only:
  // the agent merely needs to EXIST so the vault can be frozen / revoked /
  // reactivated (frozen-gate tests never open a spending session), so OBSERVER
  // (CAPABILITY_VIEWER=1) is the correct capability and is unaffected by the
  // F-Q6 tier gate. The NEGATIVE register-on-frozen tests still revert 6000
  // (VaultNotActive) because the frozen check fires before the tier check.
  const register = (
    vault: PublicKey,
    policy: PublicKey,
    overlay: PublicKey,
    agent: PublicKey,
    cap = CAPABILITY_VIEWER,
  ) =>
    program.methods
      .registerAgent(agent, cap, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

  // ───────────────────────────────────────────────────────────────────────
  // GATED — must reject 6000 (VaultNotActive) on a frozen vault.
  // ───────────────────────────────────────────────────────────────────────

  it("GATED register_agent: frozen vault rejects a NEW agent → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9600));
    // Two agents so the freeze below is a manual freeze (not auto-revoke), and
    // there is no zero-agent state confusing the precondition.
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    await freeze(vault);
    const code = await expectCode(
      register(vault, policy, overlay, Keypair.generate().publicKey),
    );
    expect(code, "register on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED unpause_agent: frozen vault rejects re-enabling an agent → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9601));
    const agent = Keypair.generate();
    await register(vault, policy, overlay, agent.publicKey);
    // Pause while Active (pausing is allowed; it's defensive).
    await program.methods
      .pauseAgent(agent.publicKey)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();
    await freeze(vault);
    const code = await expectCode(
      program.methods
        .unpauseAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault, policy } as any)
        .rpc(),
    );
    expect(code, "unpause on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED promote_graylist_destination: frozen vault rejects whitelisting → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9602));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    await freeze(vault);
    const code = await expectCode(
      program.methods
        .promoteGraylistDestination(Keypair.generate().publicKey)
        .accounts({ owner: owner.publicKey, vault, policy } as any)
        .rpc(),
    );
    expect(code, "promote on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED queue_policy_update: frozen vault rejects staging a policy update → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9603));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    await freeze(vault);
    const newDestination = Keypair.generate().publicKey;
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      {
        allowedDestinations: [newDestination],
      },
    );
    const code = await expectCode(
      program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          [newDestination], // allowedDestinations
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
          null, // protocol_hashes — Item 3 verified-build gate (PR-C, pass-through),
          PublicKey.default, // cosignSession (non-elevated)
          queueDigest,
        )
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingPolicy: pendingPolicyPda(vault),
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc(),
    );
    expect(code, "queue policy on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED queue_agent_permissions_update: frozen vault rejects staging → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9604));
    const agent = Keypair.generate();
    await register(vault, policy, overlay, agent.publicKey);
    await freeze(vault);
    const code = await expectCode(
      program.methods
        .queueAgentPermissionsUpdate(
          agent.publicKey,
          CAPABILITY_OPERATOR,
          new BN(75_000_000),
          new BN(0),
          PublicKey.default,
        )
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingAgentPerms: pendingAgentPermsPda(vault, agent.publicKey),
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc(),
    );
    expect(code, "queue perms on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED apply_pending_policy: queued-then-frozen update cannot apply → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9605));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    const pendingPolicy = pendingPolicyPda(vault);
    const newDestination = Keypair.generate().publicKey;
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      {
        allowedDestinations: [newDestination],
      },
    );
    // Queue on Active.
    await program.methods
      .queuePolicyUpdate(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [newDestination],
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
        null, // protocol_hashes — Item 3 verified-build gate (PR-C, pass-through),
        PublicKey.default,
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    // Freeze, then wait out the timelock and attempt to apply.
    await freeze(vault);
    advanceTime(svm, Number(STANDARD_INIT_TIMELOCK.toString()) + 1);
    const code = await expectCode(
      program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingPolicy,
        } as any)
        .rpc(),
    );
    expect(code, "apply policy on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED apply_agent_permissions_update: queued-then-frozen update cannot apply → 6000", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9606),
    );
    const agent = Keypair.generate();
    await register(vault, policy, overlay, agent.publicKey);
    const pendingAgentPerms = pendingAgentPermsPda(vault, agent.publicKey);
    // Queue on Active.
    await program.methods
      .queueAgentPermissionsUpdate(
        agent.publicKey,
        CAPABILITY_OPERATOR,
        new BN(75_000_000),
        new BN(0),
        PublicKey.default,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    await freeze(vault);
    advanceTime(svm, Number(STANDARD_INIT_TIMELOCK.toString()) + 1);
    // Committed-IDL workaround: audit_log_success + slot_hashes sysvar are passed
    // as trailing remaining accounts (see audit-log-coverage.ts).
    const code = await expectCode(
      program.methods
        .applyAgentPermissionsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingAgentPerms,
          agentSpendOverlay: overlay,
        } as any)
        .remainingAccounts([
          { pubkey: auditSuccess, isSigner: false, isWritable: true },
          {
            pubkey: SYSVAR_SLOT_HASHES_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ])
        .rpc(),
    );
    expect(code, "apply perms on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  it("GATED set_observe_only(false): frozen vault rejects re-arming execution → 6000", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9607));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    await freeze(vault);
    const code = await expectCode(
      program.methods
        .setObserveOnly(false)
        .accounts({ vault, policy, owner: owner.publicKey } as any)
        .rpc(),
    );
    expect(code, "setObserveOnly(false) on frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // EXCEPTION — must STILL SUCCEED on a frozen vault (defensive/subtractive).
  // ───────────────────────────────────────────────────────────────────────

  it("EXCEPTION set_observe_only(true): frozen vault may still go inert", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9610));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    await freeze(vault);
    await program.methods
      .setObserveOnly(true)
      .accounts({ vault, policy, owner: owner.publicKey } as any)
      .rpc();
    const v = await program.account.agentVault.fetch(vault);
    expect((v as any).observeOnly, "vault went inert while frozen").to.equal(
      true,
    );
  });

  it("EXCEPTION revoke_agent: frozen vault may still remove an agent", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9611));
    const a1 = Keypair.generate();
    const a2 = Keypair.generate();
    // Two agents so revoking one leaves the vault frozen-with-agents (not auto-
    // reactivated and not auto-frozen-again).
    await register(vault, policy, overlay, a1.publicKey);
    await register(vault, policy, overlay, a2.publicKey);
    await freeze(vault);
    await program.methods
      .revokeAgent(a2.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    const v = await program.account.agentVault.fetch(vault);
    const stillHasA2 = (v as any).agents.some(
      (e: any) => e.pubkey.toString() === a2.publicKey.toString(),
    );
    expect(stillHasA2, "revoked agent removed while frozen").to.equal(false);
  });

  it("EXCEPTION pause_agent: frozen vault may still pause an agent", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9612));
    const agent = Keypair.generate();
    await register(vault, policy, overlay, agent.publicKey);
    await freeze(vault);
    await program.methods
      .pauseAgent(agent.publicKey)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();
    const v = await program.account.agentVault.fetch(vault);
    const entry = (v as any).agents.find(
      (e: any) => e.pubkey.toString() === agent.publicKey.toString(),
    );
    expect(entry?.paused, "agent paused while frozen").to.equal(true);
  });

  it("EXCEPTION cancel_pending_policy: frozen vault may still unwind a staged update", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9613));
    await register(vault, policy, overlay, Keypair.generate().publicKey);
    const pendingPolicy = pendingPolicyPda(vault);
    const newDestination = Keypair.generate().publicKey;
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      {
        allowedDestinations: [newDestination],
      },
    );
    // Queue on Active, then freeze, then cancel while frozen.
    await program.methods
      .queuePolicyUpdate(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [newDestination],
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
        null, // protocol_hashes — Item 3 verified-build gate (PR-C, pass-through),
        PublicKey.default,
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    await freeze(vault);
    await program.methods
      .cancelPendingPolicy()
      .accounts({ owner: owner.publicKey, vault, policy, pendingPolicy } as any)
      .rpc();
    // Pending PDA closed (rent reclaimed) → account no longer exists.
    expect(
      svm.getAccount(pendingPolicy),
      "pending closed while frozen",
    ).to.equal(null);
  });

  it("EXCEPTION deposit_funds: frozen vault may still receive a deposit", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9614));
    await register(vault, policy, overlay, Keypair.generate().publicKey);

    const ownerAta = createAtaHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      ownerAta,
      owner.publicKey,
      1_000_000_000n,
    );
    const vaultAta = createAtaHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      vault,
      true,
    );

    await freeze(vault);
    // Deposit MUST succeed on a frozen vault (money in cannot harm the owner).
    await program.methods
      .depositFunds(new BN(10_000_000))
      .accounts({
        owner: owner.publicKey,
        vault,
        mint: DEVNET_USDC_MINT,
        ownerTokenAccount: ownerAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    // No throw == success; sanity-check the vault token account holds the deposit.
    const acct = svm.getAccount(vaultAta);
    expect(acct, "vault ATA exists after frozen deposit").to.not.equal(null);
  });

  // ───────────────────────────────────────────────────────────────────────
  // ANTI-BRICK — the security-critical invariant the whole gate sweep rests on.
  // revoke_agent auto-freezes at zero agents (revoke_agent.rs:94); register_agent
  // is now gated on a frozen vault. The ONLY path back to Active is the owner's
  // deliberate reactivate_vault (which grafts an agent in the same call). This
  // test proves that path exists, so the gates can never PERMANENTLY brick a
  // vault — recovery is always available to the owner. (Reviewer LOW rec.)
  // ───────────────────────────────────────────────────────────────────────
  it("ANTI-BRICK: revoke-last → auto-frozen → register rejected → reactivate restores Active", async () => {
    const { vault, policy, overlay } = await initVault(new BN(9620));
    const a1 = Keypair.generate();
    await register(vault, policy, overlay, a1.publicKey);

    // Revoke the LAST agent → vault auto-freezes (FreezeReason::AutoRevoke).
    await program.methods
      .revokeAgent(a1.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    const frozen = await program.account.agentVault.fetch(vault);
    expect((frozen as any).status.frozen, "auto-frozen at zero agents").to.not
      .be.undefined;

    // register_agent is now gated → cannot add an agent back directly.
    const blocked = await expectCode(
      register(vault, policy, overlay, Keypair.generate().publicKey),
    );
    expect(blocked, "register on auto-frozen → VaultNotActive").to.equal(
      VAULT_NOT_ACTIVE,
    );

    // The owner's deliberate recovery path: reactivate_vault grafts an agent
    // (VIEWER cap avoids the FULL cosign gate) AND flips status back to Active,
    // after the 300s C28 cooldown. This is the single, owner-only unblock.
    advanceTime(svm, REACTIVATE_COOLDOWN_SECONDS + 60);
    await program.methods
      .reactivateVault(Keypair.generate().publicKey, CAPABILITY_VIEWER)
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();
    const recovered = await program.account.agentVault.fetch(vault);
    expect((recovered as any).status.active, "vault recovered to Active").to.not
      .be.undefined;
  });
});
