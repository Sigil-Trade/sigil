/**
 * G4 (audit close) — TA-09 client-side cosign helper.
 *
 * Closes the G4 gate of Phase 6: the on-chain TA-09 cosign workflow is
 * implemented at `queue_policy_update.rs` (handler lines 286-328) and
 * re-validated at `apply_pending_policy.rs` (handler lines 70-84), but the
 * SDK previously had NO client-side path to PRODUCE a valid cosign session +
 * digest. This file ships that path.
 *
 * Usage (illustrative — non-Kit caller):
 *
 *   import { buildCosignBundle } from "@usesigil/kit";
 *
 *   const bundle = buildCosignBundle({
 *     cosignSessionPubkey: cosigner.address,
 *     ownerSigner: owner,            // unused at digest time — see note below
 *     dailySpendingCapUsd: 800_000_000n,  // raise from 500_000_000 → elevated
 *   });
 *
 *   await queuePolicyUpdate({
 *     ...args,
 *     cosignSession: bundle.cosignSession,
 *     newPolicyPreviewDigest: previewDigest, // separate TA-19 digest
 *     // cosign digest IS NOT a queue arg — the on-chain handler RECOMPUTES
 *     // it from the queue args + cosign_session pubkey and stores the
 *     // result on PendingPolicyUpdate. Apply re-validates by recomputing.
 *   });
 *
 * Why the helper exists if the cosign digest isn't a queue arg:
 *   - The on-chain handler classifies an "elevated mutation" via comparing
 *     `Option::Some(new) > live` (raises) / `new.contains(p) where !live.contains(p)`
 *     (expansions). If you're queueing what you BELIEVE is elevated, this
 *     helper produces the digest you EXPECT the on-chain handler to store,
 *     so your client can:
 *       (a) sanity-check elevation up-front before submitting a tx (and ask
 *           the user for the cosigner signature explicitly), and
 *       (b) compare against `PendingPolicyUpdate.cosignDigest` after queue,
 *           catching any silent SDK encoder drift.
 *   - The cosign session pubkey IS a queue arg (`cosign_session: Pubkey`).
 *     For elevated mutations the handler rejects `Pubkey::default()` with
 *     `ErrCosignRequired`, and ALSO requires the corresponding signer in
 *     `remaining_accounts` with `is_signer == true`.
 *
 * G3 + G6 elevation triggers — what counts as "elevated" (all bound by this
 * digest as of Round 2 B4 F-1, 2026-05-19):
 *   - raises_daily_cap = daily_spending_cap_usd: Some(new) > live
 *   - raises_max_tx = max_transaction_amount_usd: Some(new) > live
 *   - expands_destinations = allowed_destinations: any new pubkey not in live
 *     OR new.len() > live.len()
 *   - expands_protocols = protocols: any new pubkey not in live OR
 *     new.len() > live.len()
 *   - lowers_floor = stable_balance_floor: Some(new) < live           (G3)
 *   - raises_per_recipient_cap = per_recipient_daily_cap_usd:
 *     Some(new) > live                                                (G3)
 *   - disables_protocol_caps = has_protocol_caps: Some(false) while live=true (G3)
 *   - shrinks_or_raises_caps = protocol_caps: any entry mutated       (G3)
 *   - disables_cosign = cosign_required: Some(false) while live=true  (G6)
 *
 * Round 2 B4 F-1 fix (2026-05-19): the cosign digest binding now extends to
 * ALL G3 + G6 triggers. Previously the digest only bound positions 1-5
 * (cosign_session, daily/max-tx caps, destinations, protocols) — the G3/G6
 * elevation triggers ELEVATED the queue but were NOT bound by this digest
 * (they were bound only by TA-19 policy_preview_digest). That left a gap:
 * a tampered SDK or discriminator-collision attack on the pending PDA
 * could mutate those triggers between queue and apply without producing a
 * cosign-digest mismatch. With the extension, every elevation trigger is
 * now bound by BOTH the cosign digest (intent) and TA-19 (byte safety).
 *
 * Phase 4 PEN-CROSS-3 pattern reference:
 *   PEN-CROSS-3 introduced sibling-handler digest binding (constraints/post-
 *   assertion flips). The same defense-in-depth pattern applies here: the
 *   on-chain TA-09 handler recomputes the cosign digest at BOTH queue (queue
 *   binding) AND apply (re-validation). A rogue program with the same
 *   discriminator on the pending PDA cannot rewrite args between queue and
 *   apply without producing a digest mismatch.
 *
 * @see `programs/sigil/src/utils/cosign_digest.rs` — canonical Rust impl
 * @see `programs/sigil/src/instructions/queue_policy_update.rs:286-328` —
 *      queue-time gate + digest binding
 * @see `programs/sigil/src/instructions/apply_pending_policy.rs:70-84` —
 *      apply-time re-validation
 * @see `sdk/kit/src/policy/compute-cosign-digest.ts` — SDK-side digest helper
 */

