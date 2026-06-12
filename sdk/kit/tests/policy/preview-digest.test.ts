/**
 * Cross-impl test for TA-19 policy_preview_digest.
 *
 * Pins the SAME fixtures used in the on-chain Rust unit tests at
 * `programs/sigil/src/utils/policy_digest.rs`:
 *
 *   - `digest_known_value_for_minimal_policy`
 *   - `digest_known_value_for_realistic_policy`
 *
 * Both sides assert byte-for-byte equality against the same hex constants. If
 * the canonical encoding diverges in either direction, the two tests fail in
 * lock-step (the goal — not silent acceptance of a divergent format).
 *
 * The test also exercises a few invariants of the SDK helper: determinism,
 * sensitivity to `observe_only`, and sensitivity to protocol slice order.
 */

import { expect } from "chai";
import * as fc from "fast-check";
import { createHash } from "node:crypto";
import {
  computeAgentSetHash,
  computePolicyPreviewDigest,
  EMPTY_AGENT_SET_HASH,
} from "../../src/policy/compute-policy-preview-digest.js";

// Post-D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey appended at
// position 22 of the canonical encoding. Both fixtures use
// `PublicKey.default` (32 zero bytes) because the reactivate-cosign gate
// is OFF by default at init; owners opt in via `queue_policy_update`.
// Prior values:
//   Pre-PEN-CROSS-6:
//     HEX_MINIMAL   = 29f9a0caa6851902abe7de24ac30380ef50c220d25d541f8fe1762793152b623
//     HEX_REALISTIC = 33d743a9643fcc6d39c30ac5f8c159d6e94d31ce354d6dd3843367773b3a8502
//   Post-PEN-CROSS-6 (pre-PEN-CROSS-2):
//     HEX_MINIMAL   = 0ad67bf0d81b972c60abe82ebea425d4b30d0ef910bcc7b76584fae36a0f1252
//     HEX_REALISTIC = ed9ac12d21e0f03933bbf789eae99944c311f2ff6f1baff992058307174de316
//   Post-PEN-CROSS-2 (pre-TA-05):
//     HEX_MINIMAL   = 63974a2661afc539fc8f1e55245adcef9e3b91f82a191c757ed3c795e8e59148
//     HEX_REALISTIC = ac54284579f4b8afd714b290ec22df745bddbede9a5b366f17c8db776fab53c7
//   Post-TA-05 (pre-TA-07/17):
//     HEX_MINIMAL   = f48fb07695e4b5da504654ad5281f0d39e9fcff6fa9cde64a463f1d8a8471322
//     HEX_REALISTIC = af3990ea433e3de25baa05627f9a38ab497dffcba1e202aac99343b1de9cfc8c
//   Post-TA-07/17 (pre-TA-12):
//     HEX_MINIMAL   = eec4230cd52f7f567e06e9b197a0dacdc3955808d1a5a256d5975a4ac1177beb
//     HEX_REALISTIC = 35ed9a9f97b0fa21ca581bd45f11b28c2932525101e9be063cc0d2f6bebc3c48
//   Post-TA-12 (pre-TA-14):
//     HEX_MINIMAL   = d3e731941e95cb1c426ccc6f2b5c53525c033f498bdb79a593bc86c98508c67a
//     HEX_REALISTIC = 6523cb9b64baef661d919c802a8762332d1091cb53e8245d1624f52839fc9c8c
//   Post-TA-14 (pre-G6):
//     HEX_MINIMAL   = 45c51e8d77b5a1775ea95c760a4a554288fc246f91e10bac620cfda902936a46
//     HEX_REALISTIC = 67c7cde90c0d8140fceb370bf94dcc15488ffd1407a84d4c248b590a8b9d810f
//   Post-G6 (pre-PEN-CROSS-1):
//     HEX_MINIMAL   = 19c70cb767358d1ce2a4c736b067172e0f87ddad8ae6f98292a62bd5f9bae355
//     HEX_REALISTIC = 15ab9e4290b8bc9229adc64e46cf785edb1adc78596eb339e7bdd4df2a2cab62
//   Post-PEN-CROSS-1 (pre-D-5):
//     HEX_MINIMAL   = a9d8654da866751cbec1c45dcae0b7c3b6e45ee98c2b284b8cd9f8f09d894f83
//     HEX_REALISTIC = 503ff364c055085089576e5af684383e10b7dd65ed796bd57c53927e879cdb0e
//
// Cross-impl byte-equality pinned against Rust unit tests in
// `programs/sigil/src/utils/policy_digest.rs::digest_known_value_*`.
// M1-04: regenerated for the 21-field digest (has_constraints removed).
// F-Q6 (2026-06-02): regenerated for the 22-field digest (+operator_grant_delay_seconds=0).
//   Pre-F-Q6 (post-D-5):
//     HEX_MINIMAL   = 8d80e131f0fca07e71d173cd5c559f0041a6ef9391e3a87ecac5f249c5bda36d
//     HEX_REALISTIC = 21155d71a1d0a466cf57676658dcae577b3cab8d1cc512c4589f9ebba10bae03
// M-1 (2026-06-11): regenerated for the 24-field digest (+has_protocol_caps=false, +protocol_caps=[]).
const HEX_MINIMAL =
  "7e2958e4e38802d5416e3965a5eb22e51daa192ca093dbebe776cdae8d469780";
