/**
 * agent_transfer wrapper — direct stablecoin payout from a vault.
 *
 * `agent_transfer` is a STANDALONE Sigil instruction, NOT a `seal()` sandwich.
 * It moves stablecoin (USDC/USDT) out of the vault to an owner-allowlisted
 * destination wallet, enforcing the same caps the spend path does (single-tx
 * size, rolling-24h global + per-agent, per-recipient, stable-balance floor)
 * and collecting the protocol + developer fees upfront.
 *
 * This module mirrors `seal()`'s account-resolution ergonomics (see
 * `seal.ts` ~800-895): it derives every token account the on-chain handler
 * needs, fills `expected_policy_version` from the LIVE policy (closing the
 * TOCTOU window the on-chain `PolicyVersionMismatch` guards), and appends the
 * vault's OTHER stablecoin ATA as a remaining account when the
 * `stable_balance_floor` (TA-12) invariant is armed so the on-chain floor sum
 * can see both mints.
 *
 * The PDA accounts (policy, tracker, audit_log_success, slot_hashes sysvar)
 * are auto-derived by the generated `getAgentTransferInstructionAsync`
 * builder; only `agent_spend_overlay` and the token accounts are supplied
 * explicitly.
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "./kit-adapter.js";
import { AccountRole } from "./kit-adapter.js";
import { getAgentTransferInstructionAsync } from "./generated/instructions/agentTransfer.js";
import { getAgentOverlayPDA } from "./resolve-accounts.js";
import { deriveAta } from "./tokens.js";
import { VaultStatus } from "./generated/types/vaultStatus.js";
import {
  resolveVaultState,
  type ResolvedVaultState,
} from "./state-resolver.js";
import {
  type Network,
  normalizeNetwork,
  isStablecoinMint,
  PROTOCOL_TREASURY,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
} from "./types.js";
import { SigilSdkDomainError } from "./errors/sdk.js";
import {
  SIGIL_ERROR__SDK__VAULT_INACTIVE,
  SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
  SIGIL_ERROR__SDK__AGENT_PAUSED,
  SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
  SIGIL_ERROR__SDK__INVALID_AMOUNT,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
} from "./errors/codes.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BuildAgentTransferOptions {
  /** On-chain vault PDA address. */
  vault: Address;
  /** Agent signer — must be a registered OPERATOR in the vault. */
  agent: TransactionSigner;
  /**
   * Destination WALLET address (the recipient owner, NOT its ATA). Must appear
   * in `policy.allowedDestinations`. The wrapper derives the destination's ATA
   * for `tokenMint` internally.
   */
  destination: Address;
  /**
   * Amount in the token's native base units. Stablecoins use 6 decimals, so
   * USD == base units / 10^6 — e.g. $100 USDC = `100_000_000n`. Must be > 0.
   */
  amount: bigint;
  /** Stablecoin mint to transfer (USDC or USDT on the target network). */
  tokenMint: Address;
  /** Network identifier. Accepts `"devnet"` or `"mainnet"`. */
  network: "devnet" | "mainnet";
  /**
   * Pre-resolved vault state. Skips the RPC fetch when supplied (mirrors
   * `SealParams.cachedState`). The live `policy_version` is read from here.
   */
  cachedState?: ResolvedVaultState;
}

// ─── buildAgentTransfer ───────────────────────────────────────────────────────

/**
 * Resolve accounts + compose a single `agent_transfer` instruction.
 *
 * Throws (fail-fast, before any tx is built) on the conditions the on-chain
 * handler would also reject: inactive vault, unregistered/paused/zero-capability
 * agent, non-positive amount, non-stablecoin mint, or a destination that is not
 * in the policy's allowlist. These are convenience pre-flight checks — the
 * on-chain instruction remains the sole security boundary.
 */
