/**
 * Devnet Test Helpers — shared constants, PDA derivation, vault factory, and utilities.
 *
 * Used by all devnet-*.ts test files.
 *
 * Stablecoin-only architecture. SpendTracker is zero-copy with epoch buckets.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

// ─── Test-controlled stablecoin mint keypairs ────────────────────────────────
// These pubkeys MUST match the Rust USDC_MINT and USDT_MINT devnet constants
// in programs/sigil/src/state/mod.rs (and DEVNET_USDC_MINT/DEVNET_USDT_MINT
// in tests/helpers/litesvm-setup.ts).
// Private keys committed here are devnet-only — no security concern.

export const TEST_USDC_KEYPAIR = Keypair.fromSecretKey(
  Uint8Array.from([
    57, 116, 31, 62, 124, 154, 174, 111, 125, 197, 28, 25, 241, 46, 251, 101,
    210, 11, 144, 136, 92, 122, 67, 161, 65, 158, 188, 225, 35, 67, 41, 38, 183,
    123, 243, 77, 18, 80, 250, 164, 199, 89, 146, 151, 150, 233, 12, 20, 206,
    135, 29, 138, 218, 153, 91, 77, 84, 71, 174, 53, 139, 167, 156, 54,
  ]),
);
export const TEST_USDT_KEYPAIR = Keypair.fromSecretKey(
  Uint8Array.from([
    111, 156, 75, 11, 105, 82, 205, 23, 4, 64, 179, 121, 143, 109, 157, 132,
    163, 140, 12, 12, 111, 231, 86, 83, 175, 222, 157, 57, 187, 33, 86, 122, 45,
    62, 128, 117, 22, 254, 177, 202, 78, 70, 249, 101, 252, 36, 244, 42, 82, 77,
    95, 72, 170, 154, 33, 171, 68, 12, 82, 27, 106, 105, 202, 15,
  ]),
);
export const TEST_USDC_MINT = TEST_USDC_KEYPAIR.publicKey;
export const TEST_USDT_MINT = TEST_USDT_KEYPAIR.publicKey;

/**
 * Ensure a stablecoin mint exists at the deterministic address.
 * Idempotent — skips creation if mint already exists from a previous run.
 */
export async function ensureStablecoinMint(
  connection: Connection,
  payer: Keypair,
  mintKeypair: Keypair,
  mintAuthority: PublicKey,
  decimals: number = 6,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mintKeypair.publicKey);
  if (!info) {
    await createMint(
      connection,
      payer,
      mintAuthority,
      null,
      decimals,
      mintKeypair,
    );
  }
  return mintKeypair.publicKey;
}

/**
 * Create a non-stablecoin test token (random address, won't pass is_stablecoin_mint).
 */
export async function createNonStablecoinMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals: number = 6,
): Promise<PublicKey> {
  return createMint(connection, payer, mintAuthority, null, decimals);
}

// ─── RPC Rate Limiter (prevents 429s from Helius devnet 10 RPS limit) ───────

const RPC_MAX_RPS = 5; // Conservative: 5 RPS against 10 RPS limit
const RPC_MIN_GAP_MS = Math.ceil(1000 / RPC_MAX_RPS); // 200ms between requests

/**
 * Creates a throttled fetch function that enforces minimum spacing between
 * requests. Scoped to the Connection instance — does NOT patch globalThis.fetch.
 * JavaScript's single-threaded model makes the slot reservation atomic.
 */
function createThrottledFetch(): typeof fetch {
  let nextSlot = 0;
  const original = globalThis.fetch.bind(globalThis);

  return async function throttledFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const now = Date.now();
    const mySlot = Math.max(now, nextSlot);
    nextSlot = mySlot + RPC_MIN_GAP_MS;

    const wait = mySlot - now;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    return original(...args);
  } as typeof fetch;
}

// ─── Constants (mirrors programs/sigil/src/state/mod.rs) ─────────────

export const PROTOCOL_TREASURY = new PublicKey(
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
);
export const PROTOCOL_FEE_RATE = 200;
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const MAX_DEVELOPER_FEE_RATE = 500;
export const SESSION_EXPIRY_SLOTS = 20;
export const ROLLING_WINDOW_SECONDS = 86_400;

// ─── Collision-free vault ID generator ──────────────────────────────────────

let vaultIdCounter = 0;

/**
 * Returns a unique vault ID using `filePrefix * 1M + Date.now() % 1M + counter`.
 * Each test file should use a different filePrefix (1=smoke, 2=fees, 3=security, etc.)
 */
export function nextVaultId(filePrefix: number): BN {
  return new BN(
    filePrefix * 1_000_000 + (Date.now() % 1_000_000) + vaultIdCounter++,
  );
}

