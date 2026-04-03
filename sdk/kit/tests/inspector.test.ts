import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  analyzeInstructions,
  inspectConstraints,
  type InspectableInstruction,
} from "../src/inspector.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const SIGNER = "SignerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address;
const OTHER_AUTHORITY =
  "OtherAuthBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address;
const SOURCE_ATA = "SourceATACCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as Address;
const DEST_ATA = "DestATADDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" as Address;
const MINT_ADDRESS = "MintEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE" as Address;
const FAKE_PROGRAM = "FakeProgramFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" as Address;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a u64 LE Uint8Array from a bigint */
function u64LE(value: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, value, true);
  return new Uint8Array(buf);
}

/** Build an SPL Transfer instruction data: [disc=3][amount u64 LE] */
function buildTransferData(amount: bigint): Uint8Array {
  const amountBytes = u64LE(amount);
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer discriminator
  data.set(amountBytes, 1);
  return data;
}

/** Build an SPL TransferChecked instruction data: [disc=12][amount u64 LE][decimals] */
function buildTransferCheckedData(
  amount: bigint,
  decimals: number,
): Uint8Array {
  const amountBytes = u64LE(amount);
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked discriminator
  data.set(amountBytes, 1);
  data[9] = decimals;
  return data;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("inspector", () => {
  it("extracts unique program IDs from instructions", () => {
    const instructions: InspectableInstruction[] = [
      { programAddress: FAKE_PROGRAM, data: new Uint8Array([1]) },
      { programAddress: COMPUTE_BUDGET, data: new Uint8Array([2]) },
      { programAddress: FAKE_PROGRAM, data: new Uint8Array([3]) }, // duplicate
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.programIds).to.have.length(2);
    expect(result.programIds).to.include(FAKE_PROGRAM);
    expect(result.programIds).to.include(COMPUTE_BUDGET);
  });

  it("detects SPL Transfer (discriminator 3)", () => {
    const amount = 1_000_000n; // 1 USDC
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(amount),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(1);
    expect(result.tokenTransfers[0].amount).to.equal(amount);
    expect(result.tokenTransfers[0].source).to.equal(SOURCE_ATA);
    expect(result.tokenTransfers[0].destination).to.equal(DEST_ATA);
    expect(result.tokenTransfers[0].authority).to.equal(SIGNER);
    expect(result.tokenTransfers[0].mint).to.be.null;
  });

  it("detects SPL TransferChecked (discriminator 12)", () => {
    const amount = 5_000_000n; // 5 USDC
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: MINT_ADDRESS },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferCheckedData(amount, 6),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(1);
    expect(result.tokenTransfers[0].amount).to.equal(amount);
    expect(result.tokenTransfers[0].mint).to.equal(MINT_ADDRESS);
    expect(result.tokenTransfers[0].source).to.equal(SOURCE_ATA);
    expect(result.tokenTransfers[0].destination).to.equal(DEST_ATA);
    expect(result.tokenTransfers[0].authority).to.equal(SIGNER);
  });

  it("parses amount correctly (u64 LE)", () => {
    // Test with a large amount: 10 billion (10_000_000_000)
    const amount = 10_000_000_000n;
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(amount),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers[0].amount).to.equal(amount);
  });

  it("multiple transfers summed for estimatedValue", () => {
    const amount1 = 1_000_000n;
    const amount2 = 2_000_000n;
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(amount1),
      },
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(amount2),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(2);
    expect(result.estimatedValue).to.equal(amount1 + amount2);
  });

  it("non-token programs ignored for transfers", () => {
    const instructions: InspectableInstruction[] = [
      {
        programAddress: FAKE_PROGRAM,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(1_000_000n), // looks like transfer data but wrong program
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(0);
    expect(result.estimatedValue).to.equal(0n);
  });

  it("empty instructions returns empty analysis", () => {
    const result = analyzeInstructions([], SIGNER);
    expect(result.programIds).to.have.length(0);
    expect(result.tokenTransfers).to.have.length(0);
    expect(result.estimatedValue).to.equal(0n);
  });

  it("Token 2022 transfers detected", () => {
    const amount = 3_000_000n;
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_2022_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: SIGNER },
        ],
        data: buildTransferData(amount),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(1);
    expect(result.tokenTransfers[0].amount).to.equal(amount);
    expect(result.programIds).to.include(TOKEN_2022_PROGRAM_ID);
  });

  it("authority check determines direction (outgoing vs incoming)", () => {
    const amount = 500_000n;
    const instructions: InspectableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: SOURCE_ATA },
          { address: DEST_ATA },
          { address: OTHER_AUTHORITY }, // NOT the signer
        ],
        data: buildTransferData(amount),
      },
    ];

    const result = analyzeInstructions(instructions, SIGNER);
    expect(result.tokenTransfers).to.have.length(1);
    // Authority is not the signer, so estimatedValue should NOT include this
    expect(result.estimatedValue).to.equal(0n);
  });
});

// ─── inspectConstraints ──────────────────────────────────────────────────────

describe("inspectConstraints", () => {
  it("formats data constraint with hex value", () => {
    const entries = [
      {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
        dataConstraints: [
          {
            offset: 0,
            operator: 0 /* == */,
            value: new Uint8Array([0xe5, 0x17, 0xcb, 0x98]),
          },
        ],
        accountConstraints: [],
      },
    ] as any[];

    const result = inspectConstraints(entries);
    expect(result).to.have.length(1);
    expect(result[0].programName).to.equal("Jupiter");
    expect(result[0].rules[0]).to.include("data[0..+4]");
    expect(result[0].rules[0]).to.include("0xe517cb98");
  });

  it("formats account constraint with address", () => {
    const entries = [
      {
        programId: "SomeProgram1111111111111111111111111111111" as Address,
        dataConstraints: [],
        accountConstraints: [
          {
            index: 2,
            expected: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
          },
        ],
      },
    ] as any[];

    const result = inspectConstraints(entries);
    expect(result).to.have.length(1);
    expect(result[0].rules[0]).to.include("account[2]");
    expect(result[0].rules[0]).to.include("JUP6Lk");
  });

  it("filters out entries with no rules", () => {
    const entries = [
      {
        programId: "Prog1" as Address,
        dataConstraints: [],
        accountConstraints: [],
      },
    ] as any[];

    const result = inspectConstraints(entries);
    expect(result).to.have.length(0);
  });

  it("uses correct operator name for != (operator 1)", () => {
    const entries = [
      {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
        dataConstraints: [
          {
            offset: 8,
            operator: 1 /* != */,
            value: new Uint8Array([0x00, 0x00]),
          },
        ],
        accountConstraints: [],
      },
    ] as any[];

    const result = inspectConstraints(entries);
    expect(result).to.have.length(1);
    expect(result[0].rules[0]).to.equal("data[8..+2] != 0x0000");
  });

  it("counts data and account constraints separately", () => {
    const entries = [
      {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
        dataConstraints: [
          { offset: 0, operator: 0, value: new Uint8Array([0xab]) },
          { offset: 4, operator: 2 /* < */, value: new Uint8Array([0xff]) },
        ],
        accountConstraints: [
          { index: 0, expected: "11111111111111111111111111111111" as Address },
        ],
      },
    ] as any[];

    const result = inspectConstraints(entries);
    expect(result[0].dataConstraintCount).to.equal(2);
    expect(result[0].accountConstraintCount).to.equal(1);
    expect(result[0].rules).to.have.length(3);
  });
});
