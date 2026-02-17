import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../target/types/agent_shield";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

describe("devnet-smoke-test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentShield as Program<AgentShield>;
  const connection = provider.connection;

  const owner = provider.wallet as anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  // Use a unique vault ID based on timestamp to avoid collisions on devnet
  const vaultId = new BN(Date.now() % 1_000_000_000);

  let usdcMint: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let sessionPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    console.log("  Owner:", owner.publicKey.toString());
    console.log("  Agent:", agent.publicKey.toString());
    console.log("  Vault ID:", vaultId.toNumber());
    console.log("  Program:", program.programId.toString());

    // Fund agent keypair from owner wallet (devnet faucet is rate-limited)
    const transferIx = SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: agent.publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });
    const tx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(tx);

    // Create a test SPL token mint
    usdcMint = await createMint(
      connection,
      (owner as any).payer,
      owner.publicKey,
      null,
      6
    );
    console.log("  Test mint:", usdcMint.toString());

    // Create owner token account and mint tokens
    ownerUsdcAta = await createAssociatedTokenAccount(
      connection,
      (owner as any).payer,
      usdcMint,
      owner.publicKey
    );
    await mintTo(
      connection,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      1_000_000_000 // 1000 tokens
    );

    // Derive PDAs
    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId
    );
    [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), vaultPda.toBuffer(), agent.publicKey.toBuffer()],
      program.programId
    );

    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });
  });

  it("1. initialize_vault", async () => {
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily cap: 500
        new BN(100_000_000), // max tx: 100
        [usdcMint],
        [jupiterProgramId],
        new BN(0) as any,
        3,
        0 // developer_fee_rate: 0 bps
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
    expect(vault.vaultId.toNumber()).to.equal(vaultId.toNumber());
    console.log("    Vault PDA:", vaultPda.toString());
  });

  it("2. deposit_funds", async () => {
    await program.methods
      .depositFunds(new BN(100_000_000)) // 100 tokens
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAccount = await getAccount(connection, vaultUsdcAta);
    expect(Number(vaultAccount.amount)).to.equal(100_000_000);
    console.log("    Deposited 100 tokens into vault");
  });

  it("3. register_agent", async () => {
    await program.methods
      .registerAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.agent.toString()).to.equal(agent.publicKey.toString());
    console.log("    Agent registered:", agent.publicKey.toString());
  });

  it("4. update_policy", async () => {
    await program.methods
      .updatePolicy(
        null,  // keep daily cap
        null,  // keep max tx
        null,  // keep tokens
        null,  // keep protocols
        new BN(5000) as any, // set leverage to 50x
        null,  // keep can_open_positions
        null,  // keep max_concurrent_positions
        null   // keep developer_fee_rate
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
      } as any)
      .rpc();

    const policy = await program.account.policyConfig.fetch(policyPda);
    expect(policy.maxLeverageBps).to.equal(5000);
    console.log("    Policy updated: max_leverage_bps = 5000");
  });

  it("5. validate_and_authorize", async () => {
    await program.methods
      .validateAndAuthorize(
        { swap: {} },
        usdcMint,
        new BN(50_000_000), // 50 tokens
        jupiterProgramId,
        null
      )
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([agent])
      .rpc();

    const session = await program.account.sessionAuthority.fetch(sessionPda);
    expect(session.authorized).to.equal(true);
    expect(session.authorizedAmount.toNumber()).to.equal(50_000_000);
    console.log("    Session authorized for 50 tokens");
  });

  it("6. finalize_session", async () => {
    await program.methods
      .finalizeSession(true)
      .accounts({
        payer: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        sessionRentRecipient: agent.publicKey,
        vaultTokenAccount: null,
        feeDestinationTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([agent])
      .rpc();

    // Session should be closed
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.totalTransactions.toNumber()).to.equal(1);
    expect(vault.totalVolume.toNumber()).to.equal(50_000_000);
    console.log("    Session finalized, tx count = 1, volume = 50M");
  });

  it("7. withdraw_funds", async () => {
    await program.methods
      .withdrawFunds(new BN(50_000_000)) // withdraw 50 tokens
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultTokenAccount: vaultUsdcAta,
        ownerTokenAccount: ownerUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const vaultAccount = await getAccount(connection, vaultUsdcAta);
    expect(Number(vaultAccount.amount)).to.equal(50_000_000);
    console.log("    Withdrew 50 tokens, vault balance = 50M");
  });

  it("8. revoke_agent (kill switch)", async () => {
    await program.methods
      .revokeAgent()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("frozen");
    console.log("    Vault frozen via kill switch");
  });

  it("9. reactivate_vault", async () => {
    await program.methods
      .reactivateVault(null) // no agent rotation
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("active");
    console.log("    Vault reactivated");
  });

  it("10. withdraw remaining + close_vault", async () => {
    // Withdraw remaining 50 tokens
    await program.methods
      .withdrawFunds(new BN(50_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultTokenAccount: vaultUsdcAta,
        ownerTokenAccount: ownerUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    // Close vault and reclaim rent
    const balBefore = await connection.getBalance(owner.publicKey);

    await program.methods
      .closeVault()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify all PDAs are closed
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).to.be.null;
    const policyInfo = await connection.getAccountInfo(policyPda);
    expect(policyInfo).to.be.null;
    const trackerInfo = await connection.getAccountInfo(trackerPda);
    expect(trackerInfo).to.be.null;

    const balAfter = await connection.getBalance(owner.publicKey);
    expect(balAfter).to.be.greaterThan(balBefore);
    console.log("    Vault closed, rent reclaimed");
    console.log("    All 10 lifecycle steps passed on devnet!");
  });
});
