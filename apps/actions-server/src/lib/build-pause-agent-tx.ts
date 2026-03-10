import type {
  VersionedTransaction,
  PublicKey as PublicKeyType,
} from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export interface BuildPauseAgentTxParams {
  owner: PublicKeyType;
  agentToPause: PublicKeyType;
  vaultId: number;
}

export async function buildPauseAgentTransaction(
  params: BuildPauseAgentTxParams,
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
  const { IDL, buildPauseAgent, getVaultPDA, CU_OWNER_ACTION, getEstimator } =
    await import("@phalnx/sdk");

  const connection = new Connection(RPC_URL, "confirmed");

  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (tx: any) => tx,
    signAllTransactions: async (txs: any[]) => txs,
  } as unknown as InstanceType<typeof Wallet>;

  const provider = new AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  const program = new Program(IDL as any, provider) as any;

  const vaultId = new BN(params.vaultId);
  const [vaultPDA] = getVaultPDA(params.owner, vaultId, program.programId);

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: CU_OWNER_ACTION,
  });
  const pauseIx = await buildPauseAgent(
    program,
    params.owner,
    vaultPDA,
    params.agentToPause,
  ).instruction();

  let priorityFeeIx;
  try {
    const estimator = getEstimator(connection);
    priorityFeeIx = await estimator.buildPriorityFeeIx("high");
  } catch {
    // Proceed without priority fee if estimation fails
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const ixs = priorityFeeIx
    ? [computeIx, priorityFeeIx, pauseIx]
    : [computeIx, pauseIx];

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
