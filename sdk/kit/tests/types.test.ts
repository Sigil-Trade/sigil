import { expect } from "chai";
import {
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  MAX_DEVELOPER_FEE_RATE,
  USD_DECIMALS,
  MAX_AGENTS_PER_VAULT,
  MAX_SLIPPAGE_BPS,
  EPOCH_DURATION,
  NUM_EPOCHS,
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  PROTOCOL_MODE_DENYLIST,
  FULL_CAPABILITY,
  FULL_PERMISSIONS,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  isStablecoinMint,
  normalizeNetwork,
  validateNetwork,
} from "../src/types.js";
import type { Address } from "@solana/kit";

describe("types", () => {
  describe("Constants", () => {
    it("FEE_RATE_DENOMINATOR = 1_000_000", () => {
      expect(FEE_RATE_DENOMINATOR).to.equal(1_000_000);
    });

    it("PROTOCOL_FEE_RATE = 200", () => {
      expect(PROTOCOL_FEE_RATE).to.equal(200);
    });

    it("MAX_DEVELOPER_FEE_RATE = 500", () => {
      expect(MAX_DEVELOPER_FEE_RATE).to.equal(500);
    });

    it("USD_DECIMALS = 6", () => {
      expect(USD_DECIMALS).to.equal(6);
    });

    it("MAX_AGENTS_PER_VAULT = 10", () => {
      expect(MAX_AGENTS_PER_VAULT).to.equal(10);
    });

    it("MAX_SLIPPAGE_BPS = 5000", () => {
      expect(MAX_SLIPPAGE_BPS).to.equal(5_000);
    });

    it("EPOCH_DURATION = 600", () => {
      expect(EPOCH_DURATION).to.equal(600);
    });

    it("NUM_EPOCHS = 144", () => {
      expect(NUM_EPOCHS).to.equal(144);
    });

    it("PROTOCOL_MODE_ALL = 0, ALLOWLIST = 1, DENYLIST = 2", () => {
      expect(PROTOCOL_MODE_ALL).to.equal(0);
      expect(PROTOCOL_MODE_ALLOWLIST).to.equal(1);
      expect(PROTOCOL_MODE_DENYLIST).to.equal(2);
    });
  });

  describe("FULL_CAPABILITY / FULL_PERMISSIONS", () => {
    it("FULL_CAPABILITY equals 2n", () => {
      expect(FULL_CAPABILITY).to.equal(2n);
    });

    it("FULL_PERMISSIONS is an alias for FULL_CAPABILITY", () => {
      expect(FULL_PERMISSIONS).to.equal(FULL_CAPABILITY);
    });

    it("FULL_CAPABILITY has bits 0 and 1 set", () => {
      expect(FULL_CAPABILITY & 1n).to.equal(0n); // bit 0 NOT set (2n = 10 binary)
      expect(FULL_CAPABILITY & 2n).to.equal(2n); // bit 1 set
    });
  });

  // Legacy preset bitmasks (SWAP_ONLY, PERPS_ONLY, TRANSFER_ONLY,
  // ESCROW_ONLY, PERPS_FULL) + their helpers (hasPermission,
  // permissionsToStrings, stringsToPermissions, PermissionBuilder,
  // ACTION_PERMISSION_MAP) were DELETED in the A11 cleanup — the test
  // blocks that covered them went with them. The v6 program uses a 2-bit
  // capability enum, not a bitmask. See `FULL_CAPABILITY` tests above.

  describe("isStablecoinMint", () => {
    it("devnet USDC returns true", () => {
      expect(isStablecoinMint(USDC_MINT_DEVNET, "devnet")).to.be.true;
    });

    it("devnet USDT returns true", () => {
      expect(isStablecoinMint(USDT_MINT_DEVNET, "devnet")).to.be.true;
    });

    it("mainnet USDC returns true", () => {
      expect(isStablecoinMint(USDC_MINT_MAINNET, "mainnet-beta")).to.be.true;
    });

    it("mainnet USDT returns true", () => {
      expect(isStablecoinMint(USDT_MINT_MAINNET, "mainnet-beta")).to.be.true;
    });

    it("SOL returns false", () => {
      expect(
        isStablecoinMint(
          "So11111111111111111111111111111111111111112" as Address,
          "mainnet-beta",
        ),
      ).to.be.false;
    });

    it("random address returns false", () => {
      expect(
        isStablecoinMint(
          "11111111111111111111111111111111" as Address,
          "devnet",
        ),
      ).to.be.false;
    });
  });

  // `hasPermission` + `permissionsToStrings` blocks deleted in A11 — the
  // underlying 21-bit bitmask was replaced by a 2-bit capability enum
  // (see docstrings in `src/types.ts`). The helpers no longer exist.
  //
  // `parseActionType` + `isSpendingAction` blocks deleted in V2 Option A —
  // the underlying ActionType enum and helpers were removed alongside the
  // on-chain `is_spending` field. V2 derives spending from `amount > 0n`.

  // `PermissionBuilder` block deleted in A11 — see block comment above
  // at the "Preset bitmasks" deletion for full rationale.

  describe("normalizeNetwork", () => {
    it("passes devnet through unchanged", () => {
      expect(normalizeNetwork("devnet")).to.equal("devnet");
    });

    it("normalizes mainnet to mainnet-beta", () => {
      expect(normalizeNetwork("mainnet")).to.equal("mainnet-beta");
    });

    it("passes mainnet-beta through unchanged", () => {
      expect(normalizeNetwork("mainnet-beta")).to.equal("mainnet-beta");
    });
  });

  describe("validateNetwork", () => {
    it("accepts mainnet as valid input", () => {
      expect(() => validateNetwork("mainnet")).not.to.throw();
    });

    it("rejects invalid network strings", () => {
      expect(() => validateNetwork("testnet")).to.throw(/Invalid network/);
    });
  });

  // `stringsToPermissions` block deleted in A11 — the helper encoded the
  // pre-v6 21-bit bitmask and had no v6 equivalent (capability is a 2-bit
  // enum, not a string list). `parseActionType` was the only surviving
  // ActionType-name helper but was also deleted in V2 Option A alongside
  // the on-chain ActionType field.
});
