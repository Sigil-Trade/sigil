/**
 * F-Q6 (2026-06-02) — seat an OPERATOR-class agent on a SINGLE-KEY vault via
 * the timelocked queue→advance→apply path.
 *
 * After F-Q6, `register_agent` REJECTS an instant OPERATOR grant on a
 * single-key vault (`ErrOperatorGrantRequiresTimelock`, 6107) — the forced
 * delay (>= `SINGLE_KEY_OPERATOR_DELAY_FLOOR` = 600s) is the missing 2nd
 * authorization factor. Test setups that previously did an instant
 * `registerAgent(OPERATOR)` swap to this one-line helper, which:
 *   1. `queue_agent_grant(agent, OPERATOR, limit)` — stores a pending grant
 *      with `min_delay_seconds = effective_delay` (600s for a single-key
 *      vault at the default 0 configured delay).
 *   2. `advanceTime(svm, delay + 1)` — past the timelock (slot is unchanged,
 *      so the F-10 freshness ceiling is trivially satisfied: slot_delta = 0).
 *   3. `apply_agent_grant()` — pushes the agent into `vault.agents`.
 *
 * For COSIGN-bound or MULTISIG vaults an OPERATOR grant is INSTANT — call
 * `registerAgent` directly (cosign vaults pass the BOUND cosigner inline).
 * This helper is specifically the single-key (forced-delay) substitute.
 *
 * PDAs (policy / pending_agent_grant / agent_spend overlay / audit_success)
 * are derived from `vault` so callers only pass the high-level context — the
 * same ergonomics as the inline `registerAgent` call it replaces.
 */
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import BN from "bn.js";
import { Sigil } from "../../target/types/sigil";
import { LiteSVM, advanceTime } from "./litesvm-setup";

/** CAPABILITY_OPERATOR (state/vault.rs) — the full-access agent capability. */
export const CAPABILITY_OPERATOR = 2;

/**
 * SINGLE_KEY_OPERATOR_DELAY_FLOOR (programs/sigil/src/utils/operator_grant.rs).
 * A single-key vault's OPERATOR grant is floored at this delay. Kept in sync
 * with the Rust constant; the helper advances `floor + 1`s past it.
 */
export const SINGLE_KEY_OPERATOR_DELAY_FLOOR = 600;

export interface RegisterOperatorAgentParams {
  program: Program<Sigil>;
  svm: LiteSVM;
  /** The vault owner (must sign queue + apply). */
  owner: PublicKey;
  /** The vault PDA. */
  vault: PublicKey;
  /** The agent pubkey to grant OPERATOR. */
  agent: PublicKey;
  /** Per-agent rolling-24h spend limit (USDC face value, 6 decimals). Default 0. */
  spendingLimitUsd?: BN | number;
  /**
   * Owner-configured `operator_grant_delay_seconds` for this vault (default 0).
   * The helper advances `max(this, 600) + 1`s so the apply always clears the
   * effective single-key delay.
   */
  configuredDelaySeconds?: number;
  /**
   * Extra signers when `owner` is not the Anchor provider wallet (the provider
   * auto-signs as fee payer + wallet). Pass the owner Keypair here in that case.
   */
  signers?: Keypair[];
}

/**
 * Queue → advance → apply an OPERATOR grant on a single-key vault. Resolves
 * once the agent is live in `vault.agents`. Throws (propagates the on-chain
 * error) if any step reverts — callers asserting a REJECT should NOT use this
 * helper; they should call the individual ix directly.
 */
export async function registerOperatorAgent(
  params: RegisterOperatorAgentParams,
): Promise<void> {
  const { program, svm, owner, vault, agent } = params;
  const spendingLimit = new BN(params.spendingLimitUsd ?? 0);
  const programId = program.programId;

  const [policy] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vault.toBuffer()],
    programId,
  );
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_agent_grant"), vault.toBuffer()],
    programId,
  );
  const [overlay] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
    programId,
  );
  const [auditSuccess] = PublicKey.findProgramAddressSync(
    [Buffer.from("audit_success"), vault.toBuffer()],
    programId,
  );

  const extraSigners = params.signers ?? [];

  // 1. Queue the OPERATOR grant.
  let queue = program.methods
    .queueAgentGrant(agent, CAPABILITY_OPERATOR, spendingLimit)
    .accounts({
      owner,
      vault,
      policy,
      pending,
      auditLogSuccess: auditSuccess,
      slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      systemProgram: SystemProgram.programId,
    } as any);
  if (extraSigners.length) queue = queue.signers(extraSigners);
  await queue.rpc();

  // 2. Advance past the effective single-key delay (floor 600s + margin).
  const effectiveDelay = Math.max(
    params.configuredDelaySeconds ?? 0,
    SINGLE_KEY_OPERATOR_DELAY_FLOOR,
  );
  advanceTime(svm, effectiveDelay + 1);

  // 3. Apply the grant.
  let apply = program.methods
    .applyAgentGrant()
    .accounts({
      owner,
      vault,
      policy,
      pending,
      agentSpendOverlay: overlay,
      auditLogSuccess: auditSuccess,
      slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
    } as any);
  if (extraSigners.length) apply = apply.signers(extraSigners);
  await apply.rpc();
}