import type { Address, TransactionSigner } from "./kit-adapter.js";
import { computeCosignDigest } from "./policy/compute-cosign-digest.js";

/**
 * CANONICAL `cosign_session` ARG CONTRACT — Round 2 §RP-2 B4 F-3 (2026-05-19).
 *
 * Every Sigil instruction that supports the cosign opt-in path accepts a
 * `cosign_session: Pubkey` argument. This contract documents what a non-Codama
 * SDK consumer MUST pass to avoid the silent rejection path the on-chain
 * handler took as of Round 2 B4 F-3 Option A:
 *
 *   • NON-ELEVATED queue (the default for every mutation that does NOT
 *     raise daily_cap / max_tx, expand destinations / protocols, lower
 *     stable_balance_floor, raise per_recipient_daily_cap_usd, disable
 *     protocol_caps, mutate protocol_caps entries, or disable cosign):
 *       Pass `Pubkey::default()` — the SystemProgram pubkey
 *       `11111111111111111111111111111111` (32 zero bytes).
 *       Do NOT include any cosigner in `remaining_accounts`.
 *
 *   • ELEVATED queue (raising daily_cap, expanding destinations, etc. — see
 *     the full trigger list in the `CosignArgs` JSDoc below):
 *       Pass a REAL session pubkey (non-default AND distinct from owner),
 *       AND include that session pubkey in `remaining_accounts` with
 *       `is_signer == true`.
 *       Use {@link buildCosignBundle} to mirror the on-chain digest the
 *       handler will recompute + store on `PendingPolicyUpdate`.
 *
 *   • REJECT path: passing a non-default `cosign_session` on a non-elevated
 *     queue surfaces `InvalidPermissions` (6088). This is INTENTIONAL —
 *     the on-chain handler refuses to silently downgrade a caller's
 *     declared intent. See Round 2 §RP-2 B4 F-3 Option A rationale in
 *     `queue_policy_update.rs` (and the corresponding test fixtures in
 *     `tests/policy-digest-invariant.ts`).
 *
 * This contract applies to: `queue_policy_update`, `queue_agent_permissions`,
 * and any future queue handler that takes a `cosign_session` arg. The Codama
 * generated client surfaces this as a typed `Address` field; hand-rolled
 * builders MUST follow the contract above to avoid `InvalidPermissions`.
 */

/**
 * Arguments for {@link buildCosignBundle}. Mirrors the elevated-mutation
 * subset of `queue_policy_update` args.
 */
export interface CosignArgs {
  /**
   * The cosigning session pubkey to bind into the digest. MUST be:
   *   1. Distinct from the owner's pubkey (handler rejects same-key cosign
   *      under `ErrCosignRequired` — same-key collapses the two-signer gate),
   *   2. Non-default (i.e. NOT `11111111111111111111111111111111`), and
   *   3. Present in the queue transaction's `remaining_accounts` with
   *      `is_signer == true`.
   *
   * The caller is responsible for (3) — this helper produces the digest, the
   * tx builder includes the signer.
   *
   * See the "CANONICAL `cosign_session` ARG CONTRACT" block above for the
   * non-elevated vs elevated vs reject paths. Round 2 §RP-2 B4 F-3 (2026-05-19).
   */
  cosignSessionPubkey: Address;

  /**
   * The owner who will sign the queue tx. Currently UNUSED by digest
   * derivation (the cosign digest binds the cosign_session pubkey, not the
   * owner — owner authority is established by Solana's `is_signer` check on
   * the owner account). Accepted as a constructor arg for symmetry with the
   * full queue signing surface and to surface the "two distinct signers"
   * requirement at the type level.
   */
  ownerSigner: TransactionSigner;

