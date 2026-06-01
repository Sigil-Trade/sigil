/**
 * LiteSVM test infrastructure — inlined provider (no anchor-litesvm dependency)
 *
 * Single import from "litesvm" guarantees one NAPI-RS binary, avoiding
 * the cross-addon std::bad_alloc crash that happened on CI with anchor-litesvm.
 */
import {
  AccountInfo,
  Commitment,
  ConfirmOptions,
  Connection,
  GetAccountInfoConfig,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  RpcResponseAndContext,
  SendOptions,
  Signer,
  Transaction,
  TransactionSignature,
  VersionedTransaction,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { Program, Provider, Wallet } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  Clock,
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import bs58 from "bs58";
import { SuccessfulTxSimulationResponse } from "@coral-xyz/anchor/dist/cjs/utils/rpc";
import * as path from "path";
import { Sigil } from "../../target/types/sigil";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ─── Program constants ──────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(
  "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK",
);
const PROGRAM_SO_PATH = path.resolve(__dirname, "../../target/deploy/sigil.so");

// Mock DeFi test program — a real Anchor program with stable 8-byte
// discriminators used as a generic constraint-matching target in
// InstructionConstraints tests.
const MOCK_DEFI_PROGRAM_ID = new PublicKey(
  "2pB26qKW73sToF7ETcdhXQTj8biYwAk9TCArVwgHBe24",
);
// Mock-defi's compiled .so is a committed fixture at tests/fixtures/.
// Root Cargo.toml explains why it is not a workspace member (CI tool
// compatibility — cargo-certora-sbf and feature-flag builds). Rebuild
// procedure in scripts/rebuild-mock-defi.sh.
const MOCK_DEFI_SO_PATH = path.resolve(__dirname, "../fixtures/mock-defi.so");

// ─── Connection proxy ────────────────────────────────────────────────────────
class LiteSVMConnectionProxy {
  constructor(private client: LiteSVM) {}

  async getAccountInfoAndContext(
    publicKey: PublicKey,
    _commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<RpcResponseAndContext<AccountInfo<Buffer>>> {
    const acct = this.client.getAccount(publicKey);
    if (!acct) throw new Error(`Could not find ${publicKey.toBase58()}`);
    return {
      context: { slot: Number(this.client.getClock().slot) },
      value: { ...acct, data: Buffer.from(acct.data) },
    };
  }

  async getAccountInfo(
    publicKey: PublicKey,
    _commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<AccountInfo<Buffer>> {
    const acct = this.client.getAccount(publicKey);
    if (!acct) throw new Error(`Could not find ${publicKey.toBase58()}`);
    return { ...acct, data: Buffer.from(acct.data) };
  }

  async getMinimumBalanceForRentExemption(
    dataLength: number,
    _commitment?: Commitment,
  ): Promise<number> {
    const rent = this.client.getRent();
    return Number(rent.minimumBalance(BigInt(dataLength)));
  }

  async getBalance(
    publicKey: PublicKey,
    _commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<number> {
    const bal = this.client.getBalance(publicKey);
    return bal != null ? Number(bal) : 0;
  }

  async getSlot(_commitment?: Commitment): Promise<number> {
    return Number(this.client.getClock().slot);
  }
}

// ─── sendWithErr helper ──────────────────────────────────────────────────────
function sendWithErr(
  tx: Transaction | VersionedTransaction,
  client: LiteSVM,
): void {
  const res = client.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    const sigRaw = tx instanceof Transaction ? tx.signature : tx.signatures[0];
    const signature = sigRaw ? bs58.encode(sigRaw) : "unknown";
    throw new SendTransactionError({
      action: "send",
      signature,
      transactionMessage: res.err().toString(),
      logs: res.meta().logs(),
    });
  }
}

// ─── LiteSVM Provider (inlined from anchor-litesvm) ──────────────────────────
export class LiteSVMProvider implements Provider {
  wallet: Wallet;
  connection: Connection;
  publicKey: PublicKey;

  constructor(
    public client: LiteSVM,
    wallet?: Wallet,
  ) {
    if (wallet == null) {
      const payer = new Keypair();
      client.airdrop(payer.publicKey, BigInt(LAMPORTS_PER_SOL));
      this.wallet = new Wallet(payer);
    } else {
      this.wallet = wallet;
    }
    this.connection = new LiteSVMConnectionProxy(
      client,
    ) as unknown as Connection;
    this.publicKey = this.wallet.publicKey;
  }

  async send?(
    tx: Transaction | VersionedTransaction,
    signers?: Signer[],
    _opts?: SendOptions,
  ): Promise<string> {
    if ("version" in tx) {
      signers?.forEach((s) => tx.sign([s]));
    } else {
      tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
      tx.recentBlockhash = this.client.latestBlockhash();
      signers?.forEach((s) => tx.partialSign(s));
    }
    this.wallet.signTransaction(tx);

    let signature: string;
    if ("version" in tx) {
      signature = bs58.encode(tx.signatures[0]);
    } else {
      if (!tx.signature) throw new Error("Missing fee payer signature");
      signature = bs58.encode(tx.signature);
    }
    this.client.sendTransaction(tx);
    return signature;
  }

  async sendAndConfirm?(
    tx: Transaction | VersionedTransaction,
    signers?: Signer[],
    _opts?: ConfirmOptions,
  ): Promise<string> {
    if ("version" in tx) {
      signers?.forEach((s) => tx.sign([s]));
    } else {
      tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
      tx.recentBlockhash = this.client.latestBlockhash();
      signers?.forEach((s) => tx.partialSign(s));
    }
    this.wallet.signTransaction(tx);

    let signature: string;
    if ("version" in tx) {
      signature = bs58.encode(tx.signatures[0]);
    } else {
      if (!tx.signature) throw new Error("Missing fee payer signature");
      signature = bs58.encode(tx.signature);
    }
    sendWithErr(tx, this.client);
    return signature;
  }

  async sendAll?<T extends Transaction | VersionedTransaction>(
    txWithSigners: { tx: T; signers?: Signer[] }[],
    _opts?: ConfirmOptions,
  ): Promise<string[]> {
    const recentBlockhash = this.client.latestBlockhash();
    const txs = txWithSigners.map((r) => {
      if ("version" in r.tx) {
        if (r.signers) (r.tx as VersionedTransaction).sign(r.signers);
        return r.tx;
      } else {
        const tx = r.tx as Transaction;
        tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
        tx.recentBlockhash = recentBlockhash;
        (r.signers ?? []).forEach((kp) => tx.partialSign(kp));
        return tx;
      }
    });

    const signedTxs = await this.wallet.signAllTransactions(txs);
    const sigs: TransactionSignature[] = [];
    for (const tx of signedTxs) {
      if ("version" in tx) {
        sigs.push(bs58.encode((tx as VersionedTransaction).signatures[0]));
      } else {
        sigs.push(bs58.encode((tx as Transaction).signature!));
      }
      sendWithErr(tx, this.client);
    }
    return sigs;
  }

  async simulate(
    tx: Transaction | VersionedTransaction,
    signers?: Signer[],
    _commitment?: Commitment,
    includeAccounts?: boolean | PublicKey[],
  ): Promise<SuccessfulTxSimulationResponse> {
    if (includeAccounts !== undefined) {
      throw new Error("includeAccounts cannot be used with LiteSVMProvider");
    }
    if ("version" in tx) {
      signers?.forEach((s) => tx.sign([s]));
    } else {
      tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
      tx.recentBlockhash = this.client.latestBlockhash();
      signers?.forEach((s) => tx.partialSign(s));
    }
    const rawResult = this.client.simulateTransaction(tx);
    if (rawResult instanceof FailedTransactionMetadata) {
      const sigRaw =
        tx instanceof Transaction ? tx.signature : tx.signatures[0];
      const signature = sigRaw ? bs58.encode(sigRaw) : "unknown";
      throw new SendTransactionError({
        action: "simulate",
        signature,
        transactionMessage: rawResult.err().toString(),
        logs: rawResult.meta().logs(),
      });
    }
    const returnDataRaw = rawResult.meta().returnData();
    const b64 = Buffer.from(returnDataRaw.data()).toString("base64");
    const data: [string, "base64"] = [b64, "base64"];
    const returnData = {
      programId: returnDataRaw.programId.toString(),
      data,
    };
    return {
      logs: rawResult.meta().logs(),
      unitsConsumed: Number(rawResult.meta().computeUnitsConsumed()),
      returnData,
    };
  }
}

// ─── Test environment ────────────────────────────────────────────────────────

export interface TestEnv {
  svm: LiteSVM;
  provider: LiteSVMProvider;
  program: Program<Sigil>;
  connection: Connection;
}

export function createTestEnv(): TestEnv {
  const svm = new LiteSVM()
    .withSysvars()
    .withBuiltins()
    .withDefaultPrograms()
    .withTransactionHistory(0n);

  // Set a positive unix_timestamp — the on-chain SpendTracker requires
  // clock.unix_timestamp > 0 (negative timestamp guard).
  // Default LiteSVM clock starts at 0 which would trip the guard.
  const c = svm.getClock();
  svm.setClock(
    new Clock(
      c.slot,
      c.epochStartTimestamp,
      c.epoch,
      c.leaderScheduleEpoch,
      BigInt(1_700_000_000), // ~Nov 2023
    ),
  );

  svm.addProgramFromFile(PROGRAM_ID, PROGRAM_SO_PATH);
  svm.addProgramFromFile(MOCK_DEFI_PROGRAM_ID, MOCK_DEFI_SO_PATH);

  const provider = new LiteSVMProvider(svm);
  anchor.setProvider(provider as unknown as Provider);

  const program = new Program<Sigil>(
    require("../../target/idl/sigil.json"),
    provider as unknown as Provider,
  );

  return {
    svm,
    provider,
    program,
    connection: provider.connection,
  };
}

// ─── Airdrop ─────────────────────────────────────────────────────────────────

export function airdropSol(
  svm: LiteSVM,
  to: PublicKey,
  lamports: number,
): void {
  svm.airdrop(to, BigInt(lamports));
}

// ─── Hardcoded stablecoin mints (must match on-chain devnet feature flag) ────

/** Devnet USDC: DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH (test-controlled keypair) */
export const DEVNET_USDC_MINT = new PublicKey(
  "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH",
);

/** Devnet USDT: 43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze (test-controlled keypair) */
export const DEVNET_USDT_MINT = new PublicKey(
  "43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze",
);

/**
 * Create an SPL Token mint at a specific address by writing account data directly.
 * Used for hardcoded stablecoin mints where we don't have the private key.
 */
export function createMintAtAddress(
  svm: LiteSVM,
  mintAddress: PublicKey,
  mintAuthority: PublicKey,
  decimals: number,
): void {
  const mintData = Buffer.alloc(MINT_SIZE);
  // MintLayout: mintAuthorityOption(4) + mintAuthority(32) + supply(8) +
  //   decimals(1) + isInitialized(1) + freezeAuthorityOption(4) + freezeAuthority(32)
  mintData.writeUInt32LE(1, 0); // COption::Some for mint authority
  mintAuthority.toBuffer().copy(mintData, 4);
  mintData.writeBigUInt64LE(0n, 36); // supply = 0
  mintData.writeUInt8(decimals, 44);
  mintData.writeUInt8(1, 45); // isInitialized = true
  mintData.writeUInt32LE(0, 46); // COption::None (no freeze authority)

  const rentExempt = Number(
    svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)),
  );
  svm.setAccount(mintAddress, {
    lamports: rentExempt,
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
}

// ─── SPL Token helpers (raw instructions, no @solana/spl-token convenience) ──

export function createMintHelper(
  svm: LiteSVM,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals: number,
): PublicKey {
  const mint = Keypair.generate();
  const rentExempt = Number(
    svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)),
  );

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports: rentExempt,
    programId: TOKEN_PROGRAM_ID,
  });

  // InitializeMint2 instruction (no freeze authority)
  const initMintData = Buffer.alloc(67);
  initMintData.writeUInt8(20, 0); // InitializeMint2 = 20
  initMintData.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(initMintData, 2);
  initMintData.writeUInt8(0, 34); // no freeze authority

  const initMintIx = new TransactionInstruction({
    keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data: initMintData,
  });

  const tx = new Transaction().add(createAccountIx, initMintIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer, mint);
  sendWithErr(tx, svm);

  return mint.publicKey;
}