// ─── PDA derivation ─────────────────────────────────────────────────────────

export function derivePDAs(
  owner: PublicKey,
  vaultId: BN,
  programId: PublicKey,
) {
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vaultPda.toBuffer()],
    programId,
  );
  const [trackerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tracker"), vaultPda.toBuffer()],
    programId,
  );
  const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_policy"), vaultPda.toBuffer()],
    programId,
  );
  return { vaultPda, policyPda, trackerPda, pendingPolicyPda };
}

export function deriveSessionPda(
  vaultPda: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("session"),
      vaultPda.toBuffer(),
      agent.toBuffer(),
      tokenMint.toBuffer(),
    ],
    programId,
  );
  return sessionPda;
}

// ─── Provider setup ─────────────────────────────────────────────────────────

export function getDevnetProvider() {
  // Build a Connection with scoped throttled fetch (no globalThis monkey-patch).
  // The `fetch` option in ConnectionConfig passes our limiter directly to web3.js.
  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: createThrottledFetch(),
  });

  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Sigil as Program<Sigil>;
  const owner = provider.wallet as anchor.Wallet;
  return { provider, program, connection, owner };
}

// ─── Full vault factory ─────────────────────────────────────────────────────

export interface CreateFullVaultOpts {
  program: Program<Sigil>;
  connection: Connection;
  owner: anchor.Wallet;
  agent: Keypair;
  feeDestination: PublicKey;
  mint: PublicKey;
  vaultId: BN;
  dailyCap?: BN;
  maxTx?: BN;
  protocolMode?: number;
  allowedProtocols?: PublicKey[];
  maxLevBps?: number;
  maxPositions?: number;
  canOpenPositions?: boolean;
  devFeeRate?: number;
  maxSlippageBps?: number;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  depositAmount?: BN;
  skipDeposit?: boolean;
  skipAgent?: boolean;
}

export interface FullVaultResult {
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  pendingPolicyPda: PublicKey;
  overlayPda: PublicKey;
  vaultTokenAta: PublicKey;
  ownerTokenAta: PublicKey;
  protocolTreasuryAta: PublicKey;
  feeDestinationAta: PublicKey | null;
}

export async function createFullVault(
  opts: CreateFullVaultOpts,
): Promise<FullVaultResult> {
  const {
    program,
    connection,
    owner,
    agent,
    feeDestination,
    mint,
    vaultId,
    dailyCap = new BN(500_000_000),
    maxTx = new BN(100_000_000),
    protocolMode = 1, // allowlist
    allowedProtocols = [Keypair.generate().publicKey],
    maxLevBps = 0,
    maxPositions = 3,
    devFeeRate = 0,
    maxSlippageBps = 500,
    timelockDuration = new BN(1800), // mandatory minimum: 30 min
    allowedDestinations = [],
    depositAmount = new BN(1_000_000_000),
    skipDeposit = false,
    skipAgent = false,
  } = opts;

  const payer = (owner as any).payer;
  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);

  // Derive vault token ATA
  const vaultTokenAta = anchor.utils.token.associatedAddress({
    mint,
    owner: pdas.vaultPda,
  });

  // Create owner ATA + mint tokens (idempotent — safe across multiple vaults)
  const ownerAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner.publicKey,
  );
  const ownerTokenAta = ownerAtaAccount.address;
  if (!skipDeposit) {
    await mintTo(
      connection,
      payer,
      mint,
      ownerTokenAta,
      owner.publicKey,
      depositAmount.toNumber(),
    );
  }

  // Protocol treasury ATA (idempotent)
  const treasuryAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    PROTOCOL_TREASURY,
    true,
  );
  const protocolTreasuryAta = treasuryAtaAccount.address;

  // Fee destination ATA (if devFeeRate > 0)
  let feeDestinationAta: PublicKey | null = null;
  if (devFeeRate > 0) {
    const feeAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      feeDestination,
    );
    feeDestinationAta = feeAtaAccount.address;
  }

  // Initialize vault (11 args — includes maxSlippageBps)
  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), pdas.vaultPda.toBuffer(), Buffer.from([0])],
    program.programId,
  );
  await program.methods
    .initializeVault(
      vaultId,
      dailyCap,
      maxTx,
      protocolMode,
      allowedProtocols,
      new BN(maxLevBps) as any,
      maxPositions,
      devFeeRate,
      maxSlippageBps,
      timelockDuration,
      allowedDestinations,
      [], // protocolCaps
    )
    .accounts({
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      policy: pdas.policyPda,
      tracker: pdas.trackerPda,
      agentSpendOverlay: overlayPda,
      feeDestination,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  // Register agent (multi-agent: agent pubkey + permissions bitmask + spending limit)
  if (!skipAgent) {
    await program.methods
      .registerAgent(agent.publicKey, new BN(2097151), new BN(0)) // FULL_PERMISSIONS
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        agentSpendOverlay: overlayPda,
      } as any)
      .rpc();
  }

  // Deposit tokens
  if (!skipDeposit) {
    await program.methods
      .depositFunds(depositAmount)
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        mint,
        ownerTokenAccount: ownerTokenAta,
        vaultTokenAccount: vaultTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  return {
    ...pdas,
    overlayPda,
    vaultTokenAta,
    ownerTokenAta,
    protocolTreasuryAta,
    feeDestinationAta,
  };
}