export async function buildAgentTransfer(
  rpc: Rpc<SolanaRpcApi>,
  opts: BuildAgentTransferOptions,
): Promise<Instruction> {
  const net: Network = normalizeNetwork(opts.network);

  // 1. Amount must be positive (on-chain: TransactionTooLarge on amount == 0).
  if (opts.amount <= 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `agent_transfer amount must be > 0, got ${opts.amount}. ` +
        `Amounts are stablecoin base units (6 decimals): $100 = 100_000_000n.`,
      { context: { received: opts.amount.toString() } },
    );
  }

  // 2. Stablecoin-only (on-chain: UnsupportedToken).
  if (!isStablecoinMint(opts.tokenMint, net)) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `agent_transfer only moves stablecoins (USDC/USDT). Mint ${opts.tokenMint} ` +
        `is not a recognized stablecoin on ${opts.network}.`,
      { context: { field: "tokenMint", received: opts.tokenMint } },
    );
  }

  // 3. Resolve LIVE vault state (or use the supplied cache). expected_policy_version
  //    is read from here so the caller never has to thread it — closes the
  //    on-chain PolicyVersionMismatch TOCTOU window.
  const state =
    opts.cachedState ??
    (await resolveVaultState(
      rpc,
      opts.vault,
      opts.agent.address,
      undefined,
      net,
    ));

  // 4. Vault must be active.
  if (state.vault.status !== VaultStatus.Active) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__VAULT_INACTIVE,
      `Vault is not active (status: ${VaultStatus[state.vault.status] ?? state.vault.status}).`,
      {
        context: {
          vault: opts.vault,
          status: String(VaultStatus[state.vault.status] ?? state.vault.status),
        },
      },
    );
  }

  // 5. Agent must be registered, not paused, and hold a non-zero capability.
  //    (On-chain `agent_transfer` additionally requires OPERATOR — capability 2.)
  const agentEntry = state.vault.agents.find(
    (a) => a.pubkey === opts.agent.address,
  );
  if (!agentEntry) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_NOT_REGISTERED,
      `Agent ${opts.agent.address} is not registered in vault ${opts.vault}.`,
      { context: { vault: opts.vault, agent: opts.agent.address } },
    );
  }
  if (agentEntry.paused) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_PAUSED,
      `Agent ${opts.agent.address} is paused in vault ${opts.vault}.`,
      { context: { vault: opts.vault, agent: opts.agent.address } },
    );
  }
  if (agentEntry.capability === 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__AGENT_ZERO_CAPABILITY,
      `Agent ${opts.agent.address} has zero capability in vault ${opts.vault}. ` +
        `agent_transfer requires OPERATOR.`,
      { context: { vault: opts.vault, agent: opts.agent.address } },
    );
  }

  // 6. Destination allowlist (on-chain: DestinationNotAllowed). Only the
  //    RESTRICTED mode (0) exists on-chain — OPEN_WITH_CAP was deleted, and
  //    `is_destination_allowed` fails closed for any other mode. Mirror that.
  if (state.policy.destinationMode !== 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `Vault policy destination_mode is ${state.policy.destinationMode}; only ` +
        `RESTRICTED (0, allowlist) is supported on-chain. Transfers will revert.`,
      {
        context: {
          field: "destinationMode",
          received: state.policy.destinationMode,
        },
      },
    );
  }
  if (!state.policy.allowedDestinations.includes(opts.destination)) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `Destination ${opts.destination} is not in the vault's allowed destinations. ` +
        `The owner must allowlist it before the agent can transfer to it.`,
      { context: { field: "destination", received: opts.destination } },
    );
  }

  // 7. Derive token accounts (pure crypto, parallel — mirrors seal.ts).
  //    - vaultTokenAccount: the vault's ATA for the source mint (debited).
  //    - destinationTokenAccount: the recipient wallet's ATA for the mint.
  //    - protocolTreasuryTokenAccount: always required — the upfront protocol
  //      fee is ceil(amount * rate) and is non-zero for any amount > 0.
  //    - feeDestinationTokenAccount: only when developer_fee_rate > 0.
  const developerFeeRate = state.policy.developerFeeRate;
  const [
    vaultTokenAccount,
    destinationTokenAccount,
    protocolTreasuryTokenAccount,
    feeDestinationTokenAccount,
    [agentSpendOverlay],
  ] = await Promise.all([
    deriveAta(opts.vault, opts.tokenMint),
    deriveAta(opts.destination, opts.tokenMint),
    deriveAta(PROTOCOL_TREASURY, opts.tokenMint),
    developerFeeRate > 0
      ? deriveAta(state.vault.feeDestination, opts.tokenMint)
      : Promise.resolve(undefined),
    getAgentOverlayPDA(opts.vault, 0),
  ]);

  // 8. Compose the instruction. policy/tracker/audit_log_success/slot_hashes
  //    sysvar are auto-derived by the async builder; expected_policy_version is
  //    filled from the live policy.
  const ix = await getAgentTransferInstructionAsync({
    agent: opts.agent,
    vault: opts.vault,
    agentSpendOverlay,
    vaultTokenAccount,
    tokenMintAccount: opts.tokenMint,
    destinationTokenAccount,
    protocolTreasuryTokenAccount,
    feeDestinationTokenAccount,
    amount: opts.amount,
    expectedPolicyVersion: state.policy.policyVersion ?? 0n,
  });

  // 9. TA-12 stable_balance_floor: when armed, the on-chain handler sums the
  //    vault's combined stablecoin balance. The SOURCE ATA is auto-counted, but
  //    the OTHER stablecoin's vault ATA must be supplied via remaining_accounts
  //    or the floor under-counts and the transfer falsely reverts. Append it
  //    unconditionally when the floor is armed (a non-existent ATA is harmless —
  //    the on-chain walk skips any non-token-program account).
  if (state.policy.stableBalanceFloor > 0n) {
    const usdcMint =
      net === "mainnet-beta" ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
    const usdtMint =
      net === "mainnet-beta" ? USDT_MINT_MAINNET : USDT_MINT_DEVNET;
    const otherMint = opts.tokenMint === usdcMint ? usdtMint : usdcMint;
    const otherStableAta = await deriveAta(opts.vault, otherMint);
    return {
      ...ix,
      accounts: [
        ...ix.accounts,
        { address: otherStableAta, role: AccountRole.READONLY },
      ],
    };
  }

  return ix;
}