export function createAtaHelper(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean = false,
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);

  // CreateAssociatedTokenAccount instruction
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  sendWithErr(tx, svm);

  return ata;
}

export function createAtaIdempotentHelper(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean = false,
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);

  // CreateAssociatedTokenAccountIdempotent instruction (discriminator = 1)
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  sendWithErr(tx, svm);

  return ata;
}

export function mintToHelper(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): void {
  // MintTo instruction (discriminator = 7)
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  sendWithErr(tx, svm);
}

// ─── Token balance reader ────────────────────────────────────────────────────

export function getTokenBalance(svm: LiteSVM, ata: PublicKey): bigint {
  const acct = svm.getAccount(ata);
  if (!acct) return 0n;
  const decoded = AccountLayout.decode(Buffer.from(acct.data));
  return decoded.amount;
}

// ─── Account helpers ─────────────────────────────────────────────────────────

export function accountExists(svm: LiteSVM, address: PublicKey): boolean {
  return svm.getAccount(address) != null;
}

export function getBalance(svm: LiteSVM, address: PublicKey): number {
  const bal = svm.getBalance(address);
  return bal != null ? Number(bal) : 0;
}

// ─── Clock / slot manipulation ───────────────────────────────────────────────

export function advancePastSlot(svm: LiteSVM, targetSlot: number): void {
  const c = svm.getClock();
  const newSlot = BigInt(targetSlot + 1);
  svm.setClock(
    new Clock(
      newSlot,
      c.epochStartTimestamp,
      c.epoch,
      c.leaderScheduleEpoch,
      c.unixTimestamp,
    ),
  );
  svm.warpToSlot(newSlot);
}

