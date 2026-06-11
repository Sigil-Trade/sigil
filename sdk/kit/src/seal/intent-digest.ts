/**
 * AL3 — `computeSealInputDigest()` per-call intent digest.
 * Phase 9 Batch I (ISC-69..76, 143, 148, 150, 153, 155).
 *
 * SHA-256 over a canonical Borsh-style encoding of the SealInput envelope
 * (vault, agent identity, mint, amount, target protocol, network, sealed
 * instructions). Mirrors the discipline of TA-19's `policy_preview_digest`
 * (`sdk/kit/src/policy/compute-policy-preview-digest.ts`) — same primitive
 * (SHA-256 via the shared `canonical-encode.ts` helper), same APPEND-ONLY
 * field ordering, same byte-equal cross-runtime test fixture pattern.
 *
 * **What this defends against**
 * TA-19 binds the POLICY STATE the owner approved (allowlists, caps,
 * cosign flag, agent set hash). It does NOT bind the specific call the
 * agent is making — a compromised agent can still propose a transfer to
 * an attacker-controlled but still-allowlisted recipient, or reorder
 * instruction account metas to swap a destination, and the policy
 * checks all pass. AL3 closes that gap: the owner approves a SPECIFIC
 * intent (recipient, amount, mint, ix shape) in the preview UI, the SDK
 * hashes that intent into a 32-byte digest, and `executeSeal` rejects
 * if the bundle assembled at submit time produces a different digest.
 *
 * **Canonical encoding (FIXED — DO NOT REORDER)**
 *
 *   1. intent_version: u8 = 1                          (1 byte, reserved
 *                                                       for future format
 *                                                       evolution per
 *                                                       Council ISC-155)
 *   2. network_id: u8                                  (1 byte; 0=devnet,
 *                                                       1=mainnet — binds
 *                                                       AL4 isMainnet so
 *                                                       a mainnet bundle
 *                                                       can't be replayed
 *                                                       through a devnet
 *                                                       preview)
 *   3. vault: Pubkey                                   (32 bytes)
 *   4. agent: Pubkey                                   (32 bytes —
 *                                                       agent IDENTITY,
 *                                                       not signer)
 *   5. token_mint: Pubkey                              (32 bytes)
 *   6. amount: u64 LE                                  (8 bytes)
 *   7. target_protocol: Pubkey                         (32 bytes; system
 *                                                       program if the
 *                                                       caller omitted
 *                                                       targetProtocol)
 *   8. instructions: Vec<Ix>                           (u32 LE length ++
 *                                                       each ix below)
 *
 *   Each ix:
 *     a. program_address: Pubkey                       (32 bytes)
 *     b. accounts: Vec<(address: Pubkey, role: u8)>    (u32 LE length ++
 *                                                       each 33-byte
 *                                                       entry)
 *     c. data: Vec<u8>                                 (u32 LE length ++
 *                                                       data bytes)
 *
 * **Discipline guardrails**
 *
 * - NEVER `JSON.stringify` the input. Object property iteration order is
 *   not stable across engines and silent reorderings would invalidate
 *   the digest invariant. The canonical encoder walks fields explicitly.
 * - 32-byte pubkey comparisons use `Buffer.compare` on raw bytes (NOT
 *   base58 lexicographic) so the byte ordering matches Solana's
 *   `Pubkey::cmp` exactly. Council ISC-150 flagged this as a critical
 *   bug class — base58 lex doesn't preserve the canonical byte ordering
 *   when leading-zero counts differ.
 * - Account meta order is preserved as supplied. Reordering metas — even
 *   identical pubkeys — produces a different digest. This is the load-
 *   bearing protection against "swap recipient slots" attacks.
 * - `intent_version: u8 = 1` at position 1 reserves the discriminant
 *   for future format upgrades. A v2 SealInput format would write
 *   `intent_version: 2` and the on-chain verifier could route to the
 *   correct decoder by reading the first byte.
 *
 * **Canonical input contract (load-bearing)**
 *
 * `seal()` hashes the **pre-rewrite, post-filter** DeFi instructions:
 *
 *   1. ComputeBudget program ixs are NOT in the input (wallet adapters
 *      may prepend their own; the user-approved intent shouldn't pin
 *      a specific budget). `seal()` filters these out via
 *      `params.instructions.filter(ix => ix.programAddress !== COMPUTE_BUDGET_PROGRAM)`
 *      before computing the digest.
 *   2. Top-level System program ixs are NOT in the input (`isProtocolAllowed`
 *      would reject them anyway; `seal()` strips them in the same filter).
 *   3. Agent-ATA → vault-ATA rewrites happen AFTER the digest is
 *      computed. The digest reflects what the USER APPROVED (agent
 *      ATAs), not what the SDK SUBMITTED (vault ATAs). Any future
 *      on-chain verifier MUST receive the pre-rewrite projection as
 *      an explicit argument; re-deriving from the submitted tx bytes
 *      is impossible.
 *   4. `outputStablecoinAccount` and `additionalAtaReplacements` from
 *      `SealParams` are NOT bound by the digest in 0.16.x — they are
 *      caller-supplied overrides that materially change downstream
 *      ATA flow. Phase 9 Batch M §RP flagged this as a HIGH gap. A
 *      preview UI that wants tight intent binding MUST refuse any
 *      `SealParams` carrying these overrides until 0.16.1 hashes them
 *      into the canonical encoding.
 *
 * Any re-implementation that wants to verify a digest produced by
 * `seal()` MUST apply the same filter + use the pre-rewrite ix list.
 */

