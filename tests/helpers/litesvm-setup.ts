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
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
);
const PROGRAM_SO_PATH = path.resolve(__dirname, "../../target/deploy/sigil.so");

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
export function recordCU(label: string, result: VersionedTxResult): void {
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

// ─── Error Code Map (shared with surfpool-setup.ts) ─────────────────────────

/**
 * Sigil custom error codes (6000-6074) mapped to Anchor error names.
 * Source of truth: programs/sigil/src/errors.rs
 *
 * Used by expectSigilError() for robust error matching that works
 * regardless of whether the error message contains the name or code.
 */
const SIGIL_ERROR_CODES: Record<string, number> = {
  VaultNotActive: 6000,
  UnauthorizedAgent: 6001,
  UnauthorizedOwner: 6002,
  UnsupportedToken: 6003,
  ProtocolNotAllowed: 6004,
  TransactionTooLarge: 6005,
  SpendingCapExceeded: 6006,
  LeverageTooHigh: 6007,
  TooManyPositions: 6008,
  PositionOpeningDisallowed: 6009,
  SessionNotAuthorized: 6010,
  InvalidSession: 6011,
  OpenPositionsExist: 6012,
  TooManyAllowedProtocols: 6013,
  AgentAlreadyRegistered: 6014,
  NoAgentRegistered: 6015,
  VaultNotFrozen: 6016,
  VaultAlreadyClosed: 6017,
  InsufficientBalance: 6018,
  DeveloperFeeTooHigh: 6019,
  InvalidFeeDestination: 6020,
  InvalidProtocolTreasury: 6021,
  InvalidAgentKey: 6022,
  AgentIsOwner: 6023,
  Overflow: 6024,
  InvalidTokenAccount: 6025,
  TimelockNotExpired: 6026,
  // TimelockActive removed — direct-mutation instructions deleted; all mutations use queue/apply.
  NoTimelockConfigured: 6027,
  DestinationNotAllowed: 6028,
  TooManyDestinations: 6029,
  InvalidProtocolMode: 6030,
  InvalidNonSpendingAmount: 6031,
  NoPositionsToClose: 6032,
  CpiCallNotAllowed: 6033,
  MissingFinalizeInstruction: 6034,
  NonTrackedSwapMustReturnStablecoin: 6035,
  SwapSlippageExceeded: 6036,
  InvalidJupiterInstruction: 6037,
  UnauthorizedTokenTransfer: 6038,
  SlippageBpsTooHigh: 6039,
  ProtocolMismatch: 6040,
  TooManyDeFiInstructions: 6041,
  MaxAgentsReached: 6042,
  InsufficientPermissions: 6043,
  InvalidPermissions: 6044,
  EscrowNotActive: 6045,
  EscrowExpired: 6046,
  EscrowNotExpired: 6047,
  InvalidEscrowVault: 6048,
  EscrowConditionsNotMet: 6049,
  EscrowDurationExceeded: 6050,
  InvalidConstraintConfig: 6051,
  ConstraintViolated: 6052,
  InvalidConstraintsPda: 6053,
  InvalidPendingConstraintsPda: 6054,
  AgentSpendLimitExceeded: 6055,
  OverlaySlotExhausted: 6056,
  AgentSlotNotFound: 6057,
  UnauthorizedTokenApproval: 6058,
  InvalidSessionExpiry: 6059,
  UnconstrainedProgramBlocked: 6060,
  ProtocolCapExceeded: 6061,
  ProtocolCapsMismatch: 6062,
  ActiveEscrowsExist: 6063,
  ConstraintsNotClosed: 6064,
  PendingPolicyExists: 6065,
  AgentPaused: 6066,
  AgentAlreadyPaused: 6067,
  AgentNotPaused: 6068,
  UnauthorizedPostFinalizeInstruction: 6069,
  UnexpectedBalanceDecrease: 6070,
  TimelockTooShort: 6071,
  PolicyVersionMismatch: 6072,
  PendingAgentPermsExists: 6073,
  PendingCloseConstraintsExists: 6074,
};

/**
 * Assert that an error matches a Sigil error by name OR code.
 * More robust than `.includes("ErrorName")` because it also checks the numeric code.
 *
 * @param errString - The error.toString() output
 * @param errorNames - One or more expected error names (matches if ANY appear)
 */
export function expectSigilError(
  errString: string,
  ...errorNames: string[]
): void {
  for (const name of errorNames) {
    if (errString.includes(name)) return; // Name match
    const code = SIGIL_ERROR_CODES[name];
    if (code !== undefined && errString.includes(String(code))) return; // Code match
  }
  const expected = errorNames
    .map((n) => `${n} (${SIGIL_ERROR_CODES[n] ?? "?"})`)
    .join(" | ");
  throw new Error(
    `Expected Sigil error [${expected}] but got: ${errString.slice(0, 200)}`,
  );
}

// Re-export types
export { LiteSVM, Clock, FailedTransactionMetadata, TransactionMetadata };
