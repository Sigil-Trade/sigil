/**
 * Surfpool test infrastructure — real RPC with cheatcode extensions.
 *
 * Parallel to litesvm-setup.ts but uses a live Surfnet (local LiteSVM-backed
 * validator with lazy devnet forking). Requires `surfpool start --network devnet`
 * running in the background.
 *
 * Cheatcodes are accessed via connection._rpcRequest("surfnet_*", [...]).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../../target/types/sigil";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { initVaultPreviewDigest } from "./policy-digest";
import { SIGIL_ERRORS } from "./strict-errors";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK",
);

/**
 * Mock-DeFi fixture program (counted-zero-spend noop) — mirrors litesvm-setup.ts.
 * Allowlisted as the default protocol so active (non-observe_only) vaults satisfy
 * F-11 (initialize_vault.rs:188: an active vault must have >=1 protocol OR
 * destination on the allowlist). Allowlisting the pubkey is enough for
 * initialize_vault to succeed; the fixture .so only needs to be DEPLOYED to the
 * Surfnet before a spending sandwich actually targets it (follow-up work).
 */
const MOCK_DEFI_PROGRAM_ID = new PublicKey(
  "2pB26qKW73sToF7ETcdhXQTj8biYwAk9TCArVwgHBe24",
);

const SURFPOOL_RPC_URL =
  process.env.SURFPOOL_RPC_URL || "http://localhost:8899";

/** Devnet USDC: DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH (test-controlled keypair) */
export const DEVNET_USDC_MINT = new PublicKey(
  "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH",
);

/** Devnet USDT: 43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze (test-controlled keypair) */
export const DEVNET_USDT_MINT = new PublicKey(
  "43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze",
);

/** Protocol treasury (must match on-chain constant) */
export const PROTOCOL_TREASURY = new PublicKey(
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
);

export const PROTOCOL_FEE_RATE = 200;
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const SESSION_DURATION_SECONDS = 30;
export const ROLLING_WINDOW_SECONDS = 86_400;

// ─── Surfnet RPC cheatcode caller ───────────────────────────────────────────

/**
 * Low-level cheatcode caller via connection._rpcRequest.
 * Surfnet exposes custom RPC methods prefixed with "surfnet_".
 */
export async function surfnetRpc(
  connection: Connection,
  method: string,
  params: any[] = [],
): Promise<any> {
  const result = await (connection as any)._rpcRequest(method, params);
  if (result.error) {
    throw new Error(
      `Surfnet RPC error (${method}): ${JSON.stringify(result.error)}`,
    );
  }
  return result.result;
}

// ─── Readiness check ────────────────────────────────────────────────────────

/**
 * Poll until Surfnet is responsive, then register the IDL for Studio parsing.
 */
