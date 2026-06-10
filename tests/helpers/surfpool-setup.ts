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
  SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
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

// ─── OPERATOR-grant seating (F-Q6 timelock path) ────────────────────────────

/** CAPABILITY_OPERATOR (state/vault.rs) — the full-access agent capability. */
export const CAPABILITY_OPERATOR = 2;

/**
 * SINGLE_KEY_OPERATOR_DELAY_FLOOR (programs/sigil/src/utils/operator_grant.rs).
 * A single-key vault's OPERATOR grant is floored at this delay (the forced
 * 2nd authorization factor). Kept in sync with the Rust constant; the helper
 * advances `floor + 1`s past it.
 */
export const SINGLE_KEY_OPERATOR_DELAY_FLOOR = 600;

/**
 * Seat an OPERATOR-class agent on a SINGLE-KEY vault via the timelocked
 * queue → advance → apply path — the Surfpool analogue of the LiteSVM
 * `tests/helpers/register-operator-agent.ts`.
 *
 * After F-Q6 (register_agent.rs:140), `register_agent` REJECTS an instant
 * OPERATOR grant on a single-key vault (`ErrOperatorGrantRequiresTimelock`,
 * 6107). Test setups that previously did an instant `registerAgent(OPERATOR)`
 * swap to this helper, which:
 *   1. `queue_agent_grant(agent, OPERATOR, limit)` — stores a pending grant
 *      with `min_delay_seconds = effective_delay` (600s for a single-key vault
 *      at the default 0 configured delay).
 *   2. BACKDATE the pending grant via `surfnet_setAccount` instead of
 *      `timeTravel`. We rewrite `queued_at` (i64 unix seconds) and
 *      `queued_at_slot` (u64) INTO THE PAST so the apply passes at the
 *      NATURAL current clock — no clock jump at all. `apply_agent_grant`
 *      gates (single-key, cosign_required=false) are: (a) the slot-freshness
 *      `clock.slot.checked_sub(queued_at_slot)` (apply_agent_grant.rs:144-147),
 *      which UNDERFLOWS to `Overflow` (6020) if `queued_at_slot > clock.slot`,
 *      and must stay `< MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000`; and
 *      (b) the timelock `unix_timestamp - queued_at >= min_delay_seconds`
 *      (apply_agent_grant.rs:157-164). Backdating `queued_at` to
 *      `now - (min_delay_seconds + 5)` and `queued_at_slot` to `slot - 10`
 *      satisfies BOTH at the live clock (slot_delta ≈ 10, elapsed ≈
 *      min_delay+5). The pending content digest is sealed over those two
 *      fields (state/pending_agent_grant.rs:174-194 canonical encoding), so we
 *      RECOMPUTE it over the backdated values and re-serialize the account with
 *      the Anchor coder before writing it back.
 *
 *      WHY backdate instead of timeTravel: on the CI surfnet (linux binary
 *      forking LIVE devnet) the slot is NOT monotonic across `timeTravel` — by
 *      apply time `clock.slot < pending.queued_at_slot`, so the :147
 *      `checked_sub` underflows (Overflow, 6020). This is platform-specific
 *      (NOT reproducible on darwin), i.e. a surfnet clock bug, not our code.
 *      Backdating runs the apply at the natural clock and avoids the jump
 *      entirely. This SIMULATES elapsed time for setup (same intent as
 *      litesvm's `advanceTime`); it weakens NO on-chain assertion.
 *   3. `apply_agent_grant()` — pushes the agent into `vault.agents`.
 *
 * Both ix are built via `.instruction()` and sent through `sendVersionedTx`
 * (NOT `.rpc()`) so a real revert surfaces as `{Custom:N}` instead of the
 * anchor x web3.js "Unknown action 'undefined'" mask. Every PDA
 * (policy / pending_agent_grant / agent_spend overlay / audit_success) is
 * derived locally from `vault`, so callers pass only the high-level context.
 *
 * Cosign/multisig vaults seat an OPERATOR INSTANTLY — call `registerAgent`
 * directly for those. This helper is specifically the single-key substitute.
 * Callers asserting a REJECT must NOT use this helper (it propagates the revert).
 *
 * @param signers Extra signers when `owner` is not the provider wallet
 *                (the provider/payer auto-signs as fee payer). Pass the owner
 *                Keypair here in that case (mirrors the inline register block's
 *                `owner === env.payer ? [] : [owner]`).
 */