/**
 * Advance the SVM clock's unix_timestamp by a given number of seconds.
 * Useful for testing timelock expiry without waiting for real time.
 */
export function advanceTime(svm: LiteSVM, seconds: number): void {
  const c = svm.getClock();
  svm.setClock(
    new Clock(
      c.slot,
      c.epochStartTimestamp,
      c.epoch,
      c.leaderScheduleEpoch,
      c.unixTimestamp + BigInt(seconds),
    ),
  );
}

// ─── Composed TX helper for LiteSVM ─────────────────────────────────────────

export interface VersionedTxResult {
  signature: string;
  computeUnitsConsumed: number;
  logs: string[];
}

/**
 * Narrower contract for tools that only need the CU number.
 * `VersionedTxResult` satisfies this structurally, as do bench helpers
 * (e.g., `cu-budget.ts`'s `sendAndMeasureCU`) that return shapes without
 * a signature field.
 */
export interface CUMeasurement {
  computeUnitsConsumed: number;
}

export function sendVersionedTx(
  svm: LiteSVM,
  instructions: TransactionInstruction[],
  payer: Keypair,
  signers: Keypair[] = [],
): VersionedTxResult {
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer, ...signers]);

  const res = svm.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    const logs = res.meta().logs();
    throw new Error(
      `SimulationFailed: ${res.err().toString()} Logs: ${logs.join(" ")}`,
    );
  }

  return {
    signature: bs58.encode(tx.signatures[0]),
    computeUnitsConsumed: Number(res.computeUnitsConsumed()),
    logs: res.logs(),
  };
}