export async function waitForReady(
  rpcUrl: string = SURFPOOL_RPC_URL,
  maxRetries: number = 30,
): Promise<Connection> {
  const connection = new Connection(rpcUrl, "confirmed");

  for (let i = 0; i < maxRetries; i++) {
    try {
      await connection.getSlot();
      // Register IDL for account parsing in Studio
      const idlPath = path.resolve(__dirname, "../../target/idl/sigil.json");
      if (fs.existsSync(idlPath)) {
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
        try {
          await surfnetRpc(connection, "surfnet_registerIdl", [idl]);
        } catch {
          // IDL registration is best-effort — tests work without it
        }
      }
      return connection;
    } catch {
      if (i === maxRetries - 1) {
        throw new Error(
          `Surfnet not ready after ${maxRetries} attempts at ${rpcUrl}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("unreachable");
}

// ─── Local program deployment ────────────────────────────────────────────────

/**
 * Deploy the local sigil.so to Surfnet via `solana program deploy`.
 *
 * surfnet_setAccount alone does NOT update the SVM's compiled program cache.
 * The standard BPF Loader Deploy instruction is required to properly reload
 * the executable. Steps:
 *   1. Create a temporary deployer keypair and fund it
 *   2. Change the devnet-forked program's upgrade authority to our deployer
 *   3. Run `solana program deploy` which triggers a proper BPF reload
 */
async function deployLocalProgram(connection: Connection): Promise<void> {
  const soPath = path.resolve(__dirname, "../../target/deploy/sigil.so");
  if (!fs.existsSync(soPath)) {
    throw new Error(
      `Program .so not found at ${soPath}. Run 'anchor build --no-idl' first.`,
    );
  }

  // 1. Create temp deployer keypair
  const deployer = Keypair.generate();
  const deployerPath = path.resolve(__dirname, "../../.surfpool/deployer.json");
  fs.mkdirSync(path.dirname(deployerPath), { recursive: true });
  fs.writeFileSync(
    deployerPath,
    JSON.stringify(Array.from(deployer.secretKey)),
  );

  // 2. Fund deployer. Deploying the ~1.27MB sigil.so allocates a buffer
  //    (~8.9 SOL rent) AND the programdata account (~8.9 SOL) before the
  //    buffer lamports are reclaimed, so the deployer needs ~18 SOL peak.
  //    Fund 30 SOL for headroom across the 3 deploy retries.
  await surfnetRpc(connection, "surfnet_setAccount", [
    deployer.publicKey.toString(),
    { lamports: 30 * LAMPORTS_PER_SOL },
  ]);

  // 3. Change program upgrade authority to our deployer
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo) {
    throw new Error("Program account not found on Surfnet");
  }
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const dataInfo = await connection.getAccountInfo(programDataAddress);
  if (!dataInfo) {
    throw new Error("Program data account not found on Surfnet");
  }

  const modifiedData = Buffer.from(dataInfo.data);
  modifiedData.writeUInt8(1, 12); // has_authority = true
  deployer.publicKey.toBuffer().copy(modifiedData, 13);

  await surfnetRpc(connection, "surfnet_setAccount", [
    programDataAddress.toString(),
    {
      data: modifiedData.toString("hex"),
      owner: dataInfo.owner.toString(),
      lamports: dataInfo.lamports,
    },
  ]);

  // 4. Deploy via solana CLI (properly updates SVM program cache)
  //    Retry up to 3 times — Surfnet can be slow after reset or on cold CI cache
  const rpcUrl = (connection as any)._rpcEndpoint || SURFPOOL_RPC_URL;
  const deployCmd =
    `solana program deploy "${soPath}" ` +
    `--program-id ${PROGRAM_ID.toString()} ` +
    `--keypair "${deployerPath}" ` +
    `--url ${rpcUrl} ` +
    `--upgrade-authority "${deployerPath}"`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Deploying ~1.27MB takes ~1250 chunk writes; allow up to 5 min/attempt.
      execSync(deployCmd, { stdio: "pipe", timeout: 300_000 });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
  throw lastErr;
}

// ─── Test environment ───────────────────────────────────────────────────────

export interface SurfpoolTestEnv {
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: Program<Sigil>;
  payer: Keypair;
}

/**
 * Create a full Anchor test environment connected to Surfnet.
 * The payer is a fresh keypair funded via setAccountLamports.
 * Deploys the local .so to ensure tests run against current code.
 */
export async function createSurfpoolTestEnv(): Promise<SurfpoolTestEnv> {
  const connection = await waitForReady();

  // Deploy local program (overrides devnet-forked version)
  await deployLocalProgram(connection);

  const payer = Keypair.generate();

  // Fund payer via cheatcode
  await setAccountLamports(connection, payer.publicKey, 100 * LAMPORTS_PER_SOL);

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);

  const program = new Program<Sigil>(
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../target/idl/sigil.json"),
        "utf-8",
      ),
    ),
    provider,
  );

  return { connection, provider, program, payer };
}

// ─── Account / balance manipulation ─────────────────────────────────────────

/**
 * Set an account's lamports directly via surfnet_setAccount.
 * Official API: surfnet_setAccount(pubkey, update)
 */
export async function setAccountLamports(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number,
): Promise<void> {
  await surfnetRpc(connection, "surfnet_setAccount", [
    pubkey.toString(),
    { lamports },
  ]);
}

/**
 * Create a funded wallet keypair.
 */
export async function createWallet(
  connection: Connection,
  _name: string,
  solAmount: number = 10,
): Promise<Keypair> {
  const kp = Keypair.generate();
  await setAccountLamports(
    connection,
    kp.publicKey,
    solAmount * LAMPORTS_PER_SOL,
  );
  return kp;
}

/**
 * Ensure an SPL Token mint account exists at the given address.
 * Needed for mints that don't exist on devnet (e.g., USDT).
 * Writes a valid 82-byte SPL Token mint directly via surfnet_setAccount.
 */
export async function ensureMintExists(
  connection: Connection,
  mint: PublicKey,
  decimals: number = 6,
): Promise<void> {
  const info = await connection.getAccountInfo(mint);
  if (info) return; // already exists (lazily forked from devnet)

  // SPL Token Mint layout: 82 bytes
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0); // mint_authority: None
  // supply (u64 LE) at offset 36 = 0
  data.writeUInt8(decimals, 44); // decimals
  data.writeUInt8(1, 45); // is_initialized = true
  data.writeUInt32LE(0, 46); // freeze_authority: None

  await surfnetRpc(connection, "surfnet_setAccount", [
    mint.toString(),
    {
      data: data.toString("hex"),
      owner: TOKEN_PROGRAM_ID.toString(),
      lamports: 1_000_000_000,
    },
  ]);
}

/**
 * Fund a wallet with SPL tokens via surfnet_setTokenAccount.
 * Creates/overrides the associated token account for the given mint.
 * Official API: surfnet_setTokenAccount(owner, mint, update)
 */
export async function fundWithTokens(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: string | number,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  await surfnetRpc(connection, "surfnet_setTokenAccount", [
    owner.toString(),
    mint.toString(),
    { amount: typeof amount === "string" ? Number(amount) : amount },
  ]);
  return ata;
}

// ─── Time travel / clock control ────────────────────────────────────────────

export interface TimeTravelOpts {
  absoluteSlot?: number;
  absoluteTimestamp?: number;
  absoluteEpoch?: number;
}

/**
 * Jump Surfnet to a future slot, timestamp, or epoch.
 */
export async function timeTravel(
  connection: Connection,
  opts: TimeTravelOpts,
): Promise<void> {
  await surfnetRpc(connection, "surfnet_timeTravel", [opts]);
}

/**
 * Pause Surfnet block production.
 */
export async function pauseClock(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_pauseClock", []);
}

/**
 * Resume Surfnet block production.
 */
export async function resumeClock(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_resumeClock", []);
}

/**
 * Get current Surfnet clock info.
 */
export async function getClock(
  connection: Connection,
): Promise<{ slot: number; timestamp: number; epoch: number }> {
  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  const epochInfo = await connection.getEpochInfo();
  return {
    slot,
    timestamp: blockTime ?? 0,
    epoch: epochInfo.epoch,
  };
}

/**
 * Poll until Surfnet reaches a specific slot.
 */
export async function waitForSlot(
  connection: Connection,
  targetSlot: number,
  maxWaitMs: number = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const current = await connection.getSlot();
    if (current >= targetSlot) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for slot ${targetSlot} after ${maxWaitMs}ms`,
  );
}

// ─── Network reset ──────────────────────────────────────────────────────────

/**
 * Reset Surfnet to initial state — clears all accounts and transactions.
 */
export async function resetNetwork(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_resetNetwork", []);
}

// ─── Transaction profiling ──────────────────────────────────────────────────

export interface ProfileResult {
  computeUnits: number;
  accounts: any[];
  logs: string[];
  tag?: string;
}

/**
 * Profile a transaction for CU usage and account changes.
 * Official API: surfnet_getTransactionProfile(signatureOrUuid, config?)
 */
export async function profileTransaction(
  connection: Connection,
  txSignature: string,
  tag?: string,
): Promise<ProfileResult> {
  // Use getTransactionProfile with the signature
  const result = await surfnetRpc(connection, "surfnet_getTransactionProfile", [
    { signature: txSignature },
    { depth: 1 },
  ]);
  if (tag) result.tag = tag;
  return result;
}

/**
 * Get all profiling results for a specific tag.
 * Official API: surfnet_getProfileResultsByTag(tag, config?)
 */
export async function getProfilesByTag(
  connection: Connection,
  tag: string,
): Promise<ProfileResult[]> {
  return await surfnetRpc(connection, "surfnet_getProfileResultsByTag", [
    tag,
    { depth: 1 },
  ]);
}

// ─── Anchor error code → name lookup ─────────────────────────────────────────

/**
 * Surfnet does NOT return program logs for failed TXs via getTransaction(), so
 * we decode the numeric Custom code to a name. This map is DERIVED from the
 * canonical, CI-drift-checked `SIGIL_ERRORS` (tests/helpers/strict-errors.ts, a
 * mirror of sdk/kit/src/testing/errors/names.generated.ts) — never hand-
 * maintained here, so it cannot drift from the on-chain error numbering. The
 * previous hand-written table had drifted (e.g. 6071 mislabeled
 * OrphanPdaWrongOwner; it is PolicyPreviewMismatch).
 */
const SIGIL_ERROR_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SIGIL_ERRORS).map(([name, code]) => [code, name]),
);

/**
 * Extract custom error code from Solana transaction error and resolve to name.
 */
function resolveErrorName(err: any): string {
  const errJson = JSON.stringify(err);
  const match = errJson.match(/"Custom":(\d+)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const name = SIGIL_ERROR_NAMES[code];
    if (name) return `${name} (${code})`;
  }
  return "";
}

// ─── Composed transaction helper ────────────────────────────────────────────

export interface VersionedTxResult {
  signature: string;
  slot: number;
  logs: string[];
}

/**
 * Build, sign, and send a versioned transaction — mirrors litesvm-setup API.
 * Returns the signature and logs.
 *
 * Error handling: Surfnet does not return program logs for failed TXs via
 * getTransaction(). We decode the error code from confirmation.value.err
 * and include the Anchor error name in the thrown error message.
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

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  if (confirmation.value.err) {
    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = txDetails?.meta?.logMessages ?? [];
    const errorName = resolveErrorName(confirmation.value.err);
    throw new Error(
      `Transaction failed: ${errorName} ${JSON.stringify(confirmation.value.err)} Logs: ${logs.join(" ")}`,
    );
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
 * WHY: `initialize_vault` (programs/sigil/src/instructions/initialize_vault.rs:
 * 202-256) captures `Clock::get()?.slot` at handler entry, recomputes the
 * policy-preview digest with that slot at canonical position 14 (PEN-CROSS-2
 * close+reinit replay defense), and `require!`s exact equality with the
 * owner-signed `preview_digest` (else `PolicyPreviewMismatch`, code 6071).
 *
 * LiteSVM freezes the clock at 0 so a digest signed for slot 0 matches. A live
 * Surfnet clock advances (it tracks the devnet datasource), so the slot read by
 * the caller can differ from the slot the tx lands in. This mirrors the
 * production SDK (sdk/kit/src/create-vault.ts:350): read the current slot, sign
 * the digest for it, submit, and on a 6071 mismatch re-read the slot and retry.
 * All other errors propagate immediately (no masking).
 *
 * @param buildIx receives the slot to bind into the digest and returns the
 *                fully-built `initialize_vault` instruction.
 */
export async function sendInitVault(
  env: SurfpoolTestEnv,
  buildIx: (createdAtSlot: number) => Promise<TransactionInstruction>,
  signers: Keypair[] = [],
  maxAttempts: number = 24,
): Promise<VersionedTxResult> {
  // A promptly-submitted tx lands one block after the slot we read (empirically
  // exec == getSlot()+1 in both `clock` and `transaction` block-production
  // modes). We bind to base+1 first; the offset cycle absorbs 0-/2-/3-slot drift
  // (e.g. a slower CI runner) while the datasource clock advances under us.
  const offsets = [1, 2, 0, 3];
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const base = await env.connection.getSlot("confirmed");
    const createdAtSlot = base + offsets[attempt % offsets.length];
    const ix = await buildIx(createdAtSlot);
    try {
      return await sendVersionedTx(env.connection, [ix], env.payer, signers);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // 6071 = PolicyPreviewMismatch: the live clock advanced between getSlot()
      // and execution. Re-read the slot and retry. Any other error is real.
      if (
        msg.includes('"Custom":6071') ||
        msg.includes("PolicyPreviewMismatch")
      ) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `initialize_vault: clock kept advancing past the signed slot after ${maxAttempts} attempts. Last error: ${lastErr}`,
  );
}

/**
 * Standard inline vault init used across the Surfpool suites: the default
 * policy (500 USDC daily cap, 100 USDC max tx, ALLOWLIST mode, no protocols,
 * 30-min timelock, all-hours). Routes through `sendInitVault` so the owner-
 * signed preview digest is bound to the live execution slot (PEN-CROSS-2) with
 * retry — the only correct way to init on a live Surfnet clock. Returns the
 * send result so callers (e.g. CU profiling) can read the signature.
 */
export async function initVaultInline(
  env: SurfpoolTestEnv,
  program: Program<any>,
  vaultId: BN,
  vaultPda: PublicKey,
  policyPda: PublicKey,
  trackerPda: PublicKey,
  overlayPda: PublicKey,
  feeDestination: PublicKey,
): Promise<VersionedTxResult> {
  const dailyCap = new BN(500_000_000);
  const maxTx = new BN(100_000_000);
  return sendInitVault(env, (createdAtSlot) =>
    (program.methods as any)
      .initializeVault(
        vaultId,
        dailyCap,
        maxTx,
        1,
        [MOCK_DEFI_PROGRAM_ID],
        0,
        100,
        new BN(1800),
        [],
        [],
        false, // observeOnly
        0x00ffffff, // operating_hours (all 24h)
        false, // auto_promote_grays
        5, // auto_revoke_threshold
        new BN(0), // stable_balance_floor
        new BN(0), // per_recipient_daily_cap_usd
        false, // cosign_required
        initVaultPreviewDigest({
          dailySpendingCapUsd: dailyCap,
          maxTransactionSizeUsd: maxTx,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [MOCK_DEFI_PROGRAM_ID],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          createdAtSlot,
        }),
      )
      .accounts({
        owner: env.payer.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
}

// ─── PDA derivation (reused from devnet-setup pattern) ──────────────────────

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

// ─── Overlay PDA derivation ──────────────────────────────────────────────────

/**
 * Derive the AgentSpendOverlay PDA for a vault (page index 0).
 */
export function deriveOverlayPda(
  vaultPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
    programId,
  );
  return overlayPda;
}

// ─── Vault setup helper ─────────────────────────────────────────────────────

export interface SetupVaultOpts {
  dailyCap?: BN;
  maxTxSize?: BN;
  vaultFunding?: number;
  agentCapability?: number;
  agentSpendingLimit?: BN;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  developerFeeRate?: number;
  maxSlippageBps?: number;
  owner?: Keypair;
  protocolCaps?: any[];
  skipAgent?: boolean;
  /** Phase 2 Option A: protocol_mode is hard-coded to 1 (ALLOWLIST). Pass the
   * actual protocol pubkeys here. Empty array = no DeFi permitted. */
  protocols?: PublicKey[];
}

export interface VaultSetupResult {
  vaultId: BN;
  agent: Keypair;
  feeDestination: Keypair;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  pendingPolicyPda: PublicKey;
  overlayPda: PublicKey;
  vaultUsdcAta: PublicKey;
  protocolTreasuryAta: PublicKey;
}

const FULL_CAPABILITY = 2;

/**
 * Create a vault with agent, fund it, and return all PDAs and keypairs.
 * Consolidates the 7-step setup pattern used in every Surfpool test suite.
 */
export async function setupVaultWithAgent(
  env: SurfpoolTestEnv,
  program: Program<any>,
  opts: SetupVaultOpts = {},
): Promise<VaultSetupResult> {
  const {
    dailyCap = new BN(500_000_000),
    maxTxSize = new BN(100_000_000),
    vaultFunding = 1_000_000_000,
    agentCapability = FULL_CAPABILITY,
    agentSpendingLimit = new BN(0),
    timelockDuration = new BN(1800), // MIN_TIMELOCK_DURATION: 30 minutes
    allowedDestinations = [],
    developerFeeRate = 0,
    maxSlippageBps = 100,
    owner = env.payer,
    protocolCaps = [],
    skipAgent = false,
  } = opts;

  const vaultId = nextVaultId();
  const agent = await createWallet(env.connection, "agent", 10);
  const feeDestination = await createWallet(env.connection, "feeDest", 2);

  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
  const overlayPda = deriveOverlayPda(pdas.vaultPda, program.programId);

  // Phase 2 Option A: protocol_mode must be 1 (ALLOWLIST). Empty protocols
  // means "no DeFi permitted yet" — callers that need a permissive default
  // pass `opts.protocols = [...]` explicitly.
  //
  // KNOWN: `tsc --noEmit` reports `TS2589: Type instantiation is excessively
  // deep and possibly infinite` on the `.initializeVault(...)` chain below.
  // This is a pre-existing Anchor 0.32.1 type-depth limit (the codec hits the
  // compiler's depth-50 ceiling on the long argument chain). Tracked for v1.1
  // SDK cleanup (Codama-generated client will sidestep this).
  //
  // FIX: alias `program.methods` to an `any`-typed local ONCE and use it for
  // every `.methods.*` builder call in this function. Casting only the
  // initialize_vault chain inline merely shifts the cumulative-depth ceiling
  // onto the next builder call (e.g. register_agent) — the depth budget is
  // per-file, so a single shared `any` alias is the stable fix. Runtime
  // behavior is identical (same methods, same args, same `.rpc()`). Do NOT
  // touch the argument chains themselves.
  const methods = program.methods as any;
  await sendInitVault(
    env,
    (createdAtSlot) =>
      methods
        .initializeVault(
          vaultId,
          dailyCap,
          maxTxSize,
          1,
          opts.protocols ?? [MOCK_DEFI_PROGRAM_ID],
          developerFeeRate,
          maxSlippageBps,
          timelockDuration,
          allowedDestinations,
          protocolCaps,
          false, // observeOnly (Phase 2 TA-19)
          0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
          false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
          5, // auto_revoke_threshold (TA-17 Phase 3 — default)
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
          false, // cosign_required (G6 audit 2026-05-18 — opt-in, default off)
          initVaultPreviewDigest({
            dailySpendingCapUsd: dailyCap,
            maxTransactionSizeUsd: maxTxSize,
            maxSlippageBps: maxSlippageBps,
            protocolMode: 1,
            protocols: opts.protocols ?? [MOCK_DEFI_PROGRAM_ID],
            allowedDestinations: allowedDestinations,
            timelockDuration: timelockDuration,
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
            // PEN-CROSS-2: bind the owner-signed digest to the slot
            // initialize_vault will execute in. LiteSVM froze the clock at 0; a
            // live Surfnet clock advances, so sendInitVault re-reads + retries
            // on a 6071 mismatch (mirrors create-vault.ts:350).
            createdAtSlot,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    owner === env.payer ? [] : [owner],
  );

  if (!skipAgent) {
    // Route through sendVersionedTx (not .rpc()) so a real failure surfaces as
    // {Custom:N} instead of the anchor x web3.js "Unknown action 'undefined'" mask.
    const registerIx = await methods
      .registerAgent(agent.publicKey, agentCapability, agentSpendingLimit)
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        agentSpendOverlay: overlayPda,
      })
      .instruction();
    await sendVersionedTx(
      env.connection,
      [registerIx],
      env.payer,
      owner === env.payer ? [] : [owner],
    );
  }

  const vaultUsdcAta = await fundWithTokens(
    env.connection,
    pdas.vaultPda,
    DEVNET_USDC_MINT,
    vaultFunding,
  );

  const protocolTreasuryAta = await fundWithTokens(
    env.connection,
    PROTOCOL_TREASURY,
    DEVNET_USDC_MINT,
    0,
  );

  return {
    vaultId,
    agent,
    feeDestination,
    vaultPda: pdas.vaultPda,
    policyPda: pdas.policyPda,
    trackerPda: pdas.trackerPda,
    pendingPolicyPda: pdas.pendingPolicyPda,
    overlayPda,
    vaultUsdcAta,
    protocolTreasuryAta,
  };
}

// ─── Error expectation helper ────────────────────────────────────────────────

/**
 * Send a transaction expecting it to fail with a specific error substring.
 * Re-throws AssertionErrors from expect.fail() to prevent false passes.
 */
export async function expectTxError(
  connection: Connection,
  ixs: TransactionInstruction[],
  signer: Keypair,
  errorSubstring: string,
  additionalSigners: Keypair[] = [],
): Promise<void> {
  try {
    await sendVersionedTx(connection, ixs, signer, additionalSigners);
    throw new Error(
      `Expected error containing "${errorSubstring}" but transaction succeeded`,
    );
  } catch (err: any) {
    if (err.message?.startsWith("Expected error containing")) throw err;
    const errStr = err.message || JSON.stringify(err);
    if (errStr.includes(errorSubstring)) return; // Direct string match

    // Surfpool returns numeric codes like {"Custom":6000} instead of "VaultNotActive".
    // Reverse-lookup: if errorSubstring is an error name, check if the numeric code appears.
    const codeEntry = Object.entries(SIGIL_ERROR_NAMES).find(
      ([, name]) => name === errorSubstring,
    );
    if (codeEntry) {
      const code = codeEntry[0];
      if (errStr.includes(code) || errStr.includes(`"Custom":${code}`)) return;
    }

    throw new Error(
      `Expected "${errorSubstring}" but got: ${errStr.slice(0, 200)}`,
    );
  }
}

// ─── Collision-free vault ID generator (prefix 50_xxx) ──────────────────────

let vaultIdCounter = 0;

/**
 * Returns a unique vault ID in the 50_xxx_xxx range to avoid collisions
 * with LiteSVM tests (1-300) and devnet tests (1-8 prefixes).
 */
export function nextVaultId(): BN {
  return new BN(50_000_000 + (Date.now() % 1_000_000) + vaultIdCounter++);
}
