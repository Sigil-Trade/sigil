/**
 * SIGIL_ERROR_CODES — constant exhaustiveness + naming convention tests.
 *
 * The CI canary: if a future PR drops or renames a code constant, these
 * tests fail and the rename becomes deliberate (with a corresponding
 * changeset entry) rather than silent.
 */

import { expect } from "chai";
import * as codes from "../../src/errors/codes.js";

describe("SIGIL_ERROR codes", () => {
  describe("constant exhaustiveness", () => {
    it("exports at least 47 code constants (canary against accidental drops)", () => {
      const constants = Object.entries(codes).filter(
        ([k, v]) => k.startsWith("SIGIL_ERROR__") && typeof v === "string",
      );
      // Floor-based assertion: future PRs may add codes; this catches drops
      // (which would be silent surface-area losses in the changeset).
      expect(constants.length).to.be.at.least(47);
    });

    it("every constant value equals its own name (round-trip safety)", () => {
      for (const [name, value] of Object.entries(codes)) {
        if (!name.startsWith("SIGIL_ERROR__")) continue;
        if (typeof value !== "string") continue;
        expect(value).to.equal(name);
      }
    });

    it("every constant follows the SIGIL_ERROR__<DOMAIN>__<DESCRIPTOR> convention", () => {
      const validDomains = new Set([
        "SHIELD",
        "TEE",
        "COMPOSE",
        "X402",
        "SDK",
        "RPC",
        "PROGRAM",
      ]);
      for (const [name, value] of Object.entries(codes)) {
        if (!name.startsWith("SIGIL_ERROR__")) continue;
        if (typeof value !== "string") continue;
        const parts = name.split("__");
        expect(parts.length).to.be.at.least(3, `bad name shape: ${name}`);
        expect(parts[0]).to.equal("SIGIL_ERROR");
        expect(validDomains.has(parts[1])).to.equal(
          true,
          `unknown domain: ${parts[1]} in ${name}`,
        );
      }
    });
  });

  describe("per-domain code coverage", () => {
    const findCodesByDomain = (domain: string) =>
      Object.entries(codes)
        .filter(
          ([k, v]) =>
            k.startsWith(`SIGIL_ERROR__${domain}__`) && typeof v === "string",
        )
        .map(([k]) => k);

    it("Shield domain has at least 4 codes", () => {
      const found = findCodesByDomain("SHIELD");
      expect(found.length).to.be.at.least(4);
    });

    it("TEE domain has at least 3 codes", () => {
      expect(findCodesByDomain("TEE").length).to.be.at.least(3);
    });

    it("X402 domain has at least 5 codes (one per leaf class)", () => {
      expect(findCodesByDomain("X402").length).to.be.at.least(5);
    });

    it("Compose domain has 3 codes (matching ComposeErrorCode legacy union)", () => {
      expect(findCodesByDomain("COMPOSE").length).to.equal(3);
    });

    it("SDK domain has at least 20 codes (covers config + runtime + state)", () => {
      expect(findCodesByDomain("SDK").length).to.be.at.least(20);
    });

    it("RPC domain has at least 5 codes (tx lifecycle + transport)", () => {
      expect(findCodesByDomain("RPC").length).to.be.at.least(5);
    });
  });

  describe("specific load-bearing codes (rename canary)", () => {
    // These constants are referenced explicitly in the implementation
    // (instanceof guards, test fixtures, JSDoc examples). If a rename
    // happens, these tests fail loudly so the rename is intentional.
    const loadBearing = [
      "SIGIL_ERROR__SHIELD__POLICY_DENIED",
      "SIGIL_ERROR__SHIELD__CONFIG_INVALID",
      "SIGIL_ERROR__TEE__ATTESTATION_FAILED",
      "SIGIL_ERROR__TEE__CERT_CHAIN_INVALID",
      "SIGIL_ERROR__TEE__PCR_MISMATCH",
      "SIGIL_ERROR__X402__HEADER_MALFORMED",
      "SIGIL_ERROR__X402__PAYMENT_FAILED",
      "SIGIL_ERROR__X402__UNSUPPORTED",
      "SIGIL_ERROR__X402__DESTINATION_BLOCKED",
      "SIGIL_ERROR__X402__REPLAY",
      "SIGIL_ERROR__COMPOSE__MISSING_PARAM",
      "SIGIL_ERROR__COMPOSE__INVALID_BIGINT",
      "SIGIL_ERROR__COMPOSE__UNSUPPORTED_ACTION",
      "SIGIL_ERROR__SDK__UNKNOWN",
    ] as const;

    for (const constName of loadBearing) {
      it(`exports ${constName} as a string literal equal to its name`, () => {
        const all = codes as Record<string, unknown>;
        expect(all[constName]).to.equal(constName);
      });
    }
  });
});
