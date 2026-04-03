import { expect } from "chai";
import type { Address, TransactionSigner, Instruction } from "@solana/kit";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
} from "@solana/kit";
import {
  shield,
  createShieldedSigner,
  ShieldDeniedError,
  type ShieldedContext,
} from "../src/shield.js";
import type { InspectableInstruction } from "../src/inspector.js";
import { SIGIL_PROGRAM_ADDRESS } from "../src/generated/programs/sigil.js";
import { VALIDATE_AND_AUTHORIZE_DISCRIMINATOR } from "../src/generated/instructions/validateAndAuthorize.js";
import { FINALIZE_SESSION_DISCRIMINATOR } from "../src/generated/instructions/finalizeSession.js";

// ─── Test Constants ────────────────────────────────────────────────────────

const SIGNER_ADDRESS = "SignerAddr1111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const JUPITER_PROGRAM =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const UNKNOWN_PROGRAM = "UnknownProg111111111111111111111111111111" as Address;

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTransferIx(
  amount: bigint,
  authority: Address,
): InspectableInstruction {
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer discriminator
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amount, true);
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: "Source11111111111111111111111111111111111111" as Address },
      { address: "Dest1111111111111111111111111111111111111111" as Address },
      { address: authority },
    ],
    data,
  };
}

function noopIx(programAddress: Address): InspectableInstruction {
  return { programAddress, accounts: [], data: new Uint8Array() };
}

/**
 * Build a mock compiled transaction object that matches the shape
 * produced by @solana/kit's compileTransaction().
 */
function buildCompiledTx(
  instructions: InspectableInstruction[],
  feePayer: Address = SIGNER_ADDRESS,
): any {
  // Collect all unique addresses into staticAccounts
  const addressSet = new Set<string>([feePayer]);
  for (const ix of instructions) {
    addressSet.add(ix.programAddress);
    for (const acc of ix.accounts ?? []) {
      addressSet.add(acc.address);
    }
  }
  const staticAccounts = Array.from(addressSet) as Address[];
  const addrIndex = (addr: string) => staticAccounts.indexOf(addr as Address);

  const compiledInstructions = instructions.map((ix) => ({
    programAddressIndex: addrIndex(ix.programAddress),
    accountIndices: (ix.accounts ?? []).map((a) => addrIndex(a.address)),
    data: ix.data ?? new Uint8Array(),
  }));

  return {
    compiledMessage: {
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 0,
      },
      staticAccounts,
      instructions: compiledInstructions,
      lifetimeToken: "mockblockhash",
      version: 0,
    },
    messageBytes: new Uint8Array([0, 1, 2, 3]), // Minimal stub
    signatures: {},
  };
}

/**
 * Build a compiled TX with Sigil validate+finalize sandwich.
 */
function buildSandwichTx(defiIxs: InspectableInstruction[]): any {
  // validate_and_authorize instruction
  const validateData = new Uint8Array(32);
  validateData.set(VALIDATE_AND_AUTHORIZE_DISCRIMINATOR, 0);
  const validateIx: InspectableInstruction = {
    programAddress: SIGIL_PROGRAM_ADDRESS,
    accounts: [],
    data: validateData,
  };

  // finalize_session instruction
  const finalizeData = new Uint8Array(16);
  finalizeData.set(FINALIZE_SESSION_DISCRIMINATOR, 0);
  const finalizeIx: InspectableInstruction = {
    programAddress: SIGIL_PROGRAM_ADDRESS,
    accounts: [],
    data: finalizeData,
  };

  return buildCompiledTx([
    noopIx(COMPUTE_BUDGET),
    validateIx,
    ...defiIxs,
    finalizeIx,
  ]);
}

/**
 * Create a mock base signer that tracks signing calls.
 */
function createMockSigner(address: Address = SIGNER_ADDRESS): {
  signer: TransactionSigner;
  signCalls: any[][];
} {
  const signCalls: any[][] = [];
  return {
    signCalls,
    signer: {
      address,
      async modifyAndSignTransactions(
        txs: readonly any[],
      ): Promise<readonly any[]> {
        signCalls.push([...txs]);
        return txs.map((tx: any) => ({
          ...tx,
          signatures: { [address]: new Uint8Array(64).fill(0xee) },
        }));
      },
    } as TransactionSigner,
  };
}

/**
 * Create a mock partial signer (signTransactions only, no modifyAndSign).
 */
function createMockPartialSigner(address: Address = SIGNER_ADDRESS): {
  signer: TransactionSigner;
  signCalls: any[][];
} {
  const signCalls: any[][] = [];
  return {
    signCalls,
    signer: {
      address,
      async signTransactions(
        txs: readonly any[],
      ): Promise<readonly Record<string, Uint8Array>[]> {
        signCalls.push([...txs]);
        return txs.map(() => ({ [address]: new Uint8Array(64).fill(0xdd) }));
      },
    } as TransactionSigner,
  };
}