export async function seatOperatorAgent(
  env: SurfpoolTestEnv,
  program: Program<any>,
  owner: PublicKey,
  vault: PublicKey,
  agent: PublicKey,
  spendingLimitUsd: BN | number = 0,
  signers: Keypair[] = [],
): Promise<void> {
  const spendingLimit = new BN(spendingLimitUsd);
  const programId = program.programId;

  // Every PDA is derived from the vault PDA directly. policy / pending /
  // audit_success are all seeded by `vault` (not owner+vault_id), so the
  // caller need not pass vault_id.
  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vault.toBuffer()],
    programId,
  );
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_agent_grant"), vault.toBuffer()],
    programId,
  );
  const overlay = deriveOverlayPda(vault, programId);
  const [auditSuccess] = PublicKey.findProgramAddressSync(
    [Buffer.from("audit_success"), vault.toBuffer()],
    programId,
  );

  const methods = program.methods as any;

  // 1. Queue the OPERATOR grant.
  const queueIx = await methods
    .queueAgentGrant(agent, CAPABILITY_OPERATOR, spendingLimit)
    .accounts({
      owner,
      vault,
      policy,
      pending,
      auditLogSuccess: auditSuccess,
      slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await sendVersionedTx(env.connection, [queueIx], env.payer, signers);

  // 2. BACKDATE the pending grant via surfnet_setAccount instead of timeTravel.
  //    On the CI surfnet (linux binary forking live devnet) the slot is NOT
  //    monotonic across `timeTravel`, so by apply time
  //    `clock.slot < pending.queued_at_slot` and apply_agent_grant.rs:147
  //    `clock.slot.checked_sub(queued_at_slot)` UNDERFLOWS (Overflow, 6020).
  //    Rewriting `queued_at` / `queued_at_slot` into the PAST lets the apply
  //    pass at the natural current clock with no jump. This SIMULATES elapsed
  //    time for setup (same intent as litesvm's advanceTime) — it weakens no
  //    on-chain assertion.
  //
  //    The pending content digest (state/pending_agent_grant.rs:174-194) is a
  //    SHA-256 over the canonical 97-byte encoding that INCLUDES queued_at and
  //    queued_at_slot, so we recompute it over the backdated values and
  //    re-serialize the whole account (with discriminator) via the Anchor
  //    coder before writing it back. All other fields are preserved verbatim.
  const pendingAccount = await (program.account as any).pendingAgentGrant.fetch(
    pending,
  );
  const { slot, timestamp } = await getClock(env.connection);

  // queued_at: i64 unix seconds. Backdated so elapsed at apply ≈ minDelay + 5
  // (≥ min_delay_seconds, clearing the timelock at apply_agent_grant.rs:161).
  // queued_at_slot: u64. Backdated so slot_delta at apply ≈ 10 (≥ 0, no
  // underflow at :147, and ≪ MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000).
  const backdatedQueuedAt = new BN(
    timestamp - (Number(pendingAccount.minDelaySeconds) + 5),
  );
  const backdatedQueuedAtSlot = new BN(slot - 10);

  // Recompute pending_content_digest over the canonical encoding (97 bytes):
  //   vault(32) ++ agent(32) ++ capability(u8) ++ spending_limit_usd(u64 LE) ++
  //   queued_at(i64 LE) ++ min_delay_seconds(u64 LE) ++ queued_at_slot(u64 LE).
  // Mirrors canonical_bytes_of_pending_agent_grant EXACTLY. Timestamps and
  // slots are positive, so BN.toArrayLike(le, 8) yields the correct i64/u64 LE
  // bytes (8-byte width pinned below).
  const u64le = (v: BN): Buffer => {
    const b = v.toArrayLike(Buffer, "le", 8);
    if (b.length !== 8) {
      throw new Error(`expected 8-byte LE encoding, got ${b.length}`);
    }
    return b;
  };
  const canonical = Buffer.concat([
    pendingAccount.vault.toBuffer(), // 32
    pendingAccount.agent.toBuffer(), // 32
    Buffer.from([pendingAccount.capability & 0xff]), // 1 (u8)
    u64le(new BN(pendingAccount.spendingLimitUsd)), // 8 (u64 LE)
    u64le(backdatedQueuedAt), // 8 (i64 LE, positive)
    u64le(new BN(pendingAccount.minDelaySeconds)), // 8 (u64 LE)
    u64le(backdatedQueuedAtSlot), // 8 (u64 LE)
  ]);
  if (canonical.length !== 97) {
    throw new Error(
      `pending canonical encoding must be 97 bytes, got ${canonical.length}`,
    );
  }
  const newDigest = crypto.createHash("sha256").update(canonical).digest();

  // Re-serialize the account WITH its 8-byte discriminator. Keep every other
  // field unchanged; only queued_at / queued_at_slot / pending_content_digest
  // move. The Program-attached coder uses the camelCase account key and fields.
  const modified = {
    ...pendingAccount,
    queuedAt: backdatedQueuedAt,
    queuedAtSlot: backdatedQueuedAtSlot,
    pendingContentDigest: Array.from(newDigest),
  };
  const data: Buffer = await program.coder.accounts.encode(
    "pendingAgentGrant",
    modified,
  );

  // Preserve the owning program + lamports (rent-exempt) — only the data moves.
  const existing = await env.connection.getAccountInfo(pending);
  if (!existing) {
    throw new Error(
      `pending_agent_grant ${pending.toString()} not found after queue`,
    );
  }
  await surfnetRpc(env.connection, "surfnet_setAccount", [
    pending.toString(),
    {
      data: data.toString("hex"),
      owner: existing.owner.toString(),
      lamports: existing.lamports,
    },
  ]);

  // 3. Apply the grant.
  const applyIx = await methods
    .applyAgentGrant()
    .accounts({
      owner,
      vault,
      policy,
      pending,
      agentSpendOverlay: overlay,
      auditLogSuccess: auditSuccess,
      slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
    })
    .instruction();
  await sendVersionedTx(env.connection, [applyIx], env.payer, signers);
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
    const agentSigners = owner === env.payer ? [] : [owner];
    if (agentCapability >= CAPABILITY_OPERATOR) {
      // F-Q6: this vault is single-key (cosign_required=false above), so an
      // OPERATOR (>=2) grant cannot be seated instantly via register_agent
      // (ErrOperatorGrantRequiresTimelock, 6107). Seat it through the
      // queue → time-travel → apply timelock path instead.
      await seatOperatorAgent(
        env,
        program,
        owner.publicKey,
        pdas.vaultPda,
        agent.publicKey,
        agentSpendingLimit,
        agentSigners,
      );
    } else {
      // Observer (1) / Disabled (0) are instant-eligible — direct register.
      // Route through sendVersionedTx (not .rpc()) so a real failure surfaces
      // as {Custom:N} instead of the anchor x web3.js "Unknown action
      // 'undefined'" mask.
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
        agentSigners,
      );
    }
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
