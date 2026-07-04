/**
 * Kit-native PDA resolution for Sigil accounts.
 *
 * Uses Kit's `getProgramDerivedAddress()` and `getAddressEncoder()` for
 * seed encoding. All 9 PDA types are derivable.
 */

import type { Address, ReadonlyUint8Array } from "./kit-adapter.js";
import { getAddressEncoder, getProgramDerivedAddress } from "./kit-adapter.js";
import { SIGIL_PROGRAM_ADDRESS } from "./generated/programs/sigil.js";

/**
 * Minimal shape consumed by {@link getVaultPdaFromState}. The full on-chain
 * `AgentVault` account (see `state/vault.rs`) carries many fields; only the
 * two seed inputs are required to rebuild the PDA, so callers may pass any
 * object that exposes them (typically the result of `fetchAgentVault().data`
 * or a `ResolvedVaultState`).
 */
export interface VaultPdaSeedSource {
  /**
   * Phase 8 LBL-01 — the IMMUTABLE seed-key written exactly once in
   * `initialize_vault`. Survives ownership transfer; reads cleanly from
   * on-chain `AgentVault.vault_authority`.
   */
  vaultAuthority: Address;
  /** The same `vault_id` (u64) supplied to `initialize_vault`. */
  vaultId: bigint;
}

// ─── PDA Derivation ──────────────────────────────────────────────────────────

const encoder = getAddressEncoder();
const textEncoder = new TextEncoder();

type Seed = ReadonlyUint8Array | Uint8Array;

function seedString(s: string): Seed {
  return textEncoder.encode(s);
}

function seedAddress(addr: Address): Seed {
  return encoder.encode(addr);
}

function seedU64Le(value: bigint): Seed {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, value, true); // little-endian
  return buf;
}

function seedU8(value: number): Seed {
  return new Uint8Array([value]);
}

/**
 * Derive the AgentVault PDA from its on-chain seeds.
 *
 * **Important — post Phase 8 LBL-01:** the on-chain seed is
 * `vault.vault_authority`, not the current `vault.owner`. The two are
 * IDENTICAL at `initialize_vault` time (the handler writes
 * `vault.vault_authority = owner.key()`), so at vault creation a caller
 * may legitimately pass the initial owner here. After an
 * `accept_ownership_transfer` the two diverge: `vault.owner` becomes the
 * new owner while `vault.vault_authority` stays pinned to the original
 * owner — and the on-chain PDA address is unchanged.
 *
 * If you are deriving a PDA for a vault that has (or might have) been
 * ownership-transferred, prefer {@link getVaultPdaFromState} which reads
 * `vault_authority` directly from on-chain state. Passing the current
 * `owner` here for a transferred vault produces the WRONG address and
 * silently returns a PDA that does not exist on-chain.
 *
 * @param vaultAuthority — the immutable seed-key. At `initialize_vault`
 *   time this is the same as `owner`; thereafter callers must read it
 *   from `AgentVault.vault_authority`.
 * @param vaultId — the same `u64` passed to `initialize_vault`.
 * @param programAddress — defaults to the canonical Sigil program id.
 *
 * @deprecated NH-4 close (Bucket 2 re-audit 2026-05-21): the parameter
 *   was renamed `owner → vaultAuthority` in 0.16.0 to make the LBL-01
 *   contract explicit at the type level. Direct callers that historically
 *   passed `vault.owner` will now silently derive the WRONG PDA for any
 *   ownership-transferred vault. Use {@link getVaultPdaFromState} which
 *   takes a `{ vaultAuthority, vaultId }` shape — the field name forces
 *   the caller to read the immutable seed from on-chain state rather
 *   than assume `owner == vault_authority`. This function stays for
 *   pre-LBL-01 backward compatibility (init-time call sites where the
 *   two are equal by construction) and will be removed in v0.18.
 */
export async function getVaultPDA(
  vaultAuthority: Address,
  vaultId: bigint,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      seedString("vault"),
      seedAddress(vaultAuthority),
      seedU64Le(vaultId),
    ],
  });
  return [pda, bump];
}