import type { Address, Instruction } from "../kit-adapter.js";
import {
  base58Decode32,
  sha256,
  writeU32Le,
  writeU64Le,
  writeU8,
} from "../canonical-encode.js";
import { SigilSdkDomainError } from "../errors/sdk.js";
import {
  SIGIL_ERROR__SDK__INVALID_AMOUNT,
  SIGIL_ERROR__SDK__INVALID_NETWORK,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
} from "../errors/codes.js";

/**
 * Network discriminant used at canonical position 2. Devnet and mainnet
 * are the two values bound by the digest; testnet and localnet are
 * coerced to devnet for digest purposes (the cap/allowlist contract is
 * the same on all non-mainnet networks).
 *
 * @internal The numeric discriminants are an encoding detail of the
 * canonical digest layout. Callers should pass `network: "devnet" |
 * "mainnet"` to {@link computeSealInputDigest} and let the encoder map
 * to the wire value. Consumers wanting a CAIP-2 string for cross-system
 * binding should use `CAIP2_SOLANA_*` from `../caip2-network.js`.
 */
export const NETWORK_ID_DEVNET = 0 as const;
/** @internal See {@link NETWORK_ID_DEVNET}. */
export const NETWORK_ID_MAINNET = 1 as const;

/**
 * Inputs to {@link computeSealInputDigest}. A narrower projection of
 * `SealParams` containing only the binding fields.
 *
 * `targetProtocol` is optional; when omitted, the system program ID
 * (`11111111111111111111111111111111`) is encoded at canonical position
 * 7. The on-chain verifier MUST mirror this default to keep the digest
 * stable.
 */
export interface SealIntentInput {
  vault: Address | string;
  /**
   * Agent identity pubkey. In V2 (Phase 9) the agent identity IS the
   * signer address — `params.agent.address` from `seal()`. If a future
   * V3 multi-sig flow ever separates signer from identity, this field
   * MUST carry the IDENTITY (the address that was registered in the
   * vault's agent list), not the signer.
   */
  agent: Address | string;
  tokenMint: Address | string;
  amount: bigint;
  targetProtocol?: Address | string;
  network: "devnet" | "mainnet";
  instructions: readonly Pick<
    Instruction,
    "programAddress" | "accounts" | "data"
  >[];
}

/** Canonical default for an omitted `targetProtocol` — the system program ID. */
const SYSTEM_PROGRAM_ZEROS = new Uint8Array(32);

