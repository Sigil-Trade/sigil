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
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
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
} from "@solana/spl-token";
import BN from "bn.js";
import * as crypto from "crypto";
import { SIGIL_ERRORS } from "./strict-errors";
import {
  initVaultPreviewDigest,
  queuePolicyMergedDigest,
  computeAgentSetHash,
  type QueueOverride,
} from "./policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./intent-digest-fixture";

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

// ─── Mock-defi fixture program (deployed on devnet) ──────────────────────────
// The test-only Anchor program at tests/fixtures/mock-defi-src/, DEPLOYED to
// devnet at this id (deploy slot 468558720, upgrade authority = the devnet test
// wallet). Provides the EXACTLY-ONE counted DeFi instruction every V2 spending
// sandwich requires (F-Q2): `open_position` (no-op) for authorization-flow
// tests, `drain_via_delegation` for tests that must move real tokens so
// finalize_session measures a genuine balance delta (cap consumption).

export const MOCK_DEFI_PROGRAM_ID = new PublicKey(
  "2heRcfqPUcSiWpH1rAp2Zf4c4ZxfKmKaaVbJWGRa7Qm6",
);

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
function anchorDisc(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

export const MOCK_DEFI_OPEN_POSITION_DISC = anchorDisc("open_position");
export const MOCK_DEFI_DRAIN_DISC = anchorDisc("drain_via_delegation");

/**
 * Mock-defi `open_position` ix — true no-op (single signer, handler does
 * nothing). The canonical COUNTED-but-zero-spend DeFi instruction used as the
 * middle ix in composed spending sandwiches `[validate, <this>, finalize]`:
 * targeting the allowlisted MOCK_DEFI_PROGRAM_ID increments `defi_ix_count` to
 * exactly 1 (F-Q2) while moving zero tokens, so `finalize_session` measures
 * actual_spend == 0. Mirrors surfpool-setup's builder.
 */
export function buildMockDefiNoopIx(signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MOCK_DEFI_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(MOCK_DEFI_OPEN_POSITION_DISC),
  });
}

/**
 * Mock-defi `drain_via_delegation(amount)` ix — CPI SPL transfer using the
 * validate-granted delegation (validate's `token::approve` arms the agent as
 * delegate for `amount - fees`). EXACT replacement for the legacy raw SPL
 * `createTransferInstruction(vaultAta, dest, agent, netAmount)` middle ix:
 * same source, destination, authority and amount — one CPI level deeper, so
 * the top-level ix is the allowlisted mock-defi program instead of the
 * (blocked, UnauthorizedTokenTransfer 6038) SPL Token program.
 */
export function buildMockDefiDrainIx(
  source: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: number | BN,
): TransactionInstruction {
  const amountBn = new BN(amount);
  return new TransactionInstruction({
    programId: MOCK_DEFI_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(MOCK_DEFI_DRAIN_DISC),
      amountBn.toArrayLike(Buffer, "le", 8),
    ]),
  });
}

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
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
);
export const PROTOCOL_FEE_RATE = 200;
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const MAX_DEVELOPER_FEE_RATE = 500;
export const SESSION_DURATION_SECONDS = 30;
export const ROLLING_WINDOW_SECONDS = 86_400;

// ─── Collision-free vault ID generator ──────────────────────────────────────

let vaultIdCounter = 0;

/**
 * Returns a unique vault ID using `filePrefix * 1M + Date.now() % 1M + counter`.
 * Each test file should use a different filePrefix (1=smoke, 2=fees, 3=security, etc.)
 */
export function nextVaultId(filePrefix: number): BN {
  // A non-finite prefix would make the whole expression NaN, and `new BN(NaN)`
  // silently stringifies to "0" — collapsing every such id to one colliding
  // value. Fail loudly instead (mirrors a missing-arg call site).
  if (!Number.isFinite(filePrefix)) {
    throw new Error(
      `nextVaultId: filePrefix must be a finite number, got ${filePrefix}`,
    );
  }
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

// ─── Versioned-tx sender (unmasked errors) ──────────────────────────────────

/**
 * Numeric code → Sigil error name, derived from the canonical CI-drift-checked
 * `SIGIL_ERRORS` map (tests/helpers/strict-errors.ts) — never hand-maintained.
 */
const SIGIL_ERROR_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SIGIL_ERRORS).map(([name, code]) => [code, name]),
);

