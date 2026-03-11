import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  verifyAdapterOutput,
  type VerifiableInstruction,
} from "../src/integrations/adapter-verifier.js";
import {
  createIntent,
  MemoryIntentStorage,
  DEFAULT_INTENT_TTL_MS,
  summarizeAction,
  type IntentAction,
} from "../src/intent-storage.js";
import {
  ProtocolRegistry,
} from "../src/integrations/protocol-registry.js";
import {
  isProtocolAllowed,
  resolveProtocol,
  ProtocolTier,
} from "../src/protocol-resolver.js";
import type {
  ProtocolHandler,
  ProtocolContext,
  ProtocolComposeResult,
} from "../src/integrations/protocol-handler.js";
import { ActionType } from "../src/generated/types/actionType.js";

// ─── Test Constants ──────────────────────────────────────────────────────────

const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const COMPUTE_BUDGET =
  "ComputeBudget111111111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

const VAULT_ADDRESS =
  "VaultXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as Address;
const AGENT_ADDRESS =
  "AgentYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY" as Address;
const FAKE_PROGRAM =
  "FakeProgramAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address;
const JUPITER_PROGRAM =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const DRIFT_PROGRAM =
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" as Address;
const UNKNOWN_PROGRAM =
  "UnknownProgramZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" as Address;
const ANOTHER_UNKNOWN =
  "AnotherUnknownWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW" as Address;

// ─── Mock handler factory ────────────────────────────────────────────────────