/**
 * Derive the AgentVault PDA from on-chain state.
 *
 * **Use this AFTER an ownership transfer.** Reads `vault.vault_authority`
 * (the immutable Phase 8 LBL-01 seed-key) instead of the current
 * `vault.owner`, which would resolve to the wrong PDA once
 * `accept_ownership_transfer` has run.
 *
 * Equivalent to calling `getVaultPDA(vault.vaultAuthority, vault.vaultId)`,
 * but the dedicated name documents the intent at the call site.
 */
export async function getVaultPdaFromState(
  vault: VaultPdaSeedSource,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  return getVaultPDA(vault.vaultAuthority, vault.vaultId, programAddress);
}

export async function getPolicyPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("policy"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getTrackerPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("tracker"), seedAddress(vault)],
  });
  return [pda, bump];
}

export async function getSessionPDA(
  vault: Address,
  agent: Address,
  tokenMint: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      seedString("session"),
      seedAddress(vault),
      seedAddress(agent),
      seedAddress(tokenMint),
    ],
  });
  return [pda, bump];
}

export async function getPendingPolicyPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("pending_policy"), seedAddress(vault)],
  });
  return [pda, bump];
}

/**
 * Derive the PDA for `PendingAgentGrant` at `[b"pending_agent_grant", vault]`.
 * Written by `queue_agent_grant` (the F-Q6 queued OPERATOR-seat path) and
 * closed by `apply_agent_grant` / `cancel_agent_grant`. One in-flight grant
 * per vault (the `init` account collides on a duplicate queue).
 */
export async function getPendingAgentGrantPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("pending_agent_grant"), seedAddress(vault)],
  });
  return [pda, bump];
}

// getEscrowPDA REMOVED in v2 revamp Stage 1 (escrow feature deleted).

export async function getAgentOverlayPDA(
  vault: Address,
  shardIndex: number = 0,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("agent_spend"), seedAddress(vault), seedU8(shardIndex)],
  });
  return [pda, bump];
}

/**
 * Phase 7 — derive PDA for `AuditLogSuccess` at `[b"audit_success", vault]`.
 * Allocated at vault creation, written by every mutating instruction that
 * lands on the success path. Closed at `close_vault`.
 */
export async function getAuditLogSuccessPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("audit_success"), seedAddress(vault)],
  });
  return [pda, bump];
}

/**
 * Phase 7 — derive PDA for `AuditLogRejected` at `[b"audit_rejected", vault]`.
 * Audit #2 F-19 split: keeps rejected-finalize bursts out of the success
 * buffer's blast radius.
 */
export async function getAuditLogRejectedPDA(
  vault: Address,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<[Address, number]> {
  const [pda, bump] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedString("audit_rejected"), seedAddress(vault)],
  });
  return [pda, bump];
}

// ─── Composite Account Resolution ────────────────────────────────────────────

export interface ResolveAccountsInput {
  vault: Address;
  agent: Address;
  tokenMint: Address;
  outputMint?: Address;
  feeDestination?: Address;
}

export interface ResolvedAccounts {
  vault: Address;
  policyPda: Address;
  trackerPda: Address;
  sessionPda: Address;
  agentOverlayPda?: Address;
}

/**
 * Auto-derive all PDA accounts needed for a composed Sigil transaction.
 * Token ATAs must be derived separately using `@solana-program/token`.
 */
export async function resolveAccounts(
  input: ResolveAccountsInput,
  programAddress: Address = SIGIL_PROGRAM_ADDRESS,
): Promise<ResolvedAccounts> {
  const [policyPda] = await getPolicyPDA(input.vault, programAddress);
  const [trackerPda] = await getTrackerPDA(input.vault, programAddress);
  const [sessionPda] = await getSessionPDA(
    input.vault,
    input.agent,
    input.tokenMint,
    programAddress,
  );

  const result: ResolvedAccounts = {
    vault: input.vault,
    policyPda,
    trackerPda,
    sessionPda,
  };

  return result;
}