/**
 * Extract a custom error code from a tx error and resolve it to a name. The
 * error may arrive as the raw `{InstructionError:[i,{Custom:N}]}` object (devnet
 * confirmTransaction reject), `confirmation.value.err`, or an `Error` whose
 * message embeds the JSON — inspect both the structured form and `.message`.
 */
function resolveErrorName(err: any): string {
  const errJson = `${JSON.stringify(err)} ${String(err?.message ?? "")}`;
  const match = errJson.match(/"Custom":(\d+)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const name = SIGIL_ERROR_NAMES[code];
    if (name) return `${name} (${code})`;
  }
  return "";
}

export interface VersionedTxResult {
  signature: string;
  slot: number;
  logs: string[];
}

/**
 * Build, sign, and send a versioned transaction — mirrors surfpool-setup's
 * sender. anchor 0.32.1 × web3.js 1.98.4 repaint `.rpc()` failures as
 * "Unknown action 'undefined'", so EVERY error-asserting call must route
 * through this instead: a revert surfaces as `{Custom:N}` + the resolved
 * Sigil error name + the on-chain logs, which the strict
 * `@usesigil/kit/testing` expect-helpers can parse.
 */
export async function sendVersionedTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  signers: Keypair[] = [],
): Promise<VersionedTxResult> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer, ...signers]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  // web3.js `confirmTransaction(strategy, …)` is NOT uniform across RPCs on a
  // failed tx: a local surfnet RESOLVES with `{value:{err}}`, but the live
  // devnet RPC REJECTS with the raw `TransactionError` (`{InstructionError:
  // [i,{Custom:N}]}`). Normalize both into one `txErr` so the thrown message
  // ALWAYS carries the `{Custom:N}` JSON — otherwise sendInitVault's retry
  // (which greps the message for `"Custom":6071`) sees a raw object with no
  // `.message`, `String(e)` is "[object Object]", the grep misses, and init
  // rethrows on the FIRST 6071 instead of retrying. That was the devnet-only
  // init failure: sessions/timelock passed only when the first slot-bind
  // happened to land clean.
  let txErr: unknown = null;
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    txErr = confirmation.value.err;
  } catch (rejected) {
    txErr = rejected;
  }

  if (txErr) {
    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = txDetails?.meta?.logMessages ?? [];
    const errorName = resolveErrorName(txErr);
    const err = new Error(
      `Transaction failed: ${errorName} ${JSON.stringify(txErr)} Logs: ${logs.join(" ")}`,
    );
    // Attach the slot the failed tx actually executed in — sendInitVault uses
    // it to ADAPT the next slot-bind to the observed landing latency (which
    // grows under burst load) instead of guessing a fixed offset.
    (err as any).landedSlot = txDetails?.slot ?? null;
    throw err;
  }

  const txDetails = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  return {
    signature,
    slot: txDetails?.slot ?? 0,
    logs: txDetails?.meta?.logMessages ?? [],
  };
}

// ─── initialize_vault slot-bound sender (PEN-CROSS-2 aware) ─────────────────

