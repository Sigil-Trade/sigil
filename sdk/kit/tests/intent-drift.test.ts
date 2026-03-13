import { expect } from "chai";
import type { Address } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  detectIntentDrift,
  enforceIntentDrift,
  type DriftConfig,
  type DriftCheckResult,
} from "../src/intent-drift.js";
import { ShieldDeniedError } from "../src/shield.js";
import type { IntentAction } from "../src/intents.js";
import type { InspectableInstruction } from "../src/inspector.js";

// ─── Test Constants ─────────────────────────────────────────────────────────

const SIGNER = "11111111111111111111111111111111" as Address;
const PHALNX = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const FLASH = "FLASH6Lo6h3iasJKWzFVnGEEAS4rS4cFywSWcpuARtwN" as Address;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const UNKNOWN_PROGRAM = "UnknownProgram1111111111111111111111111111" as Address;
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;

// Helper to create IntentAction without full param shapes (drift detection reads params loosely)
function intent(type: string, params: Record<string, unknown> = {}): IntentAction {
  return { type, params } as unknown as IntentAction;
}

function makeIx(programAddress: Address, data?: Uint8Array, accounts?: Array<{ address: Address; role?: AccountRole }>): InspectableInstruction {
  return {
    programAddress,
    data,
    accounts: accounts ?? [],
  };
}

function makeSplTransfer(authority: Address, dest: Address, amount: bigint): InspectableInstruction {
  // SPL Transfer discriminator = 3, amount = 8 bytes LE
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer discriminator
  let a = amount;
  for (let i = 1; i <= 8; i++) {
    data[i] = Number(a & 0xFFn);
    a >>= 8n;
  }
  return {
    programAddress: TOKEN_PROGRAM,
    data,
    accounts: [
      { address: "source1111111111111111111111111111111111111" as Address },
      { address: dest },
      { address: authority },
    ],
  };
}

// ─── detectIntentDrift Tests ────────────────────────────────────────────────

