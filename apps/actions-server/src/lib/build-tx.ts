import type {
  VersionedTransaction,
  PublicKey as PublicKeyType,
} from "@solana/web3.js";
import type { BN as BNType } from "@coral-xyz/anchor";
import { buildParamsFromTemplate, type TemplateName } from "./templates";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export interface BuildProvisionTxParams {
  owner: PublicKeyType;
  agentPubkey: PublicKeyType;
  template: TemplateName;
  dailyCap?: number;
  vaultId?: number;
}

/**
 * Build an unsigned VersionedTransaction that atomically:
 * 1. Sets compute budget
 * 2. Initializes vault + policy + tracker
 * 3. Registers agent
 *
 * Heavy dependencies (@solana/web3.js, @coral-xyz/anchor, @phalnx/sdk)
 * are loaded dynamically to avoid slow cold starts on serverless.
 */
export async function buildProvisionTransaction(
  params: BuildProvisionTxParams,
): Promise<{ transaction: VersionedTransaction; vaultAddress: string }> {
  const {
    Connection,
    PublicKey,
    TransactionMessage,
    VersionedTransaction: VTx,
    ComputeBudgetProgram,
  } = await import("@solana/web3.js");
  const { BN, Program, AnchorProvider, Wallet } =
    await import("@coral-xyz/anchor");
  const {
    PHALNX_PROGRAM_ID,
    IDL,
    buildInitializeVault,
    buildRegisterAgent,
    getVaultPDA,
    CU_VAULT_CREATION,
    getEstimator,
  } = await import("@phalnx/sdk");

  const PROGRAM_ID = process.env.PHALNX_PROGRAM_ID
    ? new PublicKey(process.env.PHALNX_PROGRAM_ID)
    : PHALNX_PROGRAM_ID;

  const connection = new Connection(RPC_URL, "confirmed");

  // Dummy wallet — we never sign, only build instructions
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any[]) => txs,
  } as unknown as InstanceType<typeof Wallet>;

  const provider = new AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  const program = new Program(IDL as any, provider) as any;

  const vaultId = new BN(params.vaultId ?? 0);
  const vaultParams = await buildParamsFromTemplate(
    params.template,
    vaultId,
    params.owner, // fee destination = owner
    params.dailyCap ? { dailyCap: params.dailyCap } : undefined,
  );

  // Derive vault PDA
  const [vaultPDA] = getVaultPDA(params.owner, vaultId, program.programId);

  // Build instructions
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: CU_VAULT_CREATION,
  });
  const initIx = await buildInitializeVault(
    program,
    params.owner,
    vaultParams,
  ).instruction();
  const FULL_PERMISSIONS = new BN(2097151); // 21 bits — all action types
  const registerIx = await buildRegisterAgent(
    program,
    params.owner,
    vaultPDA,
    params.agentPubkey,
    FULL_PERMISSIONS,
  ).instruction();

  // Priority fee for reliable tx landing
  let priorityFeeIx;
  try {
    const estimator = getEstimator(connection);
    priorityFeeIx = await estimator.buildPriorityFeeIx("high");
  } catch {
    // Proceed without priority fee if estimation fails
  }

  // Build VersionedTransaction
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const ixs = priorityFeeIx
    ? [computeIx, priorityFeeIx, initIx, registerIx]
    : [computeIx, initIx, registerIx];

  const messageV0 = new TransactionMessage({
    payerKey: params.owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const transaction = new VTx(messageV0);

  return {
    transaction,
    vaultAddress: vaultPDA.toBase58(),
  };
}