  // ── Elevated-mutation fields bound by THIS cosign digest ──────────────
  //
  // Each `null`/`undefined` = Option::None on-chain (the field is not being
  // mutated). A non-null value = Option::Some.
  //
  // The discriminator is load-bearing: passing `null` vs `0n` produces
  // DIFFERENT digests. The on-chain handler's elevation detection uses
  // `Option::is_some_and(|new| new > live)`, so `null` never elevates but
  // `0n` MAY elevate (and certainly changes the digest).

  /**
   * Pending `daily_spending_cap_usd` (6-decimal USDC face value).
   * Raising this beyond the live policy value ELEVATES the queue.
   * Bound by THIS cosign digest.
   */
  dailySpendingCapUsd?: bigint | null;

  /**
   * Pending `max_transaction_amount_usd` (6-decimal USDC face value).
   * Raising this beyond the live policy value ELEVATES the queue.
   * Bound by THIS cosign digest.
   */
  maxTransactionAmountUsd?: bigint | null;

  /**
   * Pending `allowed_destinations`. Adding any pubkey not in live (or
   * growing the list) ELEVATES the queue. Bound by THIS cosign digest.
   *
   * NOTE: order matters — the on-chain handler treats `[A, B]` and `[B, A]`
   * as DIFFERENT digests (ordered encoding). Always pass destinations in the
   * same order the owner signed.
   */
  allowedDestinations?: readonly Address[] | null;

  /**
   * Pending `protocols`. Adding any pubkey not in live (or growing the list)
   * ELEVATES the queue. Bound by THIS cosign digest. Same ordering caveat as
   * `allowedDestinations`.
   */
  protocols?: readonly Address[] | null;

  // ── Round 2 B4 F-1 (2026-05-19): G3 + G6 elevated triggers bound here ──
  //
  // These fields are BOTH elevation triggers AND now bound by this cosign
  // digest. Mutating them between queue and apply produces a cosign-digest
  // mismatch (ErrCosignRequired, 6089) — closing the gap where the digest
  // previously only bound positions 1-5 of the canonical encoding.

  /**
   * Pending `stable_balance_floor` (6-decimal USDC face value). LOWERING
   * this below the live policy value ELEVATES the queue (G3 audit fix
   * 2026-05-18). Round 2 B4 F-1: now BOUND by this cosign digest at
   * canonical position 6.
   */
  stableBalanceFloor?: bigint | null;

  /**
   * Pending `per_recipient_daily_cap_usd` (6-decimal USDC face value).
   * RAISING this above the live policy value ELEVATES the queue (G3 audit
   * fix 2026-05-18). Round 2 B4 F-1: now BOUND by this cosign digest at
   * canonical position 7.
   */
  perRecipientDailyCapUsd?: bigint | null;

  /**
   * Pending `has_protocol_caps` flag. Setting this to `false` while the
   * live policy is `true` ELEVATES the queue (disabling protocol caps
   * entirely). Round 2 B4 F-1: BOUND by this cosign digest at canonical
   * position 8.
   */
  hasProtocolCaps?: boolean | null;

  /**
   * Pending `protocol_caps` Vec<u64> arg (6-decimal USDC face values,
   * parallel to `protocols`). Mutating individual caps (shrink-to-zero or
   * raise) ELEVATES the queue. Round 2 B4 F-1: BOUND by this cosign digest
   * at canonical position 9. Same ordering caveat as `protocols` (parallel
   * arrays — order is load-bearing).
   */
  protocolCaps?: readonly bigint[] | null;

  /**
   * Pending `cosign_required` flag. Setting this to `false` while the live
   * policy is `true` ELEVATES the queue (G6 one-way ratchet — disabling
   * cosign requires cosign). Round 2 B4 F-1: BOUND by this cosign digest
   * at canonical position 10.
   */
  cosignRequired?: boolean | null;
}

/**
 * Bundle produced by {@link buildCosignBundle}. Pass `cosignSession` as the
 * `cosign_session` queue arg; the on-chain handler will recompute and store
 * `cosignDigest` on `PendingPolicyUpdate.cosignDigest` (the SDK consumer can
 * fetch + compare for a defense-in-depth sanity check after the queue tx
 * lands).
 */