// Valid Solana addresses for simulation tests (real base58 32-byte addresses)
const SIM_SIGNER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const SIM_BLOCKHASH = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as any;

/**
 * Build a real compiled transaction that getBase64EncodedWireTransaction can encode.
 * Required for simulation tests (Property 3).
 * Uses only valid base58 Solana addresses.
 */
function buildRealCompiledTx(): any {
  const kitIxs: Instruction[] = [
    {
      programAddress: SYSTEM_PROGRAM,
      accounts: [],
      data: new Uint8Array(),
    },
  ];

  const txMsg = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(SIM_SIGNER, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: SIM_BLOCKHASH,
          lastValidBlockHeight: 1000n,
        },
        tx,
      ),
    (tx) => appendTransactionMessageInstructions(kitIxs, tx),
  );

  return compileTransaction(txMsg as any);
}

/**
 * Create a mock RPC for simulation.
 */
function createMockRpc(opts: { success: boolean; error?: string }) {
  return {
    simulateTransaction: () => ({
      send: async () => ({
        value: opts.success
          ? { err: null, logs: [], unitsConsumed: 200_000 }
          : {
              err: opts.error ?? "SimError",
              logs: ["Error: custom program error: 0x1771"],
            },
      }),
    }),
  } as any;
}

/**
 * Create a failing mock RPC (network error).
 */
function createFailingRpc() {
  return {
    simulateTransaction: () => ({
      send: async () => {
        throw new Error("Network timeout");
      },
    }),
  } as any;
}

// Capture console.warn for SOFT check tests
function captureWarns(fn: () => any): { warnings: string[]; result: any } {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => warnings.push(args.join(" "));
  let result: any;
  try {
    result = fn();
  } finally {
    console.warn = origWarn;
  }
  return { warnings, result };
}