/**
 * Magic prefix prepended to the canonical encoding (D-6 close, Bucket 2
 * 2026-05-21). Protects against cross-format digest collisions if Sigil ever
 * introduces a different SHA-256-based digest with the same field shape.
 * Mirror of `INTENT_DIGEST_MAGIC` in `programs/sigil/src/utils/intent_digest.rs:33`.
 */
const INTENT_DIGEST_MAGIC = new Uint8Array([0x53, 0x49, 0x47, 0x31]); // "SIG1"

/**
 * Intent format version. Bucket 2 bumped from v1 → v2 to discriminate the
 * magic-prefix addition and the on-chain scalar verifier ABI. v1 was the
 * prior client-only digest without prefix; any old v1 fixture is now
 * unverifiable on-chain by construction.
 */
const INTENT_VERSION_V2 = 2;

/**
 * Compute the canonical AL3 intent digest over a `SealIntentInput`.
 *
 * @returns 32-byte SHA-256 digest. Stable across Node, Bun, and the
 * browser (Phase 9 Batch L hex fixtures lock this down).
 *
 * @throws if any pubkey doesn't base58-decode to exactly 32 bytes, if
 *   `amount` is negative, or if `network` isn't `"devnet"` or `"mainnet"`.
 */
export function computeSealInputDigest(input: SealIntentInput): Uint8Array {
  if (input.amount < 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `computeSealInputDigest: amount must be non-negative, got ${input.amount}`,
      {
        context: {
          operation: "computeSealInputDigest",
          field: "amount",
          received: input.amount.toString(),
        } as never,
      },
    );
  }
  const networkId =
    input.network === "mainnet"
      ? NETWORK_ID_MAINNET
      : input.network === "devnet"
        ? NETWORK_ID_DEVNET
        : -1;
  if (networkId < 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_NETWORK,
      `computeSealInputDigest: network must be 'devnet' or 'mainnet', got ${String(input.network)}`,
      {
        context: {
          operation: "computeSealInputDigest",
          received: String(input.network),
        } as never,
      },
    );
  }

  // Decode all pubkeys up front so any malformed input fails before we
  // start the hash walk (clear error messages > corrupt digests).
  const vaultBytes = base58Decode32(input.vault as string);
  const agentBytes = base58Decode32(input.agent as string);
  const tokenMintBytes = base58Decode32(input.tokenMint as string);
  const targetProtocolBytes =
    input.targetProtocol === undefined
      ? SYSTEM_PROGRAM_ZEROS
      : base58Decode32(input.targetProtocol as string);

  // Pre-decode every instruction's pubkeys + data so we can both:
  //   (a) size the output buffer exactly, and
  //   (b) fail-fast on any malformed input before partial encoding.
  interface DecodedIx {
    programAddress: Uint8Array;
    accounts: { address: Uint8Array; role: number }[];
    data: Uint8Array;
  }
  const decodedIxs: DecodedIx[] = input.instructions.map((ix, idx) => {
    if (!ix.programAddress) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
        `computeSealInputDigest: ix[${idx}].programAddress is required`,
        {
          context: {
            operation: "computeSealInputDigest",
            field: `ix[${idx}].programAddress`,
            ixIndex: idx,
          } as never,
        },
      );
    }
    const programAddress = base58Decode32(ix.programAddress as string);
    const accounts = (ix.accounts ?? []).map((acc, accIdx) => {
      if (!acc.address) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__INVALID_PARAMS,
          `computeSealInputDigest: ix[${idx}].accounts[${accIdx}].address is required`,
          {
            context: {
              operation: "computeSealInputDigest",
              field: `ix[${idx}].accounts[${accIdx}].address`,
              ixIndex: idx,
              accountIndex: accIdx,
            } as never,
          },
        );
      }
      const role = acc.role;
      if (role === undefined || role === null) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__INVALID_PARAMS,
          `computeSealInputDigest: ix[${idx}].accounts[${accIdx}].role is required`,
          {
            context: {
              operation: "computeSealInputDigest",
              field: `ix[${idx}].accounts[${accIdx}].role`,
              ixIndex: idx,
              accountIndex: accIdx,
            } as never,
          },
        );
      }
      // §RP Batch I L-1: AccountRole enum values are 0..3 (READONLY,
      // WRITABLE, READONLY_SIGNER, WRITABLE_SIGNER). Reject anything
      // outside that range — a caller bypassing the enum to pass
      // role=257 would silently truncate to 1 in the digest while the
      // submitted tx encodes role=1 too (no exec divergence), but the
      // digest then masks bit-pattern information that a future
      // verifier might rely on.
      if (typeof role !== "number" || role < 0 || role > 3) {
        throw new SigilSdkDomainError(
          SIGIL_ERROR__SDK__INVALID_PARAMS,
          `computeSealInputDigest: ix[${idx}].accounts[${accIdx}].role must be an AccountRole (0..3), got ${String(role)}`,
          {
            context: {
              operation: "computeSealInputDigest",
              field: `ix[${idx}].accounts[${accIdx}].role`,
              ixIndex: idx,
              accountIndex: accIdx,
              received: String(role),
            } as never,
          },
        );
      }
      return {
        address: base58Decode32(acc.address as string),
        role,
      };
    });
    const data = ix.data ? new Uint8Array(ix.data) : new Uint8Array(0);
    return { programAddress, accounts, data };
  });

  // Compute exact buffer size:
  //   4 (magic "SIG1") + 1 (intent_version) + 1 (network_id) + 32 (vault) +
  //   32 (agent) + 32 (token_mint) + 8 (amount) + 32 (target_protocol) +
  //   4 (ix count) + sum over ixs of [32 (programAddress) + 4 (accounts
  //   count) + sum (33 per account) + 4 (data length) + data.length]
  //
  // D-6 close (Bucket 2 2026-05-21): the leading `INTENT_DIGEST_MAGIC`
  // bytes ("SIG1") bring fixed header to 146 (was 142). v2 encoder.
  const FIXED = 4 + 1 + 1 + 32 + 32 + 32 + 8 + 32 + 4;
  let ixsBytes = 0;
  for (const ix of decodedIxs) {
    ixsBytes += 32 + 4 + ix.accounts.length * 33 + 4 + ix.data.length;
  }
  const buf = new Uint8Array(FIXED + ixsBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;
  buf.set(INTENT_DIGEST_MAGIC, off);
  off += 4;
  off = writeU8(view, off, INTENT_VERSION_V2);
  off = writeU8(view, off, networkId);
  buf.set(vaultBytes, off);
  off += 32;
  buf.set(agentBytes, off);
  off += 32;
  buf.set(tokenMintBytes, off);
  off += 32;
  off = writeU64Le(view, off, input.amount);
  buf.set(targetProtocolBytes, off);
  off += 32;
  off = writeU32Le(view, off, decodedIxs.length);
  for (const ix of decodedIxs) {
    buf.set(ix.programAddress, off);
    off += 32;
    off = writeU32Le(view, off, ix.accounts.length);
    for (const acc of ix.accounts) {
      buf.set(acc.address, off);
      off += 32;
      off = writeU8(view, off, acc.role);
    }
    off = writeU32Le(view, off, ix.data.length);
    buf.set(ix.data, off);
    off += ix.data.length;
  }

  if (off !== buf.length) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `computeSealInputDigest: encoded ${off} bytes, expected ${buf.length}. ` +
        `If you added a field to SealIntentInput, update the FIXED/ixsBytes ` +
        `sizing AND the encoder body in the SAME commit.`,
      {
        context: {
          operation: "computeSealInputDigest",
          field: "encoder_size_invariant",
          encoded: off,
          expected: buf.length,
        } as never,
      },
    );
  }

  return sha256(buf);
}

