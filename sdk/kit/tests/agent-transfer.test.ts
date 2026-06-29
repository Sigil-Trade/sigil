import { expect } from "chai";
import type { Address } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import { buildAgentTransfer } from "../src/agent-transfer.js";
import { parseAgentTransferInstruction } from "../src/generated/instructions/agentTransfer.js";
import { deriveAta } from "../src/tokens.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";
import {
  SIGIL_PROGRAM_ADDRESS,
  PROTOCOL_TREASURY,
  USDC_MINT_DEVNET,
  USDT_MINT_DEVNET,
} from "../src/types.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import { createMockAgent, createMockVaultState } from "../src/testing/index.js";
import { createMockRpc } from "../src/testing/mock-rpc.js";

// ─── Test Addresses ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT_ADDR = "11111111111111111111111111111113" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;
const FEE_DEST = "11111111111111111111111111111115" as Address;
const DEST_WALLET = "11111111111111111111111111111116" as Address;
const TOKEN_MINT = USDC_MINT_DEVNET;
const POLICY_VERSION = 7n;
const AMOUNT = 100_000_000n; // $100 USDC

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockAgent() {
  return createMockAgent(AGENT_ADDR);
}

/**
 * Build a ResolvedVaultState with the destination allowlisted. The mock factory
 * defaults `allowedDestinations` to `[]` and exposes no override for it, so we
 * mutate the plain policy object directly (it is a read-only-path test fixture).
 */
function makeState(overrides?: {
  developerFeeRate?: number;
  stableBalanceFloor?: bigint;
  destinationMode?: number;
  allowedDestinations?: Address[];
  status?: VaultStatus;
  agentPaused?: boolean;
  agentCapability?: bigint;
}): ResolvedVaultState {
  const state = createMockVaultState({
    vault: VAULT,
    agent: AGENT_ADDR,
    owner: OWNER_ADDR,
    feeDestination: FEE_DEST,
    developerFeeRate: overrides?.developerFeeRate ?? 0,
    status: overrides?.status,
    agentPaused: overrides?.agentPaused,
    agentCapability: overrides?.agentCapability,
  });
  state.policy.policyVersion = POLICY_VERSION;
  state.policy.allowedDestinations = overrides?.allowedDestinations ?? [
    DEST_WALLET,
  ];
  state.policy.stableBalanceFloor = overrides?.stableBalanceFloor ?? 0n;
  state.policy.destinationMode = overrides?.destinationMode ?? 0;
  return state;
}