function createMockHandler(
  protocolId: string,
  displayName: string,
  programIds: Address[],
): ProtocolHandler {
  return {
    metadata: {
      protocolId,
      displayName,
      programIds,
      supportedActions: new Map([
        ["swap", { actionType: ActionType.Swap, isSpending: true }],
      ]),
    },
    async compose(
      _ctx: ProtocolContext,
      _action: string,
      _params: Record<string, unknown>,
    ): Promise<ProtocolComposeResult> {
      return { instructions: [] };
    },
    summarize(_action: string, _params: Record<string, unknown>): string {
      return `${protocolId} action`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER VERIFIER TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("adapter-verifier", () => {
  it("valid instructions with allowed programs pass", () => {
    const instructions: VerifiableInstruction[] = [
      {
        programAddress: FAKE_PROGRAM,
        accounts: [],
        data: new Uint8Array([1, 2, 3]),
      },
    ];
    const result = verifyAdapterOutput(
      instructions,
      [FAKE_PROGRAM],
      VAULT_ADDRESS,
    );
    expect(result.valid).to.be.true;
    expect(result.violations).to.have.length(0);
  });

  it("infrastructure programs (ComputeBudget, System) always allowed", () => {
    const instructions: VerifiableInstruction[] = [
      { programAddress: COMPUTE_BUDGET, data: new Uint8Array([0]) },
      { programAddress: SYSTEM_PROGRAM, data: new Uint8Array([0]) },
    ];
    const result = verifyAdapterOutput(instructions, [], VAULT_ADDRESS);
    expect(result.valid).to.be.true;
  });

  it("unauthorized program ID fails", () => {
    const instructions: VerifiableInstruction[] = [
      {
        programAddress: UNKNOWN_PROGRAM,
        data: new Uint8Array([1]),
      },
    ];
    const result = verifyAdapterOutput(
      instructions,
      [FAKE_PROGRAM],
      VAULT_ADDRESS,
    );
    expect(result.valid).to.be.false;
    expect(result.violations).to.have.length(1);
    expect(result.violations[0]).to.include("not in handler's programIds");
  });

  it("SPL transfer referencing vault detected as violation", () => {
    // Build a Transfer instruction: disc=3, 8 bytes amount
    const data = new Uint8Array(9);
    data[0] = 3; // Transfer discriminator
    const instructions: VerifiableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: "SourceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address },
          { address: "DestBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address },
          { address: VAULT_ADDRESS }, // authority is the vault
        ],
        data,
      },
    ];
    // TOKEN_PROGRAM_ID is not in allowed, but that's a separate violation
    // The vault reference should also trigger the drain detection
    const result = verifyAdapterOutput(instructions, [], VAULT_ADDRESS);
    expect(result.valid).to.be.false;
    const drainViolation = result.violations.find((v) =>
      v.includes("SPL Token transfer referencing vault"),
    );
    expect(drainViolation).to.not.be.undefined;
  });

  it("empty instructions pass", () => {
    const result = verifyAdapterOutput([], [FAKE_PROGRAM], VAULT_ADDRESS);
    expect(result.valid).to.be.true;
    expect(result.violations).to.have.length(0);
  });

  it("multiple violations collected", () => {
    const data = new Uint8Array(9);
    data[0] = 3; // Transfer
    const instructions: VerifiableInstruction[] = [
      { programAddress: UNKNOWN_PROGRAM, data: new Uint8Array([1]) },
      { programAddress: ANOTHER_UNKNOWN, data: new Uint8Array([2]) },
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: "SourceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address },
          { address: VAULT_ADDRESS },
          { address: VAULT_ADDRESS },
        ],
        data,
      },
    ];
    const result = verifyAdapterOutput(instructions, [], VAULT_ADDRESS);
    expect(result.valid).to.be.false;
    // 3 violations: 2 unauthorized programs + 1 vault drain
    expect(result.violations.length).to.be.gte(3);
  });

  it("non-transfer token instruction is not flagged as drain", () => {
    // Discriminator 1 = InitializeMint (not transfer)
    const data = new Uint8Array(9);
    data[0] = 1;
    const instructions: VerifiableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [{ address: VAULT_ADDRESS }],
        data,
      },
    ];
    // TOKEN_PROGRAM_ID not in allowed list, but that's expected
    const result = verifyAdapterOutput(instructions, [TOKEN_PROGRAM_ID], VAULT_ADDRESS);
    expect(result.valid).to.be.true;
    // Should not have any drain violation
    const drainViolation = result.violations.find((v) =>
      v.includes("SPL Token transfer"),
    );
    expect(drainViolation).to.be.undefined;
  });

  it("TransferChecked (disc=12) referencing vault also detected", () => {
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    const instructions: VerifiableInstruction[] = [
      {
        programAddress: TOKEN_PROGRAM_ID,
        accounts: [
          { address: "SourceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address },
          { address: "MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as Address },
          { address: VAULT_ADDRESS }, // destination is vault
          { address: AGENT_ADDRESS },
        ],
        data,
      },
    ];
    const result = verifyAdapterOutput(instructions, [], VAULT_ADDRESS);
    const drainViolation = result.violations.find((v) =>
      v.includes("SPL Token transfer referencing vault"),
    );
    expect(drainViolation).to.not.be.undefined;
  });

  it("ATA program is allowed as infrastructure", () => {
    const ATA_PROGRAM =
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
    const instructions: VerifiableInstruction[] = [
      { programAddress: ATA_PROGRAM, data: new Uint8Array([0]) },
    ];
    const result = verifyAdapterOutput(instructions, [], VAULT_ADDRESS);
    expect(result.valid).to.be.true;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTENT STORAGE TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("intent-storage", () => {
  const swapAction: IntentAction = {
    type: "swap",
    params: { inputMint: "USDC", outputMint: "SOL", amount: "100" },
  };

  it("createIntent returns valid TransactionIntent with UUID", () => {
    const intent = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    expect(intent.id).to.be.a("string");
    // UUID v4 format
    expect(intent.id).to.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(intent.status).to.equal("pending");
    expect(intent.vault).to.equal(VAULT_ADDRESS);
    expect(intent.agent).to.equal(AGENT_ADDRESS);
    expect(intent.expiresAt).to.equal(
      intent.createdAt + DEFAULT_INTENT_TTL_MS,
    );
    expect(intent.summary).to.be.a("string");
    expect(intent.summary.length).to.be.gt(0);
  });

  it("createIntent respects custom ttlMs", () => {
    const customTtl = 60_000;
    const intent = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS, {
      ttlMs: customTtl,
    });
    expect(intent.expiresAt).to.equal(intent.createdAt + customTtl);
  });

  it("MemoryIntentStorage save/get roundtrip", async () => {
    const storage = new MemoryIntentStorage();
    const intent = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    await storage.save(intent);
    const retrieved = await storage.get(intent.id);
    expect(retrieved).to.not.be.null;
    expect(retrieved!.id).to.equal(intent.id);
    expect(retrieved!.vault).to.equal(VAULT_ADDRESS);
    expect(retrieved!.status).to.equal("pending");
  });

  it("MemoryIntentStorage list with status filter", async () => {
    const storage = new MemoryIntentStorage();
    const i1 = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    const i2 = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    await storage.save(i1);
    await storage.save(i2);
    await storage.update(i2.id, { status: "executed" });

    const pending = await storage.list({ status: "pending" });
    expect(pending).to.have.length(1);
    expect(pending[0].id).to.equal(i1.id);
  });

  it("MemoryIntentStorage list with vault filter", async () => {
    const storage = new MemoryIntentStorage();
    const otherVault =
      "OtherVaultZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" as Address;
    const i1 = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    const i2 = createIntent(swapAction, otherVault, AGENT_ADDRESS);
    await storage.save(i1);
    await storage.save(i2);

    const filtered = await storage.list({ vault: VAULT_ADDRESS });
    expect(filtered).to.have.length(1);
    expect(filtered[0].vault).to.equal(VAULT_ADDRESS);
  });

  it("MemoryIntentStorage update changes status", async () => {
    const storage = new MemoryIntentStorage();
    const intent = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    await storage.save(intent);
    await storage.update(intent.id, {
      status: "approved",
      updatedAt: Date.now(),
    });
    const updated = await storage.get(intent.id);
    expect(updated!.status).to.equal("approved");
  });

  it("get for unknown id returns null", async () => {
    const storage = new MemoryIntentStorage();
    const result = await storage.get("nonexistent-id");
    expect(result).to.be.null;
  });

  it("clone is defensive (mutating original does not affect stored)", async () => {
    const storage = new MemoryIntentStorage();
    const intent = createIntent(swapAction, VAULT_ADDRESS, AGENT_ADDRESS);
    await storage.save(intent);

    // Mutate the original
    intent.status = "failed";
    (intent.action.params as Record<string, unknown>).inputMint = "MUTATED";

    const retrieved = await storage.get(intent.id);
    expect(retrieved!.status).to.equal("pending");
    expect((retrieved!.action.params as Record<string, unknown>).inputMint).to.equal("USDC");
  });

  it("summarizeAction produces readable output", () => {
    const freshAction: IntentAction = {
      type: "swap",
      params: { inputMint: "USDC", outputMint: "SOL", amount: "100" },
    };
    const summary = summarizeAction(freshAction);
    expect(summary).to.include("Swap");
    expect(summary).to.include("USDC");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PROTOCOL RESOLVER TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("protocol-resolver", () => {
  let registry: ProtocolRegistry;

  beforeEach(() => {
    registry = new ProtocolRegistry();
  });

  // --- isProtocolAllowed ---

  it("isProtocolAllowed mode=0 always true", () => {
    expect(
      isProtocolAllowed(FAKE_PROGRAM, { protocolMode: 0, protocols: [] }),
    ).to.be.true;
  });

  it("isProtocolAllowed mode=1 allowlist check — in list", () => {
    expect(
      isProtocolAllowed(JUPITER_PROGRAM, {
        protocolMode: 1,
        protocols: [JUPITER_PROGRAM],
      }),
    ).to.be.true;
  });

  it("isProtocolAllowed mode=1 allowlist check — not in list", () => {
    expect(
      isProtocolAllowed(DRIFT_PROGRAM, {
        protocolMode: 1,
        protocols: [JUPITER_PROGRAM],
      }),
    ).to.be.false;
  });

  it("isProtocolAllowed mode=2 denylist check — in list (denied)", () => {
    expect(
      isProtocolAllowed(UNKNOWN_PROGRAM, {
        protocolMode: 2,
        protocols: [UNKNOWN_PROGRAM],
      }),
    ).to.be.false;
  });

  it("isProtocolAllowed mode=2 denylist check — not in list (allowed)", () => {
    expect(
      isProtocolAllowed(JUPITER_PROGRAM, {
        protocolMode: 2,
        protocols: [UNKNOWN_PROGRAM],
      }),
    ).to.be.true;
  });

  // --- resolveProtocol ---

  it("resolveProtocol with registered T1 handler (jupiter)", () => {
    const handler = createMockHandler("jupiter", "Jupiter", [
      JUPITER_PROGRAM,
    ]);
    registry.register(handler);

    const resolution = resolveProtocol(
      JUPITER_PROGRAM,
      registry,
      { protocolMode: 0, protocols: [] },
      false,
    );
    expect(resolution.tier).to.equal(ProtocolTier.T1_API);
    expect(resolution.protocolId).to.equal("jupiter");
  });

  it("resolveProtocol with registered T2 handler (drift)", () => {
    const handler = createMockHandler("drift", "Drift Protocol", [
      DRIFT_PROGRAM,
    ]);
    registry.register(handler);

    const resolution = resolveProtocol(
      DRIFT_PROGRAM,
      registry,
      { protocolMode: 0, protocols: [] },
      false,
    );
    expect(resolution.tier).to.equal(ProtocolTier.T2_SDK);
    expect(resolution.protocolId).to.equal("drift");
  });

  it("resolveProtocol handler exists but not in allowlist", () => {
    const handler = createMockHandler("drift", "Drift Protocol", [
      DRIFT_PROGRAM,
    ]);
    registry.register(handler);

    const resolution = resolveProtocol(
      DRIFT_PROGRAM,
      registry,
      { protocolMode: 1, protocols: [JUPITER_PROGRAM] }, // allowlist without drift
      false,
    );
    expect(resolution.tier).to.equal(ProtocolTier.NOT_SUPPORTED);
    expect(resolution.escalation).to.not.be.undefined;
    expect(resolution.escalation!.type).to.equal("not_in_allowlist");
  });

  it("resolveProtocol no handler + constraints -> T4", () => {
    const resolution = resolveProtocol(
      UNKNOWN_PROGRAM,
      registry,
      { protocolMode: 0, protocols: [] },
      true, // constraints configured
    );
    expect(resolution.tier).to.equal(ProtocolTier.T4_PASSTHROUGH);
    expect(resolution.constraintsConfigured).to.be.true;
  });

  it("resolveProtocol no handler + no constraints -> NOT_SUPPORTED", () => {
    const resolution = resolveProtocol(
      UNKNOWN_PROGRAM,
      registry,
      { protocolMode: 0, protocols: [] },
      false,
    );
    expect(resolution.tier).to.equal(ProtocolTier.NOT_SUPPORTED);
    expect(resolution.escalation).to.not.be.undefined;
    expect(resolution.escalation!.type).to.equal("no_handler_no_constraints");
  });

  it("resolveProtocol no handler + not in allowlist -> NOT_SUPPORTED with alternatives", () => {
    // Register a handler so alternatives have something to return
    const jupHandler = createMockHandler("jupiter", "Jupiter", [
      JUPITER_PROGRAM,
    ]);
    registry.register(jupHandler);

    const resolution = resolveProtocol(
      UNKNOWN_PROGRAM,
      registry,
      { protocolMode: 1, protocols: [JUPITER_PROGRAM] },
      false,
    );
    expect(resolution.tier).to.equal(ProtocolTier.NOT_SUPPORTED);
    expect(resolution.escalation!.type).to.equal(
      "not_in_allowlist_and_no_handler",
    );
    expect(resolution.escalation!.alternatives).to.be.an("array");
    expect(resolution.escalation!.alternatives!.length).to.be.gte(1);
  });

  it("buildAlternatives returns registered protocols", () => {
    const h1 = createMockHandler("jupiter", "Jupiter", [JUPITER_PROGRAM]);
    const h2 = createMockHandler("drift", "Drift", [DRIFT_PROGRAM]);
    registry.register(h1);
    registry.register(h2);

    // Trigger path that calls buildAlternatives
    const resolution = resolveProtocol(
      UNKNOWN_PROGRAM,
      registry,
      { protocolMode: 0, protocols: [] },
      false,
    );
    const alts = resolution.escalation!.alternatives!;
    expect(alts).to.have.length(2);
    const ids = alts.map((a) => a.protocolId);
    expect(ids).to.include("jupiter");
    expect(ids).to.include("drift");
  });
});