/**
 * Inputs to {@link computeScalarIntentDigest} — the on-chain-verifiable
 * SCALAR subset of {@link SealIntentInput}.
 *
 * Drops the `instructions` array because the on-chain verifier does not
 * (yet) recompute the full ix-bound digest — that requires the ATA-rewrite
 * mapping table to cross the seal()/validate_and_authorize boundary, which
 * is v0.17+ work. The scalar subset binds the recipient/amount/mint/protocol
 * fields the user approves in the preview UI; ix-data tamper is still
 * gated by R-1..R-4 + TA-12 + TA-14 post-execution invariants.
 */
export interface ScalarIntentInput {
  vault: Address | string;
  agent: Address | string;
  tokenMint: Address | string;
  amount: bigint;
  targetProtocol?: Address | string;
  network: "devnet" | "mainnet";
}

/**
 * Compute the canonical scalar AL3 intent digest (D-1 + D-6 close, Bucket
 * 2 2026-05-21).
 *
 * SHA-256 over: `b"SIG1" || u8(2) || u8(network_id) || vault || agent ||
 * token_mint || u64_le(amount) || target_protocol`. Total 142 bytes.
 *
 * The on-chain verifier at `programs/sigil/src/utils/intent_digest.rs`
 * recomputes this same digest from `validate_and_authorize`'s typed
 * arguments and rejects bundle execution on byte-equal mismatch
 * (`ErrIntentDigestMismatch` code 6102). Network discriminant is derived
 * on-chain from the program's build feature; the caller does NOT pin it
 * — the encoder here just writes the byte the caller's wallet computed,
 * and Rust verifies the byte matches its own network. Wrong-network
 * digests fail by construction.
 *
 * @returns 32-byte SHA-256 digest, byte-equal to the Rust verifier output.
 *
 * @throws if any pubkey doesn't base58-decode to 32 bytes, if `amount`
 *   is negative, or if `network` isn't `"devnet"` or `"mainnet"`.
 */
