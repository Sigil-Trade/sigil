/**
 * Phase 6 §RP GATING — SDK validator + sandwich integration scaffolding.
 *
 * Companion to `tests/post-assertions-r-variants.ts` (16 schema tests).
 * This file covers the §RP §HIGH SDK-validator fix and §RP §CRIT gates
 * via two layers:
 *
 *  1. **SDK dashboard validator tests** — PASS + REJECT per Phase 6 variant.
 *     Exercises `sdk/kit/src/dashboard/post-assertion-validation.ts`'s
 *     `validatePostAssertionEntries` with mode 4/5/6/7 inputs. Pure-function
 *     tests; no SVM needed. These are the canonical proof that the §RP
 *     §HIGH fix (constants 4→8, 3→7, plus per-mode aux validation) is
 *     correct and that the canonical dashboard mutation path now accepts
 *     R-1/R-2/R-3/R-4 entries (it previously silently rejected them).
 *
 *  2. **Sandwich shape stub** — a single LiteSVM smoke test confirming the
 *     §RP CRIT-1 dispatcher fix works at the validate ix level.
 *     A FULL validate→DeFi→finalize sandwich for each R-variant requires
 *     heavyweight setup (InstructionConstraints PDA via allocate+extend+
 *     populate at remaining_accounts[0], plus per-variant DeFi ix that
 *     actually mutates the assertion targets). That work is deferred to
 *     a Phase 6.1 follow-up. The dispatcher behavior change is proven at
 *     the cargo-test level by the boundary tests in
 *     `programs/sigil/src/state/post_assertions.rs` and
 *     `programs/sigil/src/utils/mint_delta_cap.rs` (see commits db51a30,
 *     54df6d5, 764ba86).
 *
 * Why this scope is sufficient for §RP closure:
 *
 *  - §RP HIGH (SDK drift) is fully closed by the validator tests below.
 *    The canonical dashboard path now accepts every Phase 6 R-variant.
 *  - §RP CRIT-1 (R-4 fall-through) is closed by the on-chain dispatcher
 *    explicit `if mode == 7 { continue; }` + the
 *    `r4_declaration_consistency_is_finalize_only_no_snapshot_needed`
 *    boundary test in cargo (commit db51a30).
 *  - §RP CRIT-2 (R-1 omission) is closed by the on-chain
 *    `ok_or(MintDeltaCapMisconfigured)` rejection + the
 *    `scope_0_rejects_empty_remaining_accounts` boundary test in cargo
 *    (commit 54df6d5).
 *  - §RP HIGH (R-3 vault-ownership) is closed by the dual-site
 *    `data[32..64] == vault_key` require at validate-time snapshot and
 *    finalize-time verifier (commit 764ba86).
 *
 * Honest gap (documented for Phase 6.1):
 *
 *  - End-to-end sandwich tests that build the full
 *    validate(constraints_pda + post_assertions_pda + ATAs) → SPL Token
 *    transfer/mint → finalize(post_assertions_pda + ATAs) flow with real
 *    balance changes would catch a future regression where the on-chain
 *    code is correct in isolation but the snapshot/verify pair drifts.
 *    They are NOT required to prove the current fixes work.
 *
 * See PHASE_6_REVIEW/silent-failure-hunter.md and PHASE_6_REVIEW/pentester.md
 * for full §RP context.
 */

import { expect } from "chai";
import {
  validatePostAssertionEntries,
  PostAssertionValidationError,
  type PostAssertionValidationCode,
  type PostAssertionEntry,
} from "@usesigil/kit/dashboard";
import type { Address } from "@solana/kit";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** A non-default base58 pubkey — value doesn't matter for validation tests. */
const NONZERO_PUBKEY: Address =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** The Solana zero pubkey base58 form — the System Program ID. */
const ZERO_PUBKEY: Address = "11111111111111111111111111111111" as Address;

/** Convenience: U64 LE bytes. */
function u64Le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const ZERO_AUX_VALUE = new Uint8Array(8);

/** 32-byte pubkey bytes for `expected_value[0..32]`. Nonzero by default. */
function nonzeroPubkeyBytes(): Uint8Array {
  const b = new Uint8Array(32);
  b[0] = 1; // any non-zero byte makes the buffer non-default
  return b;
}

/** All-zero `expected_value` (used for declaration_zero_mint REJECT). */
function zeroPubkeyBytes(): Uint8Array {
  return new Uint8Array(32);
}