// ─── Authorize + Finalize helper (composed into single versioned TX) ────────

export interface AuthorizeOpts {
  program: Program<Sigil>;
  connection: Connection;
  agent: Keypair;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  sessionPda: PublicKey;
  vaultTokenAta: PublicKey;
  mint: PublicKey;
  amount: BN;
  protocol: PublicKey;
  actionType?: any;
  leverageBps?: number | null;
  protocolTreasuryAta?: PublicKey | null;
  feeDestinationAta?: PublicKey | null;
  outputStablecoinAccount?: PublicKey | null;
  mockSpendDestination?: PublicKey | null;
  mockSpendDevFeeRate?: number;
  expectedPolicyVersion?: BN;
  remainingAccounts?: {
    pubkey: PublicKey;
    isWritable: boolean;
    isSigner: boolean;
  }[];
}

/**
 * Build a validate_and_authorize instruction (not sent — use authorizeAndFinalize
 * to compose with finalize into a single atomic transaction).
 */
export async function buildAuthorizeIx(opts: AuthorizeOpts) {
  const {
    program,
    agent,
    vaultPda,
    policyPda,
    trackerPda,
    sessionPda,
    vaultTokenAta,
    mint,
    amount,
    protocol,
    actionType = { swap: {} },
    leverageBps = null,
    protocolTreasuryAta = null,
    feeDestinationAta = null,
    outputStablecoinAccount = null,
    remainingAccounts = [],
  } = opts;

  // Read current policy version from on-chain if not provided.
  // Ensures tests that queue+apply policy changes use the correct version.
  let policyVersion = opts.expectedPolicyVersion;
  if (policyVersion === undefined) {
    try {
      const pol = await program.account.policyConfig.fetch(policyPda);
      policyVersion = (pol as any).policyVersion ?? new BN(0);
    } catch {
      policyVersion = new BN(0); // Fallback for tests where policy may not exist yet
    }
  }

  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
    program.programId,
  );
  return program.methods
    .validateAndAuthorize(
      actionType,
      mint,
      amount,
      protocol,
      leverageBps !== null ? (new BN(leverageBps) as any) : null,
      policyVersion,
    )
    .accounts({
      agent: agent.publicKey,
      vault: vaultPda,
      policy: policyPda,
      tracker: trackerPda,
      session: sessionPda,
      agentSpendOverlay: overlayPda,
      vaultTokenAccount: vaultTokenAta,
      tokenMintAccount: mint,
      protocolTreasuryTokenAccount: protocolTreasuryAta,
      feeDestinationTokenAccount: feeDestinationAta,
      outputStablecoinAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .remainingAccounts(remainingAccounts)
    .instruction();
}

export interface FinalizeOpts {
  program: Program<Sigil>;
  payer: Keypair;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  sessionPda: PublicKey;
  agentPubkey: PublicKey;
  vaultTokenAta: PublicKey | null;
  feeDestinationAta: PublicKey | null;
  protocolTreasuryAta: PublicKey | null;
  outputStablecoinAccount?: PublicKey | null;
}

/**
 * Build a finalize_session instruction (not sent — compose with authorize).
 */
export async function buildFinalizeIx(opts: FinalizeOpts) {
  const {
    program,
    payer,
    vaultPda,
    policyPda,
    trackerPda,
    sessionPda,
    agentPubkey,
    vaultTokenAta,
    feeDestinationAta,
    protocolTreasuryAta,
    outputStablecoinAccount = null,
  } = opts;
  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
    program.programId,
  );
  return program.methods
    .finalizeSession()
    .accountsPartial({
      payer: payer.publicKey,
      vault: vaultPda,
      session: sessionPda,
      sessionRentRecipient: agentPubkey,
      policy: policyPda,
      tracker: trackerPda,
      agentSpendOverlay: overlayPda,
      vaultTokenAccount: vaultTokenAta,
      outputStablecoinAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
}

/**
 * Compose validate + finalize into a single versioned transaction.
 * Returns the transaction signature.
 */
export async function authorizeAndFinalize(
  opts: AuthorizeOpts & {
    feeDestinationAta: PublicKey | null;
    protocolTreasuryAta: PublicKey | null;
  },
): Promise<string> {
  const validateIx = await buildAuthorizeIx(opts);
  const finalizeIx = await buildFinalizeIx({
    program: opts.program,
    payer: opts.agent,
    vaultPda: opts.vaultPda,
    policyPda: opts.policyPda,
    trackerPda: opts.trackerPda,
    sessionPda: opts.sessionPda,
    agentPubkey: opts.agent.publicKey,
    vaultTokenAta: opts.vaultTokenAta,
    feeDestinationAta: opts.feeDestinationAta,
    protocolTreasuryAta: opts.protocolTreasuryAta,
    outputStablecoinAccount: opts.outputStablecoinAccount ?? null,
  });

  // Build instruction list: validate → [mock DeFi spend] → finalize
  const instructions = [validateIx];

  // When mockSpendDestination is provided and amount > 0, insert a mock SPL
  // token transfer between validate and finalize. This simulates what a real
  // DeFi instruction would do (move tokens from the vault using the agent's
  // delegate authority set by validate_and_authorize). Without this, finalize
  // measures actual_spend_tracked = 0 and spending caps / position counters
  // are never updated.
  if (opts.mockSpendDestination && opts.amount.toNumber() > 0) {
    const { netAmount } = calculateFees(
      opts.amount.toNumber(),
      opts.mockSpendDevFeeRate ?? 0,
    );
    instructions.push(
      createTransferInstruction(
        opts.vaultTokenAta,
        opts.mockSpendDestination,
        opts.agent.publicKey, // delegate authority (set by validate_and_authorize)
        netAmount,
      ),
    );
  }

  instructions.push(finalizeIx);

  const { blockhash } = await opts.connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: opts.agent.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([opts.agent]);
  const sig = await opts.connection.sendTransaction(tx);
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/**
 * Backward-compat: authorize() now composes validate + finalize into one tx.
 * For error-path tests, Anchor constraint errors fire before handler logic,
 * so the expected error codes remain the same.
 */
export async function authorize(opts: AuthorizeOpts): Promise<string> {
  return authorizeAndFinalize({
    ...opts,
    feeDestinationAta: opts.feeDestinationAta ?? null,
    protocolTreasuryAta: opts.protocolTreasuryAta ?? null,
  });
}

export async function finalize(opts: FinalizeOpts): Promise<string> {
  // Standalone finalize is no longer supported — validate + finalize must
  // be in the same transaction. Keep for interface compat but throw.
  throw new Error(
    "Standalone finalize() is no longer supported. Use authorizeAndFinalize().",
  );
}

// ─── Utility helpers ────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSlot(
  connection: Connection,
  targetSlot: number,
  timeoutMs: number = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const currentSlot = await connection.getSlot();
    if (currentSlot >= targetSlot) return;
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for slot ${targetSlot} after ${timeoutMs}ms`,
  );
}

export function calculateFees(amount: number, devFeeRate: number) {
  const protocolFee = Math.ceil(
    (amount * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR,
  );
  const developerFee = Math.ceil((amount * devFeeRate) / FEE_RATE_DENOMINATOR);
  const netAmount = amount - protocolFee - developerFee;
  return { protocolFee, developerFee, netAmount };
}

/**
 * Asserts that an error message contains at least one of the given keywords.
 */
export function expectError(err: any, ...keywords: string[]) {
  const s = err.toString();
  const found = keywords.some((k) => s.includes(k));
  if (!found) {
    throw new Error(
      `Expected error to contain one of [${keywords.join(", ")}], got: ${s}`,
    );
  }
}

/**
 * Fund a keypair from owner wallet (avoids rate-limited devnet faucet).
 */
export async function fundKeypair(
  provider: anchor.AnchorProvider,
  recipient: PublicKey,
  lamports: number = 0.1 * LAMPORTS_PER_SOL,
): Promise<void> {
  const ix = SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: recipient,
    lamports,
  });
  const tx = new anchor.web3.Transaction().add(ix);
  await provider.sendAndConfirm(tx);
}

/**
 * Create a test SPL token mint with `decimals` precision, owned by `owner`.
 */
export async function createTestMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals: number = 6,
): Promise<PublicKey> {
  return createMint(connection, payer, mintAuthority, null, decimals);
}

/**
 * Get token balance for an ATA.
 */
export async function getTokenBalance(
  connection: Connection,
  ata: PublicKey,
): Promise<number> {
  const account = await getAccount(connection, ata);
  return Number(account.amount);
}