export function computeScalarIntentDigest(
  input: ScalarIntentInput,
): Uint8Array {
  if (input.amount < 0n) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_AMOUNT,
      `computeScalarIntentDigest: amount must be non-negative, got ${input.amount}`,
      {
        context: {
          operation: "computeScalarIntentDigest",
          field: "amount",
          received: input.amount.toString(),
        } as never,
      },
    );
  }
  const networkId =
    input.network === "mainnet"
      ? NETWORK_ID_MAINNET
      : input.network === "devnet"
        ? NETWORK_ID_DEVNET
        : -1;
  if (networkId < 0) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_NETWORK,
      `computeScalarIntentDigest: network must be 'devnet' or 'mainnet', got ${String(input.network)}`,
      {
        context: {
          operation: "computeScalarIntentDigest",
          received: String(input.network),
        } as never,
      },
    );
  }

  const vaultBytes = base58Decode32(input.vault as string);
  const agentBytes = base58Decode32(input.agent as string);
  const tokenMintBytes = base58Decode32(input.tokenMint as string);
  const targetProtocolBytes =
    input.targetProtocol === undefined
      ? SYSTEM_PROGRAM_ZEROS
      : base58Decode32(input.targetProtocol as string);

  // 4 magic + 1 version + 1 network_id + 32 + 32 + 32 + 8 + 32 = 142 bytes.
  const buf = new Uint8Array(142);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let off = 0;
  buf.set(INTENT_DIGEST_MAGIC, off);
  off += 4;
  off = writeU8(view, off, INTENT_VERSION_V2);
  off = writeU8(view, off, networkId);
  buf.set(vaultBytes, off);
  off += 32;
  buf.set(agentBytes, off);
  off += 32;
  buf.set(tokenMintBytes, off);
  off += 32;
  off = writeU64Le(view, off, input.amount);
  buf.set(targetProtocolBytes, off);
  off += 32;

  if (off !== 142) {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_PARAMS,
      `computeScalarIntentDigest: encoded ${off} bytes, expected 142.`,
      {
        context: {
          operation: "computeScalarIntentDigest",
          field: "encoder_size_invariant",
          encoded: off,
          expected: 142,
        } as never,
      },
    );
  }

  return sha256(buf);
}
