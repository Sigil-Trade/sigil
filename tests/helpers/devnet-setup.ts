/**
 * Devnet Test Helpers — shared constants, PDA derivation, vault factory, and utilities.
 *
 * Used by all devnet-*.ts test files.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../../target/types/agent_shield";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

// ─── RPC Rate Limiter (prevents 429s from Helius devnet 10 RPS limit) ───────

const RPC_MAX_RPS = 5; // Conservative: 5 RPS against 10 RPS limit
const RPC_MIN_GAP_MS = Math.ceil(1000 / RPC_MAX_RPS); // 200ms between requests
let rateLimitInstalled = false;

/**
 * Patches globalThis.fetch with a queue that enforces minimum spacing between
 * requests. JavaScript's single-threaded model makes the slot reservation atomic.
 */
export function installRateLimit(): void {
  if (rateLimitInstalled) return;
  rateLimitInstalled = true;

  let nextSlot = 0;
  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function throttledFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    // Atomically reserve next time slot (single-threaded = no race)
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

// ─── Constants (mirrors programs/agent-shield/src/state/mod.rs) ─────────────

export const PROTOCOL_TREASURY = new PublicKey(
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT"
);
export const PROTOCOL_FEE_RATE = 200;
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const MAX_DEVELOPER_FEE_RATE = 500;
export const SESSION_EXPIRY_SLOTS = 20;
export const ROLLING_WINDOW_SECONDS = 86_400;

// ─── AllowedToken builder ───────────────────────────────────────────────────

export function makeAllowedToken(
  mint: PublicKey,
  oracleFeed: PublicKey = PublicKey.default,
  decimals: number = 6,
  dailyCapBase: BN = new BN(0),
  maxTxBase: BN = new BN(0),
) {
  return { mint, oracleFeed, decimals, dailyCapBase, maxTxBase };
}

// ─── Collision-free vault ID generator ──────────────────────────────────────

let vaultIdCounter = 0;

/**
 * Returns a unique vault ID using `filePrefix * 1M + Date.now() % 1M + counter`.
 * Each test file should use a different filePrefix (1=smoke, 2=fees, 3=security, etc.)
 */
export function nextVaultId(filePrefix: number): BN {
  return new BN(
    filePrefix * 1_000_000 + (Date.now() % 1_000_000) + vaultIdCounter++
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
  installRateLimit(); // Throttle RPC to stay under Helius 10 RPS limit
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgentShield as Program<AgentShield>;
  const connection = provider.connection;
  const owner = provider.wallet as anchor.Wallet;
  return { provider, program, connection, owner };
}

// ─── Full vault factory ─────────────────────────────────────────────────────

export interface CreateFullVaultOpts {
  program: Program<AgentShield>;
  connection: Connection;
  owner: anchor.Wallet;
  agent: Keypair;
  feeDestination: PublicKey;
  mint: PublicKey;
  vaultId: BN;
  dailyCap?: BN;
  maxTx?: BN;
  allowedTokens?: ReturnType<typeof makeAllowedToken>[];
  allowedProtocols?: PublicKey[];
  maxLevBps?: number;
  maxPositions?: number;
  canOpenPositions?: boolean;
  devFeeRate?: number;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  trackerTier?: number;
  depositAmount?: BN;
  skipDeposit?: boolean;
  skipAgent?: boolean;
}

export interface FullVaultResult {
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  pendingPolicyPda: PublicKey;
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
    allowedTokens,
    allowedProtocols = [Keypair.generate().publicKey],
    maxLevBps = 0,
    maxPositions = 3,
    devFeeRate = 0,
    timelockDuration = new BN(0),
    allowedDestinations = [],
    trackerTier = 0,
    depositAmount = new BN(1_000_000_000),
    skipDeposit = false,
    skipAgent = false,
  } = opts;

  const payer = (owner as any).payer;
  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
  const tokens = allowedTokens ?? [makeAllowedToken(mint)];

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

  // Initialize vault
  await program.methods
    .initializeVault(
      vaultId,
      dailyCap,
      maxTx,
      tokens,
      allowedProtocols,
      new BN(maxLevBps) as any,
      maxPositions,
      devFeeRate,
      timelockDuration,
      allowedDestinations,
      trackerTier,
    )
    .accounts({
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      policy: pdas.policyPda,
      tracker: pdas.trackerPda,
      feeDestination,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  // Register agent
  if (!skipAgent) {
    await program.methods
      .registerAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
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
    vaultTokenAta,
    ownerTokenAta,
    protocolTreasuryAta,
    feeDestinationAta,
  };
}

// ─── Authorize + Finalize helper ────────────────────────────────────────────

export interface AuthorizeOpts {
  program: Program<AgentShield>;
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
}

export async function authorize(opts: AuthorizeOpts): Promise<string> {
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
  } = opts;
  return program.methods
    .validateAndAuthorize(
      actionType,
      mint,
      amount,
      protocol,
      leverageBps !== null ? (new BN(leverageBps) as any) : null,
    )
    .accounts({
      agent: agent.publicKey,
      vault: vaultPda,
      policy: policyPda,
      tracker: trackerPda,
      session: sessionPda,
      vaultTokenAccount: vaultTokenAta,
      tokenMintAccount: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([agent])
    .rpc();
}

export interface FinalizeOpts {
  program: Program<AgentShield>;
  payer: Keypair;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  sessionPda: PublicKey;
  agentPubkey: PublicKey;
  vaultTokenAta: PublicKey | null;
  feeDestinationAta: PublicKey | null;
  protocolTreasuryAta: PublicKey | null;
  success: boolean;
}

export async function finalize(opts: FinalizeOpts): Promise<string> {
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
    success,
  } = opts;
  return program.methods
    .finalizeSession(success)
    .accounts({
      payer: payer.publicKey,
      vault: vaultPda,
      policy: policyPda,
      tracker: trackerPda,
      session: sessionPda,
      sessionRentRecipient: agentPubkey,
      vaultTokenAccount: vaultTokenAta,
      feeDestinationTokenAccount: feeDestinationAta,
      protocolTreasuryTokenAccount: protocolTreasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer])
    .rpc();
}

export async function authorizeAndFinalize(
  opts: AuthorizeOpts & {
    feeDestinationAta: PublicKey | null;
    protocolTreasuryAta: PublicKey;
    success?: boolean;
  },
): Promise<void> {
  await authorize(opts);
  await finalize({
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
    success: opts.success ?? true,
  });
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
  const protocolFee = Math.floor(
    (amount * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR,
  );
  const developerFee = Math.floor(
    (amount * devFeeRate) / FEE_RATE_DENOMINATOR,
  );
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