/**
 * Send an `initialize_vault` transaction whose owner-signed preview digest is
 * bound to the slot the tx actually executes in.
 *
 * WHY: `initialize_vault` (programs/sigil/src/instructions/initialize_vault.rs
 * :203) captures `Clock::get()?.slot` at handler entry, recomputes the policy-
 * preview digest with that slot at canonical position 14 (PEN-CROSS-2
 * close+reinit replay defense), and `require!`s exact equality with the
 * owner-signed `preview_digest` (else `PolicyPreviewMismatch`, 6071). The
 * caller must therefore predict the EXACT slot the tx will land in.
 *
 * The land slot = base + (latency between getSlot and execution). That latency
 * is NOT constant: under burst load (a before() creating 8–12 vaults back to
 * back through the 5-RPS throttle) the getLatestBlockhash + send queue deeper,
 * so the tx lands many more slots after the getSlot() read. A fixed offset
 * cycle (the old [3,4,2,5,6,1,8,10], max 10) silently breaks once the real
 * landing offset exceeds its max — every attempt binds too low → persistent
 * 6071 → exhaustion.
 *
 * Fix: ADAPT. On each 6071 the failed tx carries its actual landing slot
 * (`err.landedSlot`); the observed offset `landed - base` is the latency we
 * just measured, so the next attempt binds `newBase + observedOffset (+1)`.
 * Latency is stable within a burst, so this converges in ~1–2 attempts at ANY
 * load. A fixed fan-out seeds attempt 0 and backstops a missing observation.
 * All non-6071 errors propagate immediately (no masking).
 *
 * @param buildIx receives the slot to bind into the digest and returns the
 *                fully-built `initialize_vault` instruction.
 */