export interface CosignBundle {
  /**
   * The cosigning session pubkey, same as {@link CosignArgs.cosignSessionPubkey}.
   * Pass this directly as the `cosign_session` arg to `queue_policy_update`.
   */
  cosignSession: Address;
  /**
   * The 32-byte SHA-256 digest the on-chain handler will recompute + store.
   * Equal to the on-chain `compute_cosign_digest` over the same inputs.
   *
   * The caller does NOT pass this directly to `queue_policy_update` — the
   * on-chain handler recomputes it from the queue args + cosign_session.
   * Use this to:
   *   (a) sanity-check what the on-chain handler WILL store, and
   *   (b) compare to `PendingPolicyUpdate.cosignDigest` after queue to catch
   *       SDK encoder drift.
   */
  cosignDigest: Uint8Array;
}

/**
 * Produce a cosign session + digest bundle for an elevated `queue_policy_update`.
 *
 * Pass the same elevated-mutation fields you intend to send to
 * `queue_policy_update`. The helper:
 *   1. Validates that the cosign session is non-default and distinct from
 *      the owner.
 *   2. Computes the canonical cosign digest mirroring the on-chain
 *      `compute_cosign_digest` byte-for-byte.
 *   3. Returns the bundle.
 *
 * IMPORTANT: this helper does NOT enforce that the mutation IS elevated. The
 * on-chain handler does that detection. If you call this for a non-elevated
 * mutation, the bundle is technically valid but the handler will set
 * `pending.cosign_digest = [0u8; 32]` and `pending.cosign_session =
 * Pubkey::default()` instead of binding to the cosigner. Use the bundle when
 * you have already determined elevation is required, e.g. via an SDK-side
 * elevation check before constructing the tx.
 *
 * @throws if `cosignSessionPubkey` is `11111111111111111111111111111111` (default)
 * @throws if `cosignSessionPubkey` equals `ownerSigner.address`
 * @throws if any address fails base58 decoding to 32 bytes
 */
export function buildCosignBundle(args: CosignArgs): CosignBundle {
  // Pre-flight: the on-chain handler rejects default/owner-same cosign with
  // ErrCosignRequired (6089). Surface the same failures at the SDK level
  // with a clearer error message — better DX than digging through Anchor
  // error codes after a failed simulation.
  const defaultPubkey =
    "11111111111111111111111111111111" as unknown as Address;
  if (args.cosignSessionPubkey === defaultPubkey) {
    throw new Error(
      "buildCosignBundle: cosignSessionPubkey is the default pubkey " +
        "(11111111111111111111111111111111). The on-chain handler will reject " +
        "this with ErrCosignRequired (6089). Pass a real session pubkey.",
    );
  }
  if (
    (args.cosignSessionPubkey as unknown as string) ===
    (args.ownerSigner.address as unknown as string)
  ) {
    throw new Error(
      "buildCosignBundle: cosignSessionPubkey equals ownerSigner.address. " +
        "The on-chain handler rejects same-key cosign with ErrCosignRequired " +
        "(6089) because it collapses the two-signer gate. Use a distinct " +
        "cosigning session pubkey.",
    );
  }

  const digest = computeCosignDigest({
    cosignSession: args.cosignSessionPubkey,
    dailySpendingCapUsd: args.dailySpendingCapUsd ?? null,
    maxTransactionAmountUsd: args.maxTransactionAmountUsd ?? null,
    allowedDestinations: args.allowedDestinations ?? null,
    protocols: args.protocols ?? null,
    // Round 2 B4 F-1 (2026-05-19): the 5 new G3 + G6 elevation triggers are
    // now BOUND by this cosign digest. Flow them through to mirror the
    // on-chain handler's CosignDigestFields construction in
    // `queue_policy_update.rs` (handler passes all 10 fields).
    stableBalanceFloor: args.stableBalanceFloor ?? null,
    perRecipientDailyCapUsd: args.perRecipientDailyCapUsd ?? null,
    hasProtocolCaps: args.hasProtocolCaps ?? null,
    protocolCaps: args.protocolCaps ?? null,
    cosignRequired: args.cosignRequired ?? null,
  });

  return {
    cosignSession: args.cosignSessionPubkey,
    cosignDigest: digest,
  };
}