// ─── CU Measurement Utilities ───────────────────────────────────────────────

const cuMeasurements: Map<string, number[]> = new Map();

/**
 * Record CU consumption for a named operation (call after sendVersionedTx).
 * Accumulates measurements across multiple calls for the same label.
 */
export function recordCU(label: string, result: CUMeasurement): void {
  const existing = cuMeasurements.get(label) ?? [];
  existing.push(result.computeUnitsConsumed);
  cuMeasurements.set(label, existing);
}

/**
 * Print a summary table of all recorded CU measurements.
 * Call at the end of a test suite (e.g., in an `after()` hook).
 */
export function printCUSummary(): void {
  if (cuMeasurements.size === 0) return;

  console.log(
    "\n┌─────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│                    CU Consumption Report                    │",
  );
  console.log(
    "├──────────────────────────────────┬────────┬────────┬────────┤",
  );
  console.log(
    "│ Operation                        │    Min │    Max │    Avg │",
  );
  console.log(
    "├──────────────────────────────────┼────────┼────────┼────────┤",
  );

  for (const [label, values] of cuMeasurements.entries()) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    const padLabel = label.padEnd(32).slice(0, 32);
    const padMin = String(min).padStart(6);
    const padMax = String(max).padStart(6);
    const padAvg = String(avg).padStart(6);
    console.log(`│ ${padLabel} │ ${padMin} │ ${padMax} │ ${padAvg} │`);
  }

  console.log(
    "└──────────────────────────────────┴────────┴────────┴────────┘\n",
  );
}