export async function sendInitVault(
  connection: Connection,
  payer: Keypair,
  buildIx: (createdAtSlot: number) => Promise<TransactionInstruction>,
  signers: Keypair[] = [],
  maxAttempts: number = 40,
): Promise<VersionedTxResult> {
  const seedOffsets = [4, 6, 8, 10, 13, 16, 20, 25];
  let adaptiveOffset: number | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const base = await connection.getSlot("processed");
    const offset = adaptiveOffset ?? seedOffsets[attempt % seedOffsets.length];
    const createdAtSlot = base + offset;
    const ix = await buildIx(createdAtSlot);
    try {
      return await sendVersionedTx(connection, [ix], payer, signers);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // 6071 = PolicyPreviewMismatch: the bound slot ≠ the execution slot.
      // Adapt the next bind to the observed landing latency, then retry.
      if (
        msg.includes('"Custom":6071') ||
        msg.includes("PolicyPreviewMismatch")
      ) {
        lastErr = e;
        const landed: number | null = e?.landedSlot ?? null;
        // `landed - base` IS the slot latency we just measured; bind exactly
        // that next round. (A +1 bias would oscillate forever under stable
        // latency — always one slot beyond where the tx lands.) A miss in
        // either direction re-measures and self-corrects: grew → larger
        // offset, shrank → smaller. Clamp so a bogus observation can't bind
        // absurdly far out.
        adaptiveOffset =
          typeof landed === "number" && landed > base
            ? Math.max(1, Math.min(landed - base, 80))
            : null; // unusable observation → fall back to the seed cycle
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `initialize_vault: could not bind the execution slot after ${maxAttempts} attempts ` +
      `(landing latency unstable / RPC degraded). Last error: ${lastErr}`,
  );
}

/**
 * Build the `new_policy_preview_digest` arg for `queue_policy_update`.
 *
 * The handler (queue_policy_update.rs:565) recomputes the FULL merged-effective
 * policy digest — live policy with the queued `override` applied — and
 * `require!`s it equals the caller-supplied digest, else PolicyPreviewMismatch
 * (6071). So a zero placeholder is rejected the moment any field changes; the
 * caller MUST supply the correctly-merged digest (it is a signed input, not an
 * assertion). The live agent-set hash is derived from `vault.agents` (NOT a
 * stored policy field) and `observe_only` from the vault — both fed in here so
 * the recomputed digest matches the handler's.
 */
export async function buildQueueDigest(
  program: Program<Sigil>,
  policyPda: PublicKey,
  vaultPda: PublicKey,
  override: QueueOverride = {},
): Promise<number[]> {
  const policy = (await program.account.policyConfig.fetch(policyPda)) as any;
  const vault = (await program.account.agentVault.fetch(vaultPda)) as any;
  return queuePolicyMergedDigest(
    {
      ...policy,
      // agent_set_hash is recomputed from vault.agents, not stored on policy.
      agentSetHash: computeAgentSetHash(vault.agents),
    },
    override,
    vault.observeOnly,
  );
}

// ─── Full vault factory ─────────────────────────────────────────────────────

/** Capability 2 = OPERATOR (= FULL_CAPABILITY). Mirrors state/mod.rs. */
export const CAPABILITY_OPERATOR = 2;

/**
 * Handle for a queued-but-not-yet-applied OPERATOR grant (F-Q6). A single-key
 * vault can NEVER seat an OPERATOR instantly (`ErrOperatorGrantRequiresTimelock`
 * 6107) — the lawful devnet path is queue_agent_grant → wait out the on-chain
 * 600s floor → apply_agent_grant. `createFullVault` queues and returns this
 * handle; batch every vault's handle into ONE `applyOperatorGrants()` call so
 * the whole file pays a single 600s wait instead of one per vault.
 */
export interface OperatorGrantHandle {
  vaultPda: PublicKey;
  agent: PublicKey;
  /** On-chain queue timestamp (pending_agent_grant.queued_at, unix seconds). */
  queuedAt: number;
  /** On-chain effective delay (600 for a single-key vault). */
  minDelaySeconds: number;
}

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
  devFeeRate?: number;
  maxSlippageBps?: number;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  depositAmount?: BN;
  skipDeposit?: boolean;
  skipAgent?: boolean;
  /**
   * Capability for the registered agent. Default OPERATOR (2) — which is
   * QUEUED, not applied (see OperatorGrantHandle). Observer (1) / Disabled (0)
   * register instantly but cannot spend.
   */
  agentCapability?: number;
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
  /**
   * Non-null when an OPERATOR-class grant was QUEUED (agentCapability >= 2 and
   * !skipAgent). The agent CANNOT spend until this is passed through
   * `applyOperatorGrants()` after the on-chain 600s floor elapses.
   */
  operatorGrant: OperatorGrantHandle | null;
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
    devFeeRate = 0,
    maxSlippageBps = 500,
    timelockDuration = new BN(1800), // mandatory minimum: 30 min
    allowedDestinations = [],
    depositAmount = new BN(1_000_000_000),
    skipDeposit = false,
    skipAgent = false,
    agentCapability = CAPABILITY_OPERATOR,
  } = opts;

  const payer = (owner as any).payer;
  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
  // anchor 0.32.1 type-depth ceiling (TS2589) on long builder chains — alias
  // methods to `any` ONCE, same as surfpool-setup (see its rationale comment).
  const methods = program.methods as any;

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
  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), pdas.vaultPda.toBuffer(), Buffer.from([0])],
    program.programId,
  );
  await sendInitVault(connection, payer, (createdAtSlot) =>
    methods
      .initializeVault(
        vaultId,
        dailyCap,
        maxTx,
        protocolMode,
        allowedProtocols,
        devFeeRate,
        maxSlippageBps,
        timelockDuration,
        allowedDestinations,
        [],
        false, // observeOnly (Phase 2 TA-19)
        0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
        false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
        5, // auto_revoke_threshold (TA-17 Phase 3 — default)
        new BN(0), // stable_balance_floor (TA-12 Phase 5 — disabled)
        new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — disabled)
        false, // cosign_required (G6 audit 2026-05-18 — not opted in)
        initVaultPreviewDigest({
          dailySpendingCapUsd: dailyCap,
          maxTransactionSizeUsd: maxTx,
          maxSlippageBps: maxSlippageBps,
          // The handler recomputes the digest with the developer_fee_rate IX
          // arg (= devFeeRate, position 6 above); omitting it here defaults to
          // 0 and a devFeeRate>0 vault would mismatch → PolicyPreviewMismatch
          // (6071). Bind the SAME value into the signed digest.
          developerFeeRate: devFeeRate,
          protocolMode: protocolMode,
          protocols: allowedProtocols,
          allowedDestinations: allowedDestinations,
          timelockDuration: timelockDuration,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          // PEN-CROSS-2: bind the owner-signed digest to the slot
          // initialize_vault will execute in (sendInitVault retries on 6071).
          createdAtSlot,
        }),
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
      .instruction(),
  );

  // Seat the agent. F-Q6 (register_agent.rs:130-146): an OPERATOR-class grant
  // (capability >= 2) on a fresh single-key vault can NEVER be instant — it
  // must route queue_agent_grant → 600s on-chain floor → apply_agent_grant.
  // We QUEUE here and hand back an OperatorGrantHandle; the test file batches
  // every handle into one applyOperatorGrants() call (single 600s wait per
  // file). Observer (1) / Disabled (0) grants register instantly.
  let operatorGrant: OperatorGrantHandle | null = null;
  if (!skipAgent) {
    if (agentCapability >= CAPABILITY_OPERATOR) {
      operatorGrant = await queueOperatorGrant(
        program,
        connection,
        owner,
        pdas.vaultPda,
        agent.publicKey,
        agentCapability,
      );
    } else {
      const registerIx = await methods
        .registerAgent(agent.publicKey, agentCapability, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: pdas.vaultPda,
          agentSpendOverlay: overlayPda,
        })
        .instruction();
      await sendVersionedTx(connection, [registerIx], payer);
    }
  }

  // Deposit tokens (versioned send — a failure surfaces as {Custom:N}, not
  // the anchor × web3.js "Unknown action 'undefined'" mask).
  if (!skipDeposit) {
    const depositIx = await methods
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
      })
      .instruction();
    await sendVersionedTx(connection, [depositIx], payer);
  }

  return {
    ...pdas,
    overlayPda,
    vaultTokenAta,
    ownerTokenAta,
    protocolTreasuryAta,
    feeDestinationAta,
    operatorGrant,
  };
}