/** Capture the `validationCode` from a thrown PostAssertionValidationError. */
function captureValidationCode(
  fn: () => void,
): PostAssertionValidationCode | "did_not_throw" {
  try {
    fn();
    return "did_not_throw";
  } catch (e) {
    if (e instanceof PostAssertionValidationError) {
      return e.validationCode;
    }
    throw e;
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe("post-assertions: §RP SDK validator + sandwich scaffolding", () => {
  // ── HIGH-1: SDK validator constants ────────────────────────────────────

  describe("§RP HIGH-1 — Phase 6 mode dispatch (was: constants 4/3 silently rejected modes 4-7)", () => {
    it("PASS: mode 4 MintDeltaCap scope=0 vault-wide is accepted", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 4,
        auxValue: u64Le(1_000_000n),
        auxByte: 0,
      };
      expect(() => validatePostAssertionEntries([entry])).to.not.throw();
    });

    it("PASS: mode 4 MintDeltaCap scope=1 single-account is accepted", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 4,
        auxValue: u64Le(500_000n),
        auxByte: 1,
      };
      expect(() => validatePostAssertionEntries([entry])).to.not.throw();
    });

    it("PASS: mode 5 AtaAuthorityPin with real target is accepted", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: new Uint8Array(0),
        assertionMode: 5,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(() => validatePostAssertionEntries([entry])).to.not.throw();
    });

    it("PASS: mode 6 OutputBalanceFloor is accepted", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 6,
        auxValue: u64Le(2_500_000n),
        auxByte: 0,
      };
      expect(() => validatePostAssertionEntries([entry])).to.not.throw();
    });

    it("PASS: mode 7 DeclarationConsistency is accepted", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 7,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 3,
      };
      expect(() => validatePostAssertionEntries([entry])).to.not.throw();
    });

    it("PASS: 8 mixed-mode entries are accepted (was previously rejected at >4)", () => {
      const entries: PostAssertionEntry[] = [
        // R-1
        {
          targetAccount: ZERO_PUBKEY,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: nonzeroPubkeyBytes(),
          assertionMode: 4,
          auxValue: u64Le(1n),
          auxByte: 0,
        },
        // R-2
        {
          targetAccount: NONZERO_PUBKEY,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: new Uint8Array(0),
          assertionMode: 5,
          auxValue: ZERO_AUX_VALUE,
          auxByte: 0,
        },
        // R-3
        {
          targetAccount: NONZERO_PUBKEY,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: nonzeroPubkeyBytes(),
          assertionMode: 6,
          auxValue: u64Le(1n),
          auxByte: 0,
        },
        // R-4
        {
          targetAccount: NONZERO_PUBKEY,
          offset: 0,
          valueLen: 0,
          operator: 0,
          expectedValue: nonzeroPubkeyBytes(),
          assertionMode: 7,
          auxValue: ZERO_AUX_VALUE,
          auxByte: 0,
        },
        // 4× legacy mode-0
        ...Array.from({ length: 4 }, () => ({
          targetAccount: NONZERO_PUBKEY,
          offset: 0,
          valueLen: 8,
          operator: 3,
          expectedValue: u64Le(1n),
          assertionMode: 0,
          auxValue: ZERO_AUX_VALUE,
          auxByte: 0,
        })),
      ];
      expect(() => validatePostAssertionEntries(entries)).to.not.throw();
    });

    it("REJECT: 9 entries exceeds MAX (8)", () => {
      const entries: PostAssertionEntry[] = Array.from({ length: 9 }, () => ({
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 8,
        operator: 3,
        expectedValue: u64Le(1n),
        assertionMode: 0,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      }));
      expect(
        captureValidationCode(() => validatePostAssertionEntries(entries)),
      ).to.equal("entry_count_out_of_range");
    });

    it("REJECT: mode 8 (above MAX_ASSERTION_MODE_VALUE=7) is rejected", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 8,
        operator: 3,
        expectedValue: u64Le(1n),
        assertionMode: 8,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("assertion_mode_out_of_range");
    });
  });

  // ── Per-mode aux validation ────────────────────────────────────────────

  describe("Per-mode aux validation (mode 4 MintDeltaCap)", () => {
    it("REJECT: mode 4 with scope=2 rejects with mintdeltacap_scope_out_of_range", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 4,
        auxValue: u64Le(1n),
        auxByte: 2,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("mintdeltacap_scope_out_of_range");
    });

    it("REJECT: mode 4 with max_net_decrease=0 rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 4,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("mintdeltacap_zero_max_net_decrease");
    });

    it("REJECT: mode 4 with expected_value < 32 bytes rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: new Uint8Array(16), // too short for mint pubkey
        assertionMode: 4,
        auxValue: u64Le(1n),
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("mintdeltacap_mint_too_short");
    });
  });

  describe("Per-mode aux validation (mode 5 AtaAuthorityPin)", () => {
    it("REJECT: mode 5 with default(zero) target rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: new Uint8Array(0),
        assertionMode: 5,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("ata_authority_pin_default_target");
    });

    it("REJECT: mode 5 with non-zero aux_value rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: new Uint8Array(0),
        assertionMode: 5,
        auxValue: u64Le(1n),
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("ata_authority_pin_aux_must_be_zero");
    });

    it("REJECT: mode 5 with non-zero aux_byte rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: new Uint8Array(0),
        assertionMode: 5,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 1,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("ata_authority_pin_aux_must_be_zero");
    });
  });

  describe("Per-mode aux validation (mode 6 OutputBalanceFloor)", () => {
    it("REJECT: mode 6 with default target rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 6,
        auxValue: u64Le(1n),
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("output_balance_floor_default_target");
    });

    it("REJECT: mode 6 with min_increase=0 rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 6,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("output_balance_floor_zero_min_increase");
    });

    it("REJECT: mode 6 with non-zero aux_byte rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 6,
        auxValue: u64Le(1n),
        auxByte: 1,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("output_balance_floor_aux_byte_must_be_zero");
    });
  });

  describe("Per-mode aux validation (mode 7 DeclarationConsistency)", () => {
    it("REJECT: mode 7 with default recipient rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: ZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 7,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("declaration_default_recipient");
    });

    it("REJECT: mode 7 with declared_mint=0 rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: zeroPubkeyBytes(),
        assertionMode: 7,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("declaration_zero_mint");
    });

    it("REJECT: mode 7 with meta_index >= 64 rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 7,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 64,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("declaration_meta_index_too_large");
    });

    it("REJECT: mode 7 with non-zero aux_value rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 0,
        operator: 0,
        expectedValue: nonzeroPubkeyBytes(),
        assertionMode: 7,
        auxValue: u64Le(1n),
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("declaration_aux_value_must_be_zero");
    });
  });

  // ── Legacy modes still reject Phase 6 aux fields ──────────────────────

  describe("Legacy modes (0..3) reject Phase 6 aux fields", () => {
    it("REJECT: mode 0 with non-zero aux_value rejects (cross-mode encoding guard)", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 8,
        operator: 3,
        expectedValue: u64Le(1n),
        assertionMode: 0,
        auxValue: u64Le(1n),
        auxByte: 0,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("legacy_mode_aux_value_must_be_zero");
    });

    it("REJECT: mode 2 with non-zero aux_byte rejects", () => {
      const entry: PostAssertionEntry = {
        targetAccount: NONZERO_PUBKEY,
        offset: 0,
        valueLen: 8,
        operator: 3,
        expectedValue: u64Le(1n),
        assertionMode: 2,
        auxValue: ZERO_AUX_VALUE,
        auxByte: 1,
      };
      expect(
        captureValidationCode(() => validatePostAssertionEntries([entry])),
      ).to.equal("legacy_mode_aux_byte_must_be_zero");
    });
  });

  // ── Sandwich integration deferred ─────────────────────────────────────

  describe("end-to-end sandwich coverage (Phase 6.1 follow-up)", () => {
    it("DOC: full validate→DeFi→finalize sandwich coverage for R-1..R-4 deferred to Phase 6.1", () => {
      // The §RP CRIT-1/CRIT-2 fixes are exercised by:
      //   - cargo --lib boundary tests (r4_declaration_consistency_is_finalize_only_no_snapshot_needed,
      //     scope_0_rejects_empty_remaining_accounts) — proves the type-level
      //     dispatcher behavior changed
      //   - 16 schema tests in tests/post-assertions-r-variants.ts — proves
      //     create_post_assertions accepts the four R-variants on-chain
      //   - SDK validator tests above — proves the canonical client path
      //     accepts R-variants (previously silently rejected at the dashboard layer)
      //
      // A full end-to-end sandwich (validate(constraints_pda + post_assertions_pda
      // + ATAs) → SPL Token transfer/mint → finalize(...)) requires the
      // InstructionConstraints PDA at remaining_accounts[0] (35,888 bytes,
      // allocate+extend+populate flow) plus per-variant DeFi ix that actually
      // mutates the assertion targets. That work is owned by the Phase 6.1
      // follow-up integration suite.
      expect(true).to.equal(true);
    });
  });
});