/** Clear all recorded CU measurements. */
export function resetCUMeasurements(): void {
  cuMeasurements.clear();
}

// The legacy substring-matching `expectSigilErrorLegacy` helper AND its
// shadow `SIGIL_ERROR_CODES` map (both 7-0 council casualties) were
// deleted by the 2026-04-20 codemod. All consumers migrated to
// strict typed helpers at `@usesigil/kit/testing`:
//   import { expectSigilError, expectAnchorError, expectOneOfSigilErrors,
//            expectOneOfAnchorErrors, expectSystemError } from "@usesigil/kit/testing";
// The canonical name→code map now lives ONLY in
// `sdk/kit/src/testing/errors/names.generated.ts` (IDL-generated) and
// the public `SIGIL_ERRORS` export from `@usesigil/kit/testing`.
// See: MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md

// ─── Multi-instruction PDA creation helpers ─────────────────────────────────
// InstructionConstraints (35,888 bytes) and PendingConstraintsUpdate (35,912
// bytes post-F-10 audit fix; was 35,904 before adding queued_at_slot) exceed
// the 10,240-byte CPI limit. These helpers compose allocate + extend +
// populate into a single atomic VersionedTransaction.

import { createHash } from "crypto";

const CONSTRAINTS_SIZE = 35_888;
const PENDING_CONSTRAINTS_SIZE = 35_944;
const MAX_CPI_SIZE = 10_240;

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const ALLOC_CONSTRAINTS_DISC = anchorDisc("allocate_constraints_pda");
const ALLOC_PENDING_DISC = anchorDisc("allocate_pending_constraints_pda");
const EXTEND_PDA_DISC = anchorDisc("extend_pda");