/**
 * Queue an OPERATOR-class agent grant (F-Q6 lawful path step 1 of 2) and
 * return the handle for a later batched `applyOperatorGrants()`. The handle's
 * queuedAt/minDelaySeconds are read back from the ON-CHAIN pending account —
 * cluster-clock truth, immune to local-clock skew.
 */
export async function queueOperatorGrant(
  program: Program<Sigil>,
  connection: Connection,
  owner: anchor.Wallet,
  vaultPda: PublicKey,
  agent: PublicKey,
  capability: number = CAPABILITY_OPERATOR,
  spendingLimitUsd: BN = new BN(0),
): Promise<OperatorGrantHandle> {
  const payer = (owner as any).payer as Keypair;
  const methods = program.methods as any;
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vaultPda.toBuffer()],
    program.programId,
  );
  const [pendingGrantPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_agent_grant"), vaultPda.toBuffer()],
    program.programId,
  );
  const [auditSuccessPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("audit_success"), vaultPda.toBuffer()],
    program.programId,
  );
  const queueIx = await methods
    .queueAgentGrant(agent, capability, spendingLimitUsd)
    .accounts({
      owner: owner.publicKey,
      vault: vaultPda,
      policy: policyPda,
      pending: pendingGrantPda,
      auditLogSuccess: auditSuccessPda,
      slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await sendVersionedTx(connection, [queueIx], payer);
  const pendingAcc = await (program.account as any).pendingAgentGrant.fetch(
    pendingGrantPda,
  );
  return {
    vaultPda,
    agent,
    queuedAt: Number(pendingAcc.queuedAt),
    minDelaySeconds: Number(pendingAcc.minDelaySeconds),
  };
}

/**
 * Wait out the on-chain OPERATOR-grant timelock and apply every queued grant.
 *
 * Deadline = max(queuedAt + minDelaySeconds) over all handles, measured
 * against the CLUSTER clock (getBlockTime), not the local clock — the on-chain
 * check is `clock.unix_timestamp - queued_at >= min_delay_seconds`
 * (apply_agent_grant.rs), and devnet's stake-weighted clock can skew from
 * wall-time. One long sleep to the estimated deadline, then short verify
 * polls. Call ONCE per file with every vault's handle so the whole file pays
 * a single ~600s wait.
 */
/**
 * Block until the devnet CLUSTER clock (getBlockTime) reaches `deadlineUnix`,
 * then return. On-chain timelocks gate on `Clock::unix_timestamp`, which is the
 * stake-weighted cluster clock and can skew from wall-time — so we poll it
 * rather than sleeping a fixed wall-duration. Bounded by a wall-clock cap
 * (remaining cluster gap + 180s slack) so a stuck/null getBlockTime throws an
 * explicit diagnostic instead of spinning until the mocha hook timeout.
 */
export async function waitForClusterTime(
  connection: Connection,
  deadlineUnix: number,
  label = "deadline",
): Promise<void> {
  const wallStart = Date.now();
  let firstClusterTime: number | null = null;
  let firstPass = true;
  for (;;) {
    const slot = await connection.getSlot("confirmed");
    const clusterTime = await connection.getBlockTime(slot);
    if (clusterTime !== null) {
      if (firstClusterTime === null) firstClusterTime = clusterTime;
      if (clusterTime >= deadlineUnix) return;
    }
    const capMs =
      firstClusterTime !== null
        ? (deadlineUnix - firstClusterTime + 180) * 1000
        : 180_000;
    if (Date.now() - wallStart > capMs) {
      throw new Error(
        `waitForClusterTime(${label}): cluster clock never reached ${deadlineUnix} ` +
          `within wall cap (${Math.round(capMs / 1000)}s) — getBlockTime degraded?`,
      );
    }
    const remaining =
      clusterTime === null ? 10 : Math.max(deadlineUnix - clusterTime, 1);
    // First pass sleeps the whole residual in one go; later passes verify in
    // short steps (cluster clock can lag wall-time by a few seconds).
    await sleep(
      (firstPass ? remaining + 2 : Math.min(remaining + 1, 10)) * 1000,
    );
    firstPass = false;
  }
}

export async function applyOperatorGrants(
  program: Program<Sigil>,
  connection: Connection,
  owner: anchor.Wallet,
  grants: (OperatorGrantHandle | null | undefined)[],
): Promise<void> {
  const live = grants.filter(Boolean) as OperatorGrantHandle[];
  if (live.length === 0) return;
  const payer = (owner as any).payer as Keypair;
  const methods = program.methods as any;

  const deadline =
    Math.max(...live.map((g) => g.queuedAt + g.minDelaySeconds)) + 3;
  await waitForClusterTime(connection, deadline, "operator-grant-timelock");

  for (const g of live) {
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), g.vaultPda.toBuffer()],
      program.programId,
    );
    const [pendingGrantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_grant"), g.vaultPda.toBuffer()],
      program.programId,
    );
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), g.vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [auditSuccessPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), g.vaultPda.toBuffer()],
      program.programId,
    );
    const applyIx = await methods
      .applyAgentGrant()
      .accounts({
        owner: owner.publicKey,
        vault: g.vaultPda,
        policy: policyPda,
        pending: pendingGrantPda,
        agentSpendOverlay: overlayPda,
        auditLogSuccess: auditSuccessPda,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .instruction();
    await sendVersionedTx(connection, [applyIx], payer);
  }
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
  /**
   * Middle (counted) DeFi instruction of the sandwich — F-Q2 requires EXACTLY
   * one. Default: `drain_via_delegation` when `mockSpendDestination` is set
   * with amount > 0 (legacy mock-spend semantics, REAL token movement), else
   * the `open_position` no-op. Pass "none" to deliberately compose a
   * structurally-invalid zero-DeFi-ix sandwich (asserting
   * TooManyDeFiInstructions), or a custom TransactionInstruction.
   */
  middleIx?: "noop" | "drain" | "none" | TransactionInstruction;
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
    protocolTreasuryAta = null,
    feeDestinationAta = null,
    outputStablecoinAccount = null,
    remainingAccounts = [],
  } = opts;

  // Read current policy version from on-chain if not provided.
  // Ensures tests that queue+apply policy changes use the correct version.
  let policyVersion: BN;
  if (opts.expectedPolicyVersion !== undefined) {
    policyVersion = opts.expectedPolicyVersion;
  } else {
    try {
      const pol = await program.account.policyConfig.fetch(policyPda);
      policyVersion = ((pol as any).policyVersion ?? new BN(0)) as BN;
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
      mint,
      amount,
      protocol,
      policyVersion,
      new BN(0),
      digestAsArgs(
        buildExpectedIntentDigest({
          vault: vaultPda,
          agent: agent.publicKey,
          tokenMint: mint,
          amount,
          targetProtocol: protocol,
        }),
      ),
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
  // 1. Resolve the middle (counted) DeFi instruction — F-Q2 requires EXACTLY
  //    one per spending sandwich, so the default is never "nothing":
  //    - mockSpendDestination + amount > 0 → drain_via_delegation moving
  //      netAmount via the validate-granted delegation (REAL balance delta,
  //      preserving the legacy raw-SPL mock-spend semantics one CPI deeper —
  //      top-level SPL Transfer is blocked, UnauthorizedTokenTransfer 6038);
  //    - otherwise → open_position no-op (counted, zero-spend);
  //    - "none" → deliberately structurally-invalid (error-path tests);
  //    - a TransactionInstruction → used verbatim.
  let middle: TransactionInstruction | null;
  const spec = opts.middleIx;
  if (spec instanceof TransactionInstruction) {
    middle = spec;
  } else if (spec === "none") {
    middle = null;
  } else if (
    spec === "drain" ||
    (spec === undefined &&
      opts.mockSpendDestination &&
      opts.amount.toNumber() > 0)
  ) {
    if (!opts.mockSpendDestination) {
      throw new Error("middleIx 'drain' requires mockSpendDestination");
    }
    const { netAmount } = calculateFees(
      opts.amount.toNumber(),
      opts.mockSpendDevFeeRate ?? 0,
    );
    middle = buildMockDefiDrainIx(
      opts.vaultTokenAta,
      opts.mockSpendDestination,
      opts.agent.publicKey, // delegate authority (set by validate's Approve)
      netAmount,
    );
  } else {
    middle = buildMockDefiNoopIx(opts.agent.publicKey);
  }

  // 2. F-Q1a completeness: every WRITABLE meta of the counted DeFi ix — plus
  //    the tx fee payer, which is compiled-writable in EVERY instruction —
  //    must be resolvable from validate's remaining_accounts, else
  //    DestinationAccountUnresolvable (6105). Read-only entries suffice (the
  //    destination check only needs the account bytes). Merge with any
  //    caller-supplied entries, deduped by pubkey.
  const autoRemaining: {
    pubkey: PublicKey;
    isWritable: boolean;
    isSigner: boolean;
  }[] = [];
  if (middle) {
    for (const k of middle.keys) {
      if (k.isWritable) {
        autoRemaining.push({
          pubkey: k.pubkey,
          isWritable: false,
          isSigner: false,
        });
      }
    }
    autoRemaining.push({
      pubkey: opts.agent.publicKey, // fee payer
      isWritable: false,
      isSigner: false,
    });
  }
  const seen = new Set<string>();
  const mergedRemaining = [
    ...(opts.remainingAccounts ?? []),
    ...autoRemaining,
  ].filter((m) => {
    const key = m.pubkey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const validateIx = await buildAuthorizeIx({
    ...opts,
    remainingAccounts: mergedRemaining,
  });
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

  // 3. Compose [validate, middle?, finalize] and send as ONE versioned tx via
  //    the unmasked sender — a revert surfaces as {Custom:N} + error name.
  const instructions = middle
    ? [validateIx, middle, finalizeIx]
    : [validateIx, finalizeIx];

  const result = await sendVersionedTx(
    opts.connection,
    instructions,
    opts.agent,
  );
  return result.signature;
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

export async function finalize(_opts: FinalizeOpts): Promise<string> {
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

// The legacy substring-matching `expectErrorLegacy` helper was deleted by
// the 2026-04-20 council codemod. All call sites migrated to strict typed
// helpers at `@usesigil/kit/testing`. See:
//   MEMORY/WORK/20260420-201121_test-assertion-precision-council/COUNCIL_DECISION.md
//   import { expectSigilError, expectAnchorError, expectOneOfSigilErrors,
//            expectOneOfAnchorErrors, expectSystemError } from "@usesigil/kit/testing";

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