const HEX_REALISTIC =
  "67f71921a83501d6a517e18894820d9375d5c4080d22ff1d2b76455cf4049313";
/**
 * Phase 8 PEN-CROSS-1 (audit 2026-05-19): empty-vault agent_set_hash.
 * SHA-256 of [0x00,0x00,0x00,0x00]. Mirrors Rust
 * `policy_digest.rs::EMPTY_AGENT_SET_HASH` and SDK helper
 * `compute-policy-preview-digest.ts::EMPTY_AGENT_SET_HASH`.
 */
const HEX_EMPTY_AGENT_SET =
  "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119";

// Base58 encodings of fixed test pubkeys [1u8;32], [2u8;32], [10u8;32].
// Computed once (see Rust unit-test fixtures `pk(1) / pk(2) / pk(10)`).
const PK_1 = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const PK_2 = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const PK_10 = "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5";

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("TA-19 — computePolicyPreviewDigest cross-impl pin", () => {
  it("minimal fixture matches on-chain Rust digest byte-for-byte", () => {
    const digest = computePolicyPreviewDigest({
      dailySpendingCapUsd: 0n,
      maxTransactionSizeUsd: 0n,
      maxSlippageBps: 0,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [],
      destinationMode: 0,
      allowedDestinations: [],
      timelockDuration: 0n,
      sessionExpirySeconds: 0n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 0n,
      // TA-05: minimal fixture uses inert operating_hours=0
      operatingHours: 0,
      autoPromoteGrays: false,
      autoRevokeThreshold: 0,
      // TA-12: minimal fixture pins floor=0 (no reserve)
      stableBalanceFloor: 0n,
      // TA-14: minimal fixture pins per-recipient cap=0 (no cap)
      perRecipientDailyCapUsd: 0n,
      // G6: minimal fixture pins cosign opt-in = false (default low-friction)
      cosignRequired: false,
    });
    expect(toHex(digest)).to.equal(HEX_MINIMAL);
  });

  it("realistic fixture matches on-chain Rust digest byte-for-byte", () => {
    const digest = computePolicyPreviewDigest({
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1, PK_2],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      // TA-05: realistic fixture pins all-hours default
      operatingHours: 0x00ffffff,
      // TA-07: realistic fixture pins auto_promote_grays=false
      autoPromoteGrays: false,
      // TA-17: realistic fixture pins auto_revoke_threshold=5 (the default)
      autoRevokeThreshold: 5,
      // TA-12: realistic fixture pins floor=$100 (100_000_000 in 6-decimal USDC face value)
      stableBalanceFloor: 100_000_000n,
      // TA-14: realistic fixture pins per-recipient cap=$50 (50_000_000)
      perRecipientDailyCapUsd: 50_000_000n,
      // G6: realistic fixture pins cosign opt-in = false (default low-friction)
      cosignRequired: false,
    });
    expect(toHex(digest)).to.equal(HEX_REALISTIC);
  });

  it("same fields produce the same digest (determinism)", () => {
    const fields = {
      dailySpendingCapUsd: 1n,
      maxTransactionSizeUsd: 1n,
      maxSlippageBps: 50,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 0n,
      operatingHours: 0,
    } as const;
    const d1 = computePolicyPreviewDigest(fields);
    const d2 = computePolicyPreviewDigest(fields);
    expect(toHex(d1)).to.equal(toHex(d2));
  });

  it("observe_only=true flips the digest", () => {
    const base = {
      dailySpendingCapUsd: 1n,
      maxTransactionSizeUsd: 1n,
      maxSlippageBps: 0,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 0n,
      operatingHours: 0,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({ ...base, observeOnly: true });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("protocol slice reorder changes the digest (ordered encoding)", () => {
    const a = {
      dailySpendingCapUsd: 1n,
      maxTransactionSizeUsd: 1n,
      maxSlippageBps: 0,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1, PK_2],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 0n,
      operatingHours: 0,
    } as const;
    const b = { ...a, protocols: [PK_2, PK_1] } as const;
    const d1 = computePolicyPreviewDigest(a);
    const d2 = computePolicyPreviewDigest(b);
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // PEN-CROSS-6 cross-impl pin: developer_fee_rate is bound by the digest.
  // Flipping it from 0 to a non-zero value MUST change the digest.
  it("developer_fee_rate flip changes the digest (PEN-CROSS-6)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 0n,
      operatingHours: 0,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({ ...base, developerFeeRate: 25 });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // PEN-CROSS-2 cross-impl pin: created_at_slot is bound by the digest.
  // Two policies with identical fields but distinct slots MUST hash differently.
  it("created_at_slot flip changes the digest (PEN-CROSS-2)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({ ...base, createdAtSlot: 67890n });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  it("rejects malformed pubkey base58", () => {
    expect(() =>
      computePolicyPreviewDigest({
        dailySpendingCapUsd: 0n,
        maxTransactionSizeUsd: 0n,
        maxSlippageBps: 0,
        developerFeeRate: 0,
        protocolMode: 1,
        protocols: ["not-a-pubkey"],
        destinationMode: 0,
        allowedDestinations: [],
        timelockDuration: 0n,
        sessionExpirySeconds: 0n,
        observeOnly: false,
        hasPostAssertions: 0,
        createdAtSlot: 0n,
        operatingHours: 0,
      }),
    ).to.throw(/base58/);
  });

  // TA-05 cross-impl pin: operating_hours is bound by the digest.
  // Flipping it from 0 to a non-zero mask MUST change the digest.
  it("operating_hours flip changes the digest (TA-05)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    // 13:00-17:00 UTC = bits 13..17 = 0x1E000
    const d2 = computePolicyPreviewDigest({
      ...base,
      operatingHours: 0x0001e000,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // TA-07 cross-impl pin: auto_promote_grays is bound by the digest.
  it("auto_promote_grays flip changes the digest (TA-07)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({
      ...base,
      autoPromoteGrays: true,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // TA-17 cross-impl pin: auto_revoke_threshold is bound by the digest.
  it("auto_revoke_threshold flip changes the digest (TA-17)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({
      ...base,
      autoRevokeThreshold: 3,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // TA-12 cross-impl pin: stable_balance_floor is bound by the digest.
  // Flipping it from 0 to a non-zero value MUST change the digest —
  // defends against a tampered SDK silently lowering the owner's reserve
  // between queue and apply.
  it("stable_balance_floor flip changes the digest (TA-12)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      stableBalanceFloor: 0n,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({
      ...base,
      stableBalanceFloor: 100_000_000n,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // G6 cross-impl pin: cosign_required is bound by the digest. Flipping
  // the owner's opt-in choice MUST change the digest — a tampered SDK
  // cannot silently flip cosign on/off between owner approval and on-
  // chain landing. Disabling cosign on a live policy where this is true
  // is itself an elevated mutation (one-way ratchet) per
  // `queue_policy_update`.
  it("cosign_required flip changes the digest (G6 audit 2026-05-18)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
      cosignRequired: false,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({
      ...base,
      cosignRequired: true,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });

  // Phase 8 PEN-CROSS-1 cross-impl pin (Council ISC-141): the empty-vault
  // agent_set_hash MUST equal the deterministic SHA-256 of [0x00,0x00,0x00,0x00].
  // Mirrors the Rust `EMPTY_AGENT_SET_HASH` constant.
  it("EMPTY_AGENT_SET_HASH matches Rust empty-Vec hash (PEN-CROSS-1)", () => {
    expect(toHex(EMPTY_AGENT_SET_HASH)).to.equal(HEX_EMPTY_AGENT_SET);
  });

  // Phase 8 PEN-CROSS-1 cross-impl pin: computeAgentSetHash sorts agents
  // by pubkey ascending so the projection is deterministic regardless of
  // insert order.
  it("computeAgentSetHash is order-independent (PEN-CROSS-1)", () => {
    const a = { pubkey: PK_1, capability: 2 };
    const b = { pubkey: PK_2, capability: 1 };
    const h_ab = computeAgentSetHash([a, b]);
    const h_ba = computeAgentSetHash([b, a]);
    expect(toHex(h_ab)).to.equal(toHex(h_ba));
  });

  // Cross-impl pin (audit 2026-06-11 follow-up): the dashboard sibling/queue
  // digests now feed POPULATED agent sets through computeAgentSetHash. Only the
  // empty-set hash was pinned cross-impl before; this pins a deterministic
  // 2-agent set byte-for-byte against the Rust `compute_agent_set_hash`
  // (policy_digest.rs::agent_set_hash_populated_cross_impl_pin uses the
  // identical fixture: pk(1)=[1;32] cap 2, pk(2)=[2;32] cap 1). Drift in either
  // impl's sort / Borsh layout / hash fails here.
  it("computeAgentSetHash matches the Rust populated-set pin (PEN-CROSS-1)", () => {
    const h = computeAgentSetHash([
      { pubkey: PK_1, capability: 2 },
      { pubkey: PK_2, capability: 1 },
    ]);
    expect(toHex(h)).to.equal(
      "9b9885416074bb759440b5072807d230c7ab479d645f063356087e0386480c42",
    );
  });

  // Phase 8 PEN-CROSS-1 cross-impl pin: inserting an agent into the set
  // MUST diverge the policy digest. Closes the silent-insertion vector.
  it("agent_set_hash flip changes the digest (PEN-CROSS-1)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
      cosignRequired: false,
      agentSetHash: EMPTY_AGENT_SET_HASH,
    } as const;
    const d_empty = computePolicyPreviewDigest(base);
    const withAgent = computeAgentSetHash([{ pubkey: PK_2, capability: 2 }]);
    expect(toHex(withAgent)).to.not.equal(toHex(EMPTY_AGENT_SET_HASH));
    const d_with = computePolicyPreviewDigest({
      ...base,
      agentSetHash: withAgent,
    });
    expect(toHex(d_empty)).to.not.equal(toHex(d_with));
  });

  // TA-14 cross-impl pin: per_recipient_daily_cap_usd is bound by the
  // digest. Flipping it MUST change the digest — defends against a
  // tampered SDK silently raising the per-recipient cap to drain to
  // one recipient.
  it("per_recipient_daily_cap_usd flip changes the digest (TA-14)", () => {
    const base = {
      dailySpendingCapUsd: 500_000_000n,
      maxTransactionSizeUsd: 100_000_000n,
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [PK_1],
      destinationMode: 0,
      allowedDestinations: [PK_10],
      timelockDuration: 1800n,
      sessionExpirySeconds: 30n,
      observeOnly: false,
      hasPostAssertions: 0,
      createdAtSlot: 12345n,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
    } as const;
    const d1 = computePolicyPreviewDigest(base);
    const d2 = computePolicyPreviewDigest({
      ...base,
      perRecipientDailyCapUsd: 50_000_000n,
    });
    expect(toHex(d1)).to.not.equal(toHex(d2));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PEN-CROSS-7 (Phase 2 close-up): property test for cross-impl encoding
// parity.
//
// Strategy: for random fixtures, compute the digest via the SDK helper AND
// via a hand-encoded byte buffer written directly in this test. Both must
// match. The hand-encoded path is a deliberate independent implementation of
// the canonical encoding spec — if a future SDK refactor silently drops a
// field or shifts byte order, this property test fails in lock-step. If a
// future Rust handler diverges from the same spec, the existing
// HEX_MINIMAL/HEX_REALISTIC cross-impl pin (above) catches it.
// ─────────────────────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Encode 32 raw bytes back to base58 — minimal helper avoiding extra deps.
function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }
  const digits: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < leadingZeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]!];
  }
  return out;
}

/**
 * Reference encoder — hand-written from the spec in
 * `programs/sigil/src/utils/policy_digest.rs` and
 * `compute-policy-preview-digest.ts`'s docblock. Intentionally re-derived
 * (not imported) so it catches silent encoder drift in the SDK.
 */
function referenceDigest(fields: {
  dailySpendingCapUsd: bigint;
  maxTransactionSizeUsd: bigint;
  maxSlippageBps: number;
  developerFeeRate: number;
  protocolMode: number;
  protocolBytes: readonly Uint8Array[];
  destinationMode: number;
  destinationBytes: readonly Uint8Array[];
  timelockDuration: bigint;
  sessionExpirySeconds: bigint;
  observeOnly: boolean;
  hasPostAssertions: number;
  createdAtSlot: bigint;
  operatingHours: number;
  autoPromoteGrays: boolean;
  autoRevokeThreshold: number;
  stableBalanceFloor: bigint;
  perRecipientDailyCapUsd: bigint;
  cosignRequired: boolean;
  agentSetHash: Uint8Array;
  // D-5 (audit 2026-05-19, F-RP3-1): owner-chosen reactivate-time
  // cosigner pubkey, encoded as 32 raw bytes at canonical position 22.
  cosignSessionPubkey: Uint8Array;
  // F-Q6 (2026-06-02): operator_grant_delay_seconds, u64 LE, appended last.
  operatorGrantDelaySeconds: bigint;
  // M-1 (2026-06-11): per-protocol caps at canonical positions 23-24.
  hasProtocolCaps: boolean;
  protocolCaps: readonly bigint[];
}): string {
  const parts: number[] = [];
  const pushU64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    for (const x of b) parts.push(x);
  };
  const pushU32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    for (const x of b) parts.push(x);
  };
  const pushU16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    for (const x of b) parts.push(x);
  };
  const pushU8 = (v: number) => parts.push(v & 0xff);

  pushU64(fields.dailySpendingCapUsd);
  pushU64(fields.maxTransactionSizeUsd);
  pushU16(fields.maxSlippageBps);
  pushU16(fields.developerFeeRate);
  pushU8(fields.protocolMode);
  pushU32(fields.protocolBytes.length);
  for (const b of fields.protocolBytes) {
    for (const x of b) parts.push(x);
  }
  pushU8(fields.destinationMode);
  pushU32(fields.destinationBytes.length);
  for (const b of fields.destinationBytes) {
    for (const x of b) parts.push(x);
  }
  pushU64(fields.timelockDuration);
  pushU64(fields.sessionExpirySeconds);
  pushU8(fields.observeOnly ? 1 : 0);
  pushU8(fields.hasPostAssertions);
  pushU64(fields.createdAtSlot);
  // TA-05: operating_hours at position 15
  pushU32(fields.operatingHours);
  // TA-07: auto_promote_grays at position 16
  pushU8(fields.autoPromoteGrays ? 1 : 0);
  // TA-17: auto_revoke_threshold at position 17
  pushU8(fields.autoRevokeThreshold);
  // TA-12: stable_balance_floor at position 18
  pushU64(fields.stableBalanceFloor);
  // TA-14: per_recipient_daily_cap_usd at position 19
  pushU64(fields.perRecipientDailyCapUsd);
  // G6 (audit 2026-05-18 cosign opt-in): cosign_required at position 20
  pushU8(fields.cosignRequired ? 1 : 0);
  // Phase 8 PEN-CROSS-1 (audit 2026-05-19): agent_set_hash at position 21.
  if (fields.agentSetHash.length !== 32) {
    throw new Error(
      `referenceDigest: agentSetHash must be 32 bytes, got ${fields.agentSetHash.length}`,
    );
  }
  for (const x of fields.agentSetHash) parts.push(x);
  // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey at position 22.
  if (fields.cosignSessionPubkey.length !== 32) {
    throw new Error(
      `referenceDigest: cosignSessionPubkey must be 32 bytes, got ${fields.cosignSessionPubkey.length}`,
    );
  }
  for (const x of fields.cosignSessionPubkey) parts.push(x);
  // F-Q6 (2026-06-02): operator_grant_delay_seconds, u64 LE, appended last.
  pushU64(fields.operatorGrantDelaySeconds);
  // M-1 (2026-06-11): has_protocol_caps (pos 23, bool as u8) + protocol_caps
  // (pos 24, u32 LE length prefix ++ each u64 LE).
  pushU8(fields.hasProtocolCaps ? 1 : 0);
  pushU32(fields.protocolCaps.length);
  for (const c of fields.protocolCaps) pushU64(c);

  const buf = Buffer.from(parts);
  return createHash("sha256").update(buf).digest("hex");
}

describe("TA-19 — property test: SDK encoder == reference encoder (PEN-CROSS-7)", () => {
  it("100 random fixtures match between SDK and hand-encoded reference", () => {
    const pubkeyArb = fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((u8: Uint8Array) => u8 as Uint8Array);

    fc.assert(
      fc.property(
        fc.bigUint({ max: (1n << 64n) - 1n }), // daily_spending_cap_usd
        fc.bigUint({ max: (1n << 64n) - 1n }), // max_transaction_size_usd
        fc.integer({ min: 0, max: 65535 }), // max_slippage_bps
        fc.integer({ min: 0, max: 65535 }), // developer_fee_rate
        fc.integer({ min: 0, max: 255 }), // protocol_mode (handler rejects most, but encoder must handle all)
        fc.array(pubkeyArb, { minLength: 0, maxLength: 10 }), // protocols
        fc.integer({ min: 0, max: 255 }), // destination_mode
        fc.array(pubkeyArb, { minLength: 0, maxLength: 10 }), // allowed_destinations
        fc.bigUint({ max: (1n << 64n) - 1n }), // timelock_duration
        fc.bigUint({ max: (1n << 64n) - 1n }), // session_expiry_seconds
        fc.boolean(), // observe_only
        fc.integer({ min: 0, max: 255 }), // has_post_assertions
        fc.bigUint({ max: (1n << 64n) - 1n }), // created_at_slot
        fc.integer({ min: 0, max: 0xffffffff }), // operating_hours (TA-05; encoder must handle any u32)
        fc.boolean(), // auto_promote_grays (TA-07)
        fc.integer({ min: 0, max: 255 }), // auto_revoke_threshold (TA-17; encoder handles any u8)
        fc.bigUint({ max: (1n << 64n) - 1n }), // stable_balance_floor (TA-12)
        fc.bigUint({ max: (1n << 64n) - 1n }), // per_recipient_daily_cap_usd (TA-14)
        fc.boolean(), // cosign_required (G6 audit 2026-05-18 cosign opt-in)
        fc.uint8Array({ minLength: 32, maxLength: 32 }), // agent_set_hash (PEN-CROSS-1)
        fc.uint8Array({ minLength: 32, maxLength: 32 }), // cosign_session_pubkey (D-5 audit 2026-05-19, F-RP3-1)
        fc.bigUint({ max: (1n << 64n) - 1n }), // operator_grant_delay_seconds (F-Q6 2026-06-02)
        fc.boolean(), // has_protocol_caps (M-1 2026-06-11)
        fc.array(fc.bigUint({ max: (1n << 64n) - 1n }), {
          minLength: 0,
          maxLength: 10,
        }), // protocol_caps (M-1 2026-06-11)
        (
          dailyCap,
          maxTx,
          slippage,
          feeRate,
          protocolMode,
          protocolBytes,
          destinationMode,
          destinationBytes,
          timelock,
          sessionExpiry,
          observeOnly,
          hasPostAssertions,
          createdAtSlot,
          operatingHours,
          autoPromoteGrays,
          autoRevokeThreshold,
          stableBalanceFloor,
          perRecipientDailyCapUsd,
          cosignRequired,
          agentSetHash,
          cosignSessionPubkey,
          operatorGrantDelaySeconds,
          hasProtocolCaps,
          protocolCaps,
        ) => {
          const sdkDigest = computePolicyPreviewDigest({
            dailySpendingCapUsd: dailyCap,
            maxTransactionSizeUsd: maxTx,
            maxSlippageBps: slippage,
            developerFeeRate: feeRate,
            protocolMode,
            protocols: protocolBytes.map((b: Uint8Array) => base58Encode(b)),
            destinationMode,
            allowedDestinations: destinationBytes.map((b: Uint8Array) =>
              base58Encode(b),
            ),
            timelockDuration: timelock,
            sessionExpirySeconds: sessionExpiry,
            observeOnly,
            hasPostAssertions,
            createdAtSlot,
            operatingHours,
            autoPromoteGrays,
            autoRevokeThreshold,
            stableBalanceFloor,
            perRecipientDailyCapUsd,
            cosignRequired,
            agentSetHash,
            // D-5 (audit 2026-05-19, F-RP3-1): pass the random 32 bytes
            // directly to the encoder; the SDK helper accepts both raw
            // Uint8Array and base58-string shapes.
            cosignSessionPubkey,
            // F-Q6 (2026-06-02): operator_grant_delay_seconds.
            operatorGrantDelaySeconds,
            // M-1 (2026-06-11): per-protocol caps.
            hasProtocolCaps,
            protocolCaps,
          });
          const refDigest = referenceDigest({
            dailySpendingCapUsd: dailyCap,
            maxTransactionSizeUsd: maxTx,
            maxSlippageBps: slippage,
            developerFeeRate: feeRate,
            protocolMode,
            protocolBytes,
            destinationMode,
            destinationBytes,
            timelockDuration: timelock,
            sessionExpirySeconds: sessionExpiry,
            observeOnly,
            hasPostAssertions,
            createdAtSlot,
            operatingHours,
            autoPromoteGrays,
            autoRevokeThreshold,
            stableBalanceFloor,
            perRecipientDailyCapUsd,
            cosignRequired,
            agentSetHash,
            cosignSessionPubkey,
            // F-Q6 (2026-06-02): operator_grant_delay_seconds.
            operatorGrantDelaySeconds,
            // M-1 (2026-06-11): per-protocol caps.
            hasProtocolCaps,
            protocolCaps,
          });
          const sdkHex = Array.from(sdkDigest)
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
          return sdkHex === refDigest;
        },
      ),
      { numRuns: 100 },
    );
  });
});