function buildExtendPdaIx(
  programId: PublicKey,
  owner: PublicKey,
  vault: PublicKey,
  pda: PublicKey,
  targetSize: number,
): TransactionInstruction {
  const data = Buffer.alloc(12);
  EXTEND_PDA_DISC.copy(data, 0);
  data.writeUInt32LE(targetSize, 8);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function extendSteps(fullSize: number): number[] {
  const steps: number[] = [];
  let current = MAX_CPI_SIZE;
  while (current < fullSize) {
    current = Math.min(current + MAX_CPI_SIZE, fullSize);
    steps.push(current);
  }
  return steps;
}

/**
 * Synchronous LiteSVM-local sibling-handler digest helper. Mirrors
 * `tests/helpers/policy-digest.ts::siblingHandlerDigest` but reads the live
 * PolicyConfig + AgentVault directly off LiteSVM so it can run from a
 * synchronous helper.
 *
 * PEN-CROSS-3 (Phase 2 close-up): caller passes `hasConstraints` /
 * `hasPostAssertions` to override the flag the about-to-run handler will
 * flip; rest of digest sourced from live state.
 */
export function autoSiblingHandlerDigest(
  svm: LiteSVM,
  program: Program<Sigil>,
  policyPda: PublicKey,
  vaultPda: PublicKey,
  override: { hasConstraints?: boolean; hasPostAssertions?: number },
): number[] {
  const policyAccount = svm.getAccount(policyPda);
  const vaultAccount = svm.getAccount(vaultPda);
  if (!policyAccount || !vaultAccount) {
    throw new Error(
      `autoSiblingHandlerDigest: account not found at ${policyPda.toBase58()} / ${vaultPda.toBase58()}`,
    );
  }
  const policy = program.coder.accounts.decode(
    "policyConfig",
    Buffer.from(policyAccount.data),
  );
  const vault = program.coder.accounts.decode(
    "agentVault",
    Buffer.from(vaultAccount.data),
  );
  // Inline encode (avoid circular dep on policy-digest.ts).
  const crypto = require("crypto") as typeof import("crypto");
  const BN = require("bn.js") as typeof import("bn.js");
  const u64le = (v: any): Buffer => {
    const buf = Buffer.alloc(8);
    const bn = typeof v === "number" ? new BN(v) : v;
    buf.writeBigUInt64LE(BigInt(bn.toString()));
    return buf;
  };
  const u32le = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u16le = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u8 = (v: number) => Buffer.from([v & 0xff]);
  const parts: Buffer[] = [];
  parts.push(u64le(policy.dailySpendingCapUsd));
  parts.push(u64le(policy.maxTransactionSizeUsd));
  parts.push(u16le(policy.maxSlippageBps));
  parts.push(u16le(policy.developerFeeRate ?? 0));
  parts.push(u8(policy.protocolMode));
  parts.push(u32le(policy.protocols.length));
  for (const p of policy.protocols) parts.push(p.toBuffer());
  parts.push(u8(policy.destinationMode));
  parts.push(u32le(policy.allowedDestinations.length));
  for (const p of policy.allowedDestinations) parts.push(p.toBuffer());
  parts.push(u64le(policy.timelockDuration));
  parts.push(u64le(policy.sessionExpirySeconds));
  parts.push(u8(vault.observeOnly ? 1 : 0));
  const hasConstraints =
    override.hasConstraints !== undefined
      ? override.hasConstraints
      : !!policy.hasConstraints;
  parts.push(u8(hasConstraints ? 1 : 0));
  const hasPostAssertions =
    override.hasPostAssertions !== undefined
      ? override.hasPostAssertions
      : (policy.hasPostAssertions as number);
  parts.push(u8(hasPostAssertions));
  parts.push(u64le(policy.createdAtSlot ?? 0));
  // Phase 3 (TA-05/TA-07/TA-17): operating_hours, auto_promote_grays,
  // auto_revoke_threshold are now bound at positions 15-17 of the canonical
  // policy_preview_digest encoding. Must mirror
  // `programs/sigil/src/utils/policy_digest.rs` byte-for-byte.
  parts.push(u32le(policy.operatingHours ?? 0));
  parts.push(u8(policy.autoPromoteGrays ? 1 : 0));
  parts.push(u8(policy.autoRevokeThreshold ?? 0));
  // Phase 5 (TA-12): stable_balance_floor at position 18.
  parts.push(u64le(policy.stableBalanceFloor ?? 0));
  // Phase 5 (TA-14): per_recipient_daily_cap_usd at position 19.
  parts.push(u64le(policy.perRecipientDailyCapUsd ?? 0));
  // G6 (audit 2026-05-18 cosign opt-in): cosign_required at position 20.
  // Sibling handlers (constraints / post-assertions flips) never mutate
  // cosign_required — pass through from live policy.
  parts.push(u8(policy.cosignRequired ? 1 : 0));
  // Phase 8 PEN-CROSS-1 (audit 2026-05-19): agent_set_hash at position 21.
  // Sibling handlers (constraints / post-assertions flips) never mutate
  // the agent set — compute the hash from `vault.agents` directly so the
  // digest matches what the on-chain handler will recompute and persist.
  //
  // Phase 8 §RP Fix-Up B PRE-EXISTING BUG (audit 2026-05-19): this
  // synchronous helper was missing position 21 — only the async
  // `siblingHandlerDigest` in `tests/helpers/policy-digest.ts` had it.
  // That divergence produced a 78-byte vs 110-byte encoded buffer, with
  // the missing 32 bytes of agent_set_hash invalidating every test that
  // used `autoSiblingHandlerDigest`. Now byte-equal across all 3
  // canonical helpers (Rust `policy_digest.rs`, SDK
  // `compute-policy-preview-digest.ts`, test helper
  // `policy-digest.ts::siblingHandlerDigest`, AND this synchronous
  // helper).
  const agentList: ReadonlyArray<{ pubkey: PublicKey; capability: number }> =
    (vault.agents as ReadonlyArray<{
      pubkey: PublicKey;
      capability: number;
    }>) ?? [];
  const sorted = [...agentList].sort((a, b) => {
    const ab = a.pubkey.toBuffer();
    const bb = b.pubkey.toBuffer();
    for (let i = 0; i < 32; i++) {
      if (ab[i] < bb[i]) return -1;
      if (ab[i] > bb[i]) return 1;
    }
    return 0;
  });
  const agentLenBuf = Buffer.alloc(4);
  agentLenBuf.writeUInt32LE(sorted.length);
  const agentParts: Buffer[] = [agentLenBuf];
  for (const e of sorted) {
    agentParts.push(e.pubkey.toBuffer());
    agentParts.push(Buffer.from([e.capability & 0xff]));
  }
  const agentSetHash = crypto
    .createHash("sha256")
    .update(Buffer.concat(agentParts))
    .digest();
  parts.push(agentSetHash);
  // D-5 close (Bucket 2 audit 2026-05-21, F-RP3-1): cosign_session_pubkey
  // at canonical position 22. Sibling handlers (constraints /
  // post-assertions flips) never mutate this — pass through from live
  // policy. Pre-Bucket-2 helper output was 32 bytes short here too;
  // closes the helper-vs-async-helper divergence (see Phase 8 §RP
  // Fix-Up B note above on the position 21 fix).
  const cosignSessionPubkey =
    (policy as { cosignSessionPubkey?: PublicKey }).cosignSessionPubkey ??
    PublicKey.default;
  parts.push(cosignSessionPubkey.toBuffer());
  const buf = Buffer.concat(parts);
  return Array.from(crypto.createHash("sha256").update(buf).digest());
}

// ─── Zero-copy → test-friendly fetch adapter ────────────────────────────────
// Converts the raw ZC account data into the same shape tests were written for.

const OPERATOR_NAMES = [
  "eq",
  "ne",
  "gte",
  "lte",
  "gteSigned",
  "lteSigned",
  "bitmask",
];

// Re-export types
export { LiteSVM, Clock, FailedTransactionMetadata, TransactionMetadata };