describe("intent-drift", () => {
  describe("no drift", () => {
    it("returns no violations for matching swap intent", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeIx(PHALNX),
      ];
      const result = detectIntentDrift(intent("swap", { amount: "1000000" }), instructions, SIGNER);
      expect(result.drifted).to.equal(false);
      expect(result.violations).to.have.lengthOf(0);
      expect(result.severity).to.equal("none");
    });
  });

  describe("program mismatch", () => {
    it("detects unexpected program in swap transaction", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeIx(UNKNOWN_PROGRAM), // unexpected
        makeIx(PHALNX),
      ];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      expect(result.drifted).to.equal(true);
      expect(result.violations.some(v => v.type === "program_mismatch")).to.equal(true);
      expect(result.severity).to.equal("high");
    });

    it("allows system programs (compute budget, ATA, system)", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx("11111111111111111111111111111111" as Address), // system program
        makeIx(PHALNX),
        makeIx(JUPITER),
      ];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      const programViolations = result.violations.filter(v => v.type === "program_mismatch");
      expect(programViolations).to.have.lengthOf(0);
    });
  });

  describe("instruction count", () => {
    it("flags excessive instruction count", () => {
      const instructions = Array(12).fill(makeIx(JUPITER));
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER, { maxExtraInstructions: 3 });
      expect(result.violations.some(v => v.type === "instruction_count")).to.equal(true);
    });

    it("allows normal instruction count", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeIx(PHALNX),
      ];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      const countViolations = result.violations.filter(v => v.type === "instruction_count");
      expect(countViolations).to.have.lengthOf(0);
    });
  });

  describe("phantom transfers", () => {
    it("detects multiple outgoing SPL transfers from signer", () => {
      const instructions = [
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeSplTransfer(SIGNER, DEST, 1_000_000n),
        makeSplTransfer(SIGNER, DEST, 500_000n), // phantom
      ];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      expect(result.violations.some(v => v.type === "phantom_transfer")).to.equal(true);
      expect(result.severity).to.equal("high");
    });

    it("allows single outgoing transfer", () => {
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(intent("transfer", { destination: DEST, amount: "1000000" }), instructions, SIGNER);
      const phantomViolations = result.violations.filter(v => v.type === "phantom_transfer");
      expect(phantomViolations).to.have.lengthOf(0);
    });

    it("ignores transfers from non-signer authority", () => {
      const OTHER = "OtherAuth1111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeSplTransfer(OTHER, DEST, 1_000_000n),
        makeSplTransfer(OTHER, DEST, 500_000n),
      ];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      const phantomViolations = result.violations.filter(v => v.type === "phantom_transfer");
      expect(phantomViolations).to.have.lengthOf(0);
    });
  });

  describe("amount mismatch", () => {
    it("detects amount beyond tolerance", () => {
      // SPL transfer with amount far beyond declared
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, DEST, 2_000_000n), // 100% off
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER, { amountTolerancePct: 5 },
      );
      expect(result.violations.some(v => v.type === "amount_mismatch")).to.equal(true);
    });

    it("allows amount within tolerance", () => {
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, DEST, 1_040_000n), // 4% off, within 5% tolerance
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER, { amountTolerancePct: 5 },
      );
      const amountViolations = result.violations.filter(v => v.type === "amount_mismatch");
      expect(amountViolations).to.have.lengthOf(0);
    });
  });

  describe("recipient mismatch", () => {
    it("detects transfer to unexpected destination", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      expect(result.violations.some(v => v.type === "recipient_mismatch")).to.equal(true);
      expect(result.severity).to.equal("medium");
    });
  });

  describe("severity levels", () => {
    it("program_mismatch → high", () => {
      const instructions = [makeIx(UNKNOWN_PROGRAM)];
      const result = detectIntentDrift(intent("swap"), instructions, SIGNER);
      expect(result.severity).to.equal("high");
    });

    it("instruction_count only → low", () => {
      // Many instructions but all expected programs (phalnx is always expected)
      const instructions = Array(15).fill(makeIx(PHALNX));
      const result = detectIntentDrift(intent("transfer"), instructions, SIGNER, { maxExtraInstructions: 3 });
      const countViolations = result.violations.filter(v => v.type === "instruction_count");
      expect(countViolations.length).to.be.greaterThan(0);
    });
  });

  describe("enforceIntentDrift", () => {
    it("throws ShieldDeniedError on high severity", () => {
      const instructions = [makeIx(UNKNOWN_PROGRAM)];
      expect(() => enforceIntentDrift(intent("swap"), instructions, SIGNER)).to.throw(ShieldDeniedError);
    });

    it("returns result without throwing on low severity", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx(PHALNX),
        makeIx(JUPITER),
      ];
      const result = enforceIntentDrift(intent("swap"), instructions, SIGNER);
      expect(result.drifted).to.equal(false);
    });

    it("warns on medium severity without throwing", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = enforceIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      expect(result.severity).to.equal("medium");
      expect(result.drifted).to.equal(true);
    });
  });

  describe("TransferChecked destination index (BUG-2)", () => {
    function makeSplTransferChecked(authority: Address, dest: Address, amount: bigint): InspectableInstruction {
      // SPL TransferChecked discriminator = 12, amount = 8 bytes LE, decimals = 1 byte
      const data = new Uint8Array(10);
      data[0] = 12; // TransferChecked discriminator
      let a = amount;
      for (let i = 1; i <= 8; i++) {
        data[i] = Number(a & 0xFFn);
        a >>= 8n;
      }
      data[9] = 6; // decimals
      return {
        programAddress: TOKEN_PROGRAM,
        data,
        accounts: [
          { address: "source1111111111111111111111111111111111111" as Address }, // source
          { address: "mint111111111111111111111111111111111111111" as Address }, // mint
          { address: dest },       // destination at index 2
          { address: authority },   // authority at index 3
        ],
      };
    }

    it("detects recipient mismatch using correct index for TransferChecked", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeSplTransferChecked(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      expect(result.violations.some(v => v.type === "recipient_mismatch")).to.equal(true);
    });

    it("passes when TransferChecked destination matches declared", () => {
      const instructions = [
        makeIx(PHALNX),
        makeSplTransferChecked(SIGNER, DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      const recipientViolations = result.violations.filter(v => v.type === "recipient_mismatch");
      expect(recipientViolations).to.have.lengthOf(0);
    });
  });

  describe("Drift intent types (BUG-6)", () => {
    const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" as Address;

    it("driftPerpOrder does not trigger program mismatch for Drift program", () => {
      const instructions = [
        makeIx(COMPUTE_BUDGET),
        makeIx(PHALNX),
        makeIx(DRIFT),
        makeIx(PHALNX),
      ];
      const result = detectIntentDrift(intent("driftPerpOrder"), instructions, SIGNER);
      const programViolations = result.violations.filter(v => v.type === "program_mismatch");
      expect(programViolations).to.have.lengthOf(0);
    });

    it("driftDeposit does not trigger program mismatch", () => {
      const instructions = [makeIx(PHALNX), makeIx(DRIFT)];
      const result = detectIntentDrift(intent("driftDeposit"), instructions, SIGNER);
      const programViolations = result.violations.filter(v => v.type === "program_mismatch");
      expect(programViolations).to.have.lengthOf(0);
    });

    it("driftSpotOrder does not trigger program mismatch", () => {
      const instructions = [makeIx(PHALNX), makeIx(DRIFT)];
      const result = detectIntentDrift(intent("driftSpotOrder"), instructions, SIGNER);
      const programViolations = result.violations.filter(v => v.type === "program_mismatch");
      expect(programViolations).to.have.lengthOf(0);
    });
  });

  describe("enforceIntentDrift error code (BUG-8)", () => {
    it("ShieldDeniedError has code 7021 on high severity", () => {
      const instructions = [makeIx(UNKNOWN_PROGRAM)];
      try {
        enforceIntentDrift(intent("swap"), instructions, SIGNER);
        expect.fail("should throw");
      } catch (err) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect((err as ShieldDeniedError).code).to.equal(7021);
      }
    });
  });

  describe("amount=0 with non-zero transfer (BUG-13)", () => {
    it("flags amount mismatch when declared=0 but transfer exists", () => {
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, DEST, 500_000n),
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "0" }),
        instructions, SIGNER,
      );
      expect(result.violations.some(v => v.type === "amount_mismatch")).to.equal(true);
      expect(result.violations.some(v => v.message.includes("Declared amount is 0"))).to.equal(true);
    });

    it("no violation when declared=0 and no transfers", () => {
      const instructions = [makeIx(PHALNX)];
      const result = detectIntentDrift(
        intent("transfer", { amount: "0" }),
        instructions, SIGNER,
      );
      const amountViolations = result.violations.filter(v => v.type === "amount_mismatch");
      expect(amountViolations).to.have.lengthOf(0);
    });
  });

  describe("recipient check for deposit types (BUG-10)", () => {
    it("checks recipient for deposit intent", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("deposit", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      expect(result.violations.some(v => v.type === "recipient_mismatch")).to.equal(true);
    });

    it("checks recipient for kaminoDeposit intent", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("kaminoDeposit", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      expect(result.violations.some(v => v.type === "recipient_mismatch")).to.equal(true);
    });

    it("does not check recipient for swap intent", () => {
      const WRONG_DEST = "WrongDest111111111111111111111111111111111" as Address;
      const instructions = [
        makeIx(PHALNX),
        makeIx(JUPITER),
        makeSplTransfer(SIGNER, WRONG_DEST, 1_000_000n),
      ];
      const result = detectIntentDrift(
        intent("swap", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER,
      );
      const recipientViolations = result.violations.filter(v => v.type === "recipient_mismatch");
      expect(recipientViolations).to.have.lengthOf(0);
    });
  });

  describe("config overrides", () => {
    it("custom amountTolerancePct", () => {
      // 20% off should pass with 25% tolerance
      const instructions = [
        makeIx(PHALNX),
        makeSplTransfer(SIGNER, DEST, 1_200_000n),
      ];
      const result = detectIntentDrift(
        intent("transfer", { destination: DEST, amount: "1000000" }),
        instructions, SIGNER, { amountTolerancePct: 25 },
      );
      const amountViolations = result.violations.filter(v => v.type === "amount_mismatch");
      expect(amountViolations).to.have.lengthOf(0);
    });

    it("custom maxExtraInstructions", () => {
      const instructions = Array(20).fill(makeIx(PHALNX));
      const result = detectIntentDrift(intent("transfer"), instructions, SIGNER, { maxExtraInstructions: 20 });
      const countViolations = result.violations.filter(v => v.type === "instruction_count");
      // 20 instructions <= 6 + 20 = 26 threshold
      expect(countViolations).to.have.lengthOf(0);
    });
  });
});
