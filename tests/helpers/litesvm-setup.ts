import * as path from "path";
import { LiteSVM, Clock } from "litesvm";
import { LiteSVMProvider } from "anchor-litesvm";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../../target/types/agent_shield";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  MINT_SIZE,
  AccountLayout,
} from "@solana/spl-token";

const IDL = require("../../target/idl/agent_shield.json");

// Resolve workspace root relative to this file (tests/helpers/ → project root)
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");

const PROGRAM_ID = new PublicKey(
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"
);

/**
 * Create and return a fully configured LiteSVM test environment.
 *
 * We create LiteSVM directly (instead of using anchor-litesvm's fromWorkspace)
 * to ensure all native objects (LiteSVM, Clock) come from the same NAPI addon
 * instance. pnpm can isolate anchor-litesvm's litesvm copy into a separate
 * native binary, and passing Clock objects across addon boundaries causes
 * std::bad_alloc on Linux.
 */
export function createTestEnv(): {
  svm: LiteSVM;
  provider: LiteSVMProvider;
  program: Program<AgentShield>;
} {
  const svm = new LiteSVM();
  const programSoPath = path.join(
    WORKSPACE_ROOT,
    "target/deploy/agent_shield.so"
  );
  svm.addProgramFromFile(PROGRAM_ID, programSoPath);
  // Disable transaction history to allow duplicate transaction patterns
  // (authorize+finalize cycles reuse same session PDA)
  svm.withTransactionHistory(BigInt(0));
  const provider = new LiteSVMProvider(svm);
  anchor.setProvider(provider);
  const program = new Program<AgentShield>(IDL, provider) as any;
  return { svm, provider, program };
}

/**
 * Airdrop SOL to a pubkey. Synchronous in LiteSVM — no confirmation needed.
 */
export function airdropSol(
  svm: LiteSVM,
  pubkey: PublicKey,
  sol: number
): void {
  const lamports = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  const result = svm.airdrop(pubkey, lamports);
  if (result && "err" in result) {
    throw new Error(`Airdrop failed: ${JSON.stringify((result as any).err())}`);
  }
}

/**
 * Create an SPL token mint using raw instructions (not @solana/spl-token
 * convenience functions which require a real Connection).
 */
export function createMintHelper(
  svm: LiteSVM,
  payer: Keypair,
  authority: PublicKey,
  decimals: number
): PublicKey {
  const mintKeypair = Keypair.generate();
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: Number(rentExempt),
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      authority,
      null
    )
  );

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mintKeypair);

  const result = svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(
      `createMintHelper failed: ${JSON.stringify(result.err())} ${result.meta().prettyLogs()}`
    );
  }

  return mintKeypair.publicKey;
}

/**
 * Create an Associated Token Account via instruction.
 */
export function createAtaHelper(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  offCurve: boolean = false
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, offCurve);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint
    )
  );

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const result = svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(
      `createAtaHelper failed: ${JSON.stringify(result.err())} ${result.meta().prettyLogs()}`
    );
  }

  return ata;
}

/**
 * Mint tokens to a destination ATA.
 */
export function mintToHelper(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  authority: Keypair,
  amount: number | bigint
): void {
  const tx = new Transaction();
  tx.add(
    createMintToInstruction(
      mint,
      dest,
      authority.publicKey,
      BigInt(amount)
    )
  );

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;

  // If payer and authority are the same, only sign once
  if (payer.publicKey.equals(authority.publicKey)) {
    tx.sign(payer);
  } else {
    tx.sign(payer, authority);
  }

  const result = svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(
      `mintToHelper failed: ${JSON.stringify(result.err())} ${result.meta().prettyLogs()}`
    );
  }
}

/**
 * Get the token balance (amount) of an ATA.
 */
export function getTokenBalance(svm: LiteSVM, ata: PublicKey): bigint {
  const account = svm.getAccount(ata);
  if (!account) {
    throw new Error(`Token account ${ata.toBase58()} not found`);
  }
  const decoded = AccountLayout.decode(Buffer.from(account.data));
  return decoded.amount;
}

/**
 * Check if an account exists (not null / not closed).
 */
export function accountExists(svm: LiteSVM, pubkey: PublicKey): boolean {
  const account = svm.getAccount(pubkey);
  return account !== null;
}

/**
 * Get SOL balance (in lamports) of an address.
 */
export function getBalance(svm: LiteSVM, pubkey: PublicKey): number {
  const bal = svm.getBalance(pubkey);
  return bal !== null ? Number(bal) : 0;
}

/**
 * Advance the SVM clock past a given slot. Instant — no polling.
 */
export function advancePastSlot(svm: LiteSVM, slot: number): void {
  const targetSlot = BigInt(slot + 1);
  const clock = svm.getClock();
  svm.setClock(
    new Clock(
      targetSlot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp
    )
  );
  svm.warpToSlot(targetSlot);
}