async function captureWarnsAsync(
  fn: () => Promise<any>,
): Promise<{ warnings: string[]; result: any }> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => warnings.push(args.join(" "));
  let result: any;
  try {
    result = await fn();
  } finally {
    console.warn = origWarn;
  }
  return { warnings, result };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createShieldedSigner", () => {
  // ─── Baseline ────────────────────────────────────────────────────────

  describe("baseline", () => {
    it("returns TransactionSigner with correct address", () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx);

      expect(shielded.address).to.equal(SIGNER_ADDRESS);
    });

    it("delegates to base signer when all checks pass", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      const results = await shielded.modifyAndSignTransactions([tx]);

      expect(signCalls).to.have.length(1);
      expect(results).to.have.length(1);
      expect(results[0].signatures).to.have.property(SIGNER_ADDRESS);
    });

    it("shares state with ShieldedContext (spend/tx accumulates)", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);

      expect(shieldCtx.state.getTransactionCountInWindow(60_000)).to.equal(1);
    });
  });

  // ─── Property 1: Intent Correspondence (SOFT) ───────────────────────

  describe("property 1 — intent correspondence (SOFT)", () => {
    it("no-op when no intentContext provided (passes through)", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });
  });

  // ─── Property 2: Velocity Ceiling (HARD) ────────────────────────────

  describe("property 2 — velocity ceiling (HARD)", () => {
    it("throws ShieldDeniedError when maxTxPerHour exceeded", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield();
      // Pre-fill state with transactions
      for (let i = 0; i < 5; i++) {
        shieldCtx.state.recordTransaction();
      }

      const shielded = createShieldedSigner(signer, shieldCtx, {
        velocityThresholds: { maxTxPerHour: 5 },
      }) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("velocity_ceiling");
        expect(err.violations[0].message).to.include("per hour exceeded");
      }
    });

    it("throws ShieldDeniedError when maxUsdPerHour exceeded", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield();
      // Pre-fill spend state
      shieldCtx.state.recordSpend("", 900_000n);

      const shielded = createShieldedSigner(signer, shieldCtx, {
        velocityThresholds: { maxUsdPerHour: 1_000_000n },
      }) as any;

      // TX with a transfer that pushes over the ceiling
      const tx = buildCompiledTx([buildTransferIx(200_000n, SIGNER_ADDRESS)]);
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("velocity_ceiling");
        expect(err.violations[0].message).to.include("exceeds ceiling");
      }
    });

    it("passes when under thresholds", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();

      const shielded = createShieldedSigner(signer, shieldCtx, {
        velocityThresholds: { maxTxPerHour: 100, maxUsdPerHour: 10_000_000n },
      }) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });
  });

  // ─── Property 3: Simulation Liveness (HARD) ─────────────────────────

  describe("property 3 — simulation liveness (HARD)", () => {
    it("passes when simulation succeeds", async () => {
      const { signer, signCalls } = createMockSigner(SIM_SIGNER);
      const shieldCtx = shield();
      const rpc = createMockRpc({ success: true });

      const shielded = createShieldedSigner(signer, shieldCtx, { rpc }) as any;

      const tx = buildRealCompiledTx();
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });

    it("throws ShieldDeniedError when simulation fails", async () => {
      const { signer } = createMockSigner(SIM_SIGNER);
      const shieldCtx = shield();
      const rpc = createMockRpc({ success: false, error: "InstructionError" });

      const shielded = createShieldedSigner(signer, shieldCtx, { rpc }) as any;

      const tx = buildRealCompiledTx();
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("simulation");
      }
    });

    it("throws ShieldDeniedError on simulation network error (fail-closed)", async () => {
      const { signer } = createMockSigner(SIM_SIGNER);
      const shieldCtx = shield();
      const rpc = createFailingRpc();

      const shielded = createShieldedSigner(signer, shieldCtx, { rpc }) as any;

      const tx = buildRealCompiledTx();
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("simulation");
      }
    });

    it("skips simulation when skipSimulation=true", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const rpc = createMockRpc({ success: false }); // Would fail if called

      const shielded = createShieldedSigner(signer, shieldCtx, {
        rpc,
        skipSimulation: true,
      }) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });
  });

  // ─── Property 4: Instruction Allowlist (HARD) ───────────────────────

  describe("property 4 — instruction allowlist (HARD)", () => {
    it("passes when all programs in allowlist", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield({
        blockUnknownPrograms: true,
        allowedProtocols: [JUPITER_PROGRAM],
      });

      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(JUPITER_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });

    it("throws ShieldDeniedError for unknown programs", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield({
        blockUnknownPrograms: true,
        allowedProtocols: [JUPITER_PROGRAM],
      });

      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(UNKNOWN_PROGRAM)]);
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("program_allowlist");
      }
    });

    it("system programs always pass (ComputeBudget, System, ATA)", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield({
        blockUnknownPrograms: true,
        allowedProtocols: [],
      });

      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([
        noopIx(SYSTEM_PROGRAM),
        noopIx(COMPUTE_BUDGET),
        noopIx("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address),
      ]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });

    it("spend limit check from ShieldedContext carries through", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield({
        maxSpend: { mint: "", amount: 100_000n },
      });
      // Pre-fill spend to near limit
      shieldCtx.state.recordSpend("", 90_000n);

      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      // Transfer that pushes over the spend limit
      const tx = buildCompiledTx([buildTransferIx(20_000n, SIGNER_ADDRESS)]);
      try {
        await shielded.modifyAndSignTransactions([tx]);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.be.instanceOf(ShieldDeniedError);
        expect(err.violations[0].rule).to.equal("spend_limit");
      }
    });
  });

  // ─── Property 5: Session Binding (SOFT) ─────────────────────────────

  describe("property 5 — session binding (SOFT)", () => {
    it("no-op when no sessionContext provided", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });

    it("logs warning when sandwich missing (does NOT throw)", async () => {
      const { signer } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx, {
        sessionContext: {
          sessionPda: "SessionPDA111111111111111111111111111111111" as Address,
          expirySlot: 1000n,
        },
        sessionBindingSeverity: "soft",
      }) as any;

      // TX without Sigil instructions — missing sandwich
      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      const { warnings } = await captureWarnsAsync(() =>
        shielded.modifyAndSignTransactions([tx]),
      );

      expect(warnings.some((w) => w.includes("No Sigil instructions"))).to.be
        .true;
    });

    it("passes when validate+finalize sandwich present", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx, {
        sessionContext: {
          sessionPda: "SessionPDA111111111111111111111111111111111" as Address,
          expirySlot: 1000n,
        },
      }) as any;

      const tx = buildSandwichTx([noopIx(JUPITER_PROGRAM)]);
      const { warnings } = await captureWarnsAsync(() =>
        shielded.modifyAndSignTransactions([tx]),
      );

      expect(signCalls).to.have.length(1);
      expect(
        warnings.filter((w) => w.includes("Session binding")),
      ).to.have.length(0);
    });
  });

  // ─── Signer Delegation ──────────────────────────────────────────────

  describe("signer delegation", () => {
    it("delegates to modifyAndSignTransactions when available", async () => {
      const { signer, signCalls } = createMockSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      await shielded.modifyAndSignTransactions([tx]);
      expect(signCalls).to.have.length(1);
    });

    it("delegates to signTransactions for partial signers", async () => {
      const { signer, signCalls } = createMockPartialSigner();
      const shieldCtx = shield();
      const shielded = createShieldedSigner(signer, shieldCtx) as any;

      const tx = buildCompiledTx([noopIx(SYSTEM_PROGRAM)]);
      const results = await shielded.modifyAndSignTransactions([tx]);

      expect(signCalls).to.have.length(1);
      expect(results[0].signatures).to.have.property(SIGNER_ADDRESS);
    });
  });
});