function baseOpts(state: ResolvedVaultState) {
  return {
    vault: VAULT,
    agent: mockAgent(),
    destination: DEST_WALLET,
    amount: AMOUNT,
    tokenMint: TOKEN_MINT,
    network: "devnet" as const,
    cachedState: state,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildAgentTransfer()", () => {
  it("composes an agent_transfer instruction for the Sigil program", async () => {
    const ix = await buildAgentTransfer(createMockRpc(), baseOpts(makeState()));
    expect(ix.programAddress).to.equal(SIGIL_PROGRAM_ADDRESS);
    expect(ix.accounts).to.be.an("array");
  });

  it("resolves the source, destination, and protocol-treasury ATAs in the right roles", async () => {
    const ix = await buildAgentTransfer(createMockRpc(), baseOpts(makeState()));
    const parsed = parseAgentTransferInstruction(ix as never);

    const [vaultAta, destAta, treasuryAta] = await Promise.all([
      deriveAta(VAULT, TOKEN_MINT),
      deriveAta(DEST_WALLET, TOKEN_MINT),
      deriveAta(PROTOCOL_TREASURY, TOKEN_MINT),
    ]);

    expect(parsed.accounts.agent.address).to.equal(AGENT_ADDR);
    expect(parsed.accounts.vault.address).to.equal(VAULT);
    expect(parsed.accounts.vaultTokenAccount.address).to.equal(vaultAta);
    expect(parsed.accounts.tokenMintAccount.address).to.equal(TOKEN_MINT);
    expect(parsed.accounts.destinationTokenAccount.address).to.equal(destAta);
    expect(parsed.accounts.protocolTreasuryTokenAccount?.address).to.equal(
      treasuryAta,
    );
  });

  it("fills expected_policy_version from the live policy", async () => {
    const ix = await buildAgentTransfer(createMockRpc(), baseOpts(makeState()));
    const parsed = parseAgentTransferInstruction(ix as never);
    expect(parsed.data.amount).to.equal(AMOUNT);
    expect(parsed.data.expectedPolicyVersion).to.equal(POLICY_VERSION);
  });

  it("omits the developer-fee account when developer_fee_rate is 0", async () => {
    const ix = await buildAgentTransfer(
      createMockRpc(),
      baseOpts(makeState({ developerFeeRate: 0 })),
    );
    const parsed = parseAgentTransferInstruction(ix as never);
    // Optional account omitted → builder fills the program id → parsed undefined.
    expect(parsed.accounts.feeDestinationTokenAccount).to.equal(undefined);
  });

  it("includes the developer-fee account when developer_fee_rate > 0", async () => {
    const ix = await buildAgentTransfer(
      createMockRpc(),
      baseOpts(makeState({ developerFeeRate: 100 })),
    );
    const parsed = parseAgentTransferInstruction(ix as never);
    const feeAta = await deriveAta(FEE_DEST, TOKEN_MINT);
    expect(parsed.accounts.feeDestinationTokenAccount?.address).to.equal(
      feeAta,
    );
  });

  it("appends the OTHER stablecoin vault ATA as a READONLY remaining account when the floor is armed", async () => {
    const ix = await buildAgentTransfer(
      createMockRpc(),
      baseOpts(makeState({ stableBalanceFloor: 50_000_000n })),
    );
    // 13 named accounts + 1 remaining (the USDT vault ATA, source is USDC).
    expect(ix.accounts).to.have.length(14);
    const usdtVaultAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const last = ix.accounts![13];
    expect(last.address).to.equal(usdtVaultAta);
    expect(last.role).to.equal(AccountRole.READONLY);
  });

  it("does NOT append a remaining account when the floor is disabled", async () => {
    const ix = await buildAgentTransfer(
      createMockRpc(),
      baseOpts(makeState({ stableBalanceFloor: 0n })),
    );
    expect(ix.accounts).to.have.length(13);
  });

  it("throws when the destination is not allowlisted", async () => {
    const state = makeState({ allowedDestinations: [] });
    try {
      await buildAgentTransfer(createMockRpc(), baseOpts(state));
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not in the vault's allowed destinations");
    }
  });

  it("throws on a non-stablecoin mint", async () => {
    try {
      await buildAgentTransfer(createMockRpc(), {
        ...baseOpts(makeState()),
        tokenMint: "So11111111111111111111111111111111111111112" as Address,
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("only moves stablecoins");
    }
  });

  it("throws on zero amount", async () => {
    try {
      await buildAgentTransfer(createMockRpc(), {
        ...baseOpts(makeState()),
        amount: 0n,
      });
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("must be > 0");
    }
  });

  it("throws on an inactive vault", async () => {
    try {
      await buildAgentTransfer(
        createMockRpc(),
        baseOpts(makeState({ status: VaultStatus.Frozen })),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("not active");
    }
  });

  it("throws on a paused agent", async () => {
    try {
      await buildAgentTransfer(
        createMockRpc(),
        baseOpts(makeState({ agentPaused: true })),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("paused");
    }
  });

  it("throws on an unsupported destination_mode", async () => {
    try {
      await buildAgentTransfer(
        createMockRpc(),
        baseOpts(makeState({ destinationMode: 1 })),
      );
      expect.fail("should throw");
    } catch (e: any) {
      expect(e.message).to.include("destination_mode");
    }
  });
});
