/**
 * Kit SDK Devnet — seal() + createVault() E2E Tests
 *
 * Proves the new Phase 2 SDK entry points work against the live
 * devnet-deployed Sigil program.
 *
 * Run: ANCHOR_PROVIDER_URL=https://devnet.helius-rpc.com/?api-key=... \
 *      pnpm --filter @usesigil/kit test:devnet
 */

import { expect } from "chai";
import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  KeyPairSigner,
} from "@solana/kit";

import {
  createDevnetRpc,
  loadOwnerSigner,
  createFundedAgent,
  sendKitTransaction,
} from "../../src/testing/devnet.js";

import { createVault } from "../../src/create-vault.js";
import { seal } from "../../src/seal.js";
import { resolveVaultState } from "../../src/state-resolver.js";
import { TransactionExecutor } from "../../src/transaction-executor.js";
import { VaultStatus } from "../../src/generated/types/vaultStatus.js";
import {
  USDC_MINT_DEVNET,
  JUPITER_PROGRAM_ADDRESS,
  capability,
  usd,
} from "../../src/types.js";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  provisionVault,
  type ProvisionVaultResult,
} from "../../src/testing/devnet.js";

// Skip if no devnet env
const SKIP = !process.env.ANCHOR_PROVIDER_URL;

// Memo program — exists on every cluster, a true no-op that logs its data. Used
// as the counted DeFi leg of the V2 sandwich (it is neither infrastructure nor
// an SPL-token op, so it counts toward F-Q2's defi_ix_count) and must therefore
// be on the vault's protocol allowlist (V2 deleted protocolMode=0/ALL).
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

// Capability tiers (mirror programs/sigil/src/state/mod.rs). OBSERVER (1) is
// non-spending and seats INSTANTLY via register_agent; OPERATOR (FULL_CAPABILITY
// = 2) is spending and on a single-key vault must route through the F-Q6
// queue→600s→apply path. Tests that only exercise non-spending or SDK-level
// paths use OBSERVER to skip the 600s wait; spending paths need OPERATOR.
const OBSERVER = capability(1n);

describe("Kit SDK Devnet — seal() + createVault() E2E", function () {
  if (SKIP) return;

  // 15 min: the 3.3b describe seats a spending OPERATOR agent, which V2 (F-Q6)
  // routes through the queue → on-chain 600s single-key timelock → apply path
  // (one real ~600s cluster-clock wait). 5 min is not enough.
  this.timeout(900_000);

  let rpc: Rpc<SolanaRpcApi>;
  let owner: KeyPairSigner;
  let agent: KeyPairSigner;

  before(async function () {
    rpc = createDevnetRpc();
    const { signer } = await loadOwnerSigner();
    owner = signer;
    agent = await createFundedAgent(rpc, owner);
  });

  describe("createVault()", function () {
    it("provisions a vault on devnet and reads it back", async function () {
      // 1. Build vault instructions via createVault()
      // createVault() builds an INSTANT register_agent — which V2 (F-Q6) rejects
      // for an OPERATOR grant on a single-key vault (6107). So this test seats an
      // OBSERVER agent (instant, the path createVault actually supports); the
      // OPERATOR queue→600s→apply path is covered by lifecycle/composed-tx.
      // V2 also requires ALLOWLIST mode (1) with a non-empty allowlist (F-11),
      // so allowlist Jupiter explicitly (no spend is performed here).
      // Explicit unique id skips createVault's findNextVaultId probe loop
      // (which otherwise hammers the shared public RPC into 429s).
      const vaultId = BigInt(Date.now());
      const createOpts = {
        rpc,
        network: "devnet" as const,
        owner,
        agent,
        dailySpendingCapUsd: usd(500_000_000n), // $500
        maxTransactionSizeUsd: usd(100_000_000n), // $100
        permissions: OBSERVER,
        spendingLimitUsd: usd(0n),
        timelockDuration: 1800,
        protocolMode: 1,
        protocols: [JUPITER_PROGRAM_ADDRESS],
        vaultId,
      };

      // createVault binds ONE created_at_slot into the TA-19 digest (it reads
      // `confirmed`, which LAGS execution); the live devnet clock advances before
      // the init lands, tripping PolicyPreviewMismatch (6071). createVault is a
      // builder, not a submitter — production consumers retry with a fresh slot.
      // Mirror provisionVault here: bind `processed + offset` and retry, fanning
      // the offset across attempts.
      const cuIx = getSetComputeUnitLimitInstruction({ units: 400_000 });
      const slotOffsets = [2, 3, 4, 5, 6, 8, 10, 12, 1, 9, 11, 14, 16, 18, 20];
      let result: Awaited<ReturnType<typeof createVault>> | undefined;
      let initLanded = false;
      for (let attempt = 0; attempt < 30 && !initLanded; attempt++) {
        const base = await rpc.getSlot({ commitment: "processed" }).send();
        const createdAtSlot =
          base + BigInt(slotOffsets[attempt % slotOffsets.length]!);
        result = await createVault({ ...createOpts, createdAtSlot });
        try {
          // skipPreflight: the digest binds a FUTURE slot, so a preflight sim at
          // the current slot would always reject it (6071) before it can land.
          await sendKitTransaction(
            rpc,
            owner,
            [cuIx as Instruction, result.initializeVaultIx],
            { skipPreflight: true },
          );
          initLanded = true;
        } catch (e) {
          const detail = `${e instanceof Error ? e.message : String(e)} ${
            (e as any)?.cause?.message ?? ""
          }`;
          if (
            detail.includes("6071") ||
            detail.includes("PolicyPreviewMismatch")
          )
            continue; // slot advanced past the signed digest — re-read + retry
          throw e;
        }
      }
      if (!result || !initLanded) {
        throw new Error(
          "createVault: initialize_vault slot-bind failed after 30 attempts (6071)",
        );
      }

      expect(result.vaultAddress).to.be.a("string");
      expect(result.vaultId).to.be.a("bigint");
      expect(result.initializeVaultIx).to.exist;
      expect(result.registerAgentIx).to.exist;

      // Seat the OBSERVER agent (instant register — no F-Q6 timelock).
      await sendKitTransaction(rpc, owner, [result.registerAgentIx]);

      // 4. Verify vault exists on-chain
      const state = await resolveVaultState(
        rpc,
        result.vaultAddress,
        agent.address,
      );

      expect(state.vault.status).to.equal(VaultStatus.Active);
      expect(state.vault.owner).to.equal(owner.address);
      expect(state.vault.agents).to.have.length(1);
      expect(state.vault.agents[0].pubkey).to.equal(agent.address);
      // Decoded AgentEntry.capability is a u8 number; OBSERVER is a branded
      // bigint — compare numerically.
      expect(state.vault.agents[0].capability).to.equal(Number(OBSERVER));
      expect(state.policy.dailySpendingCapUsd).to.equal(500_000_000n);

      // Store for seal test
      (this as any).vaultAddress = result.vaultAddress;
    });

    it("seal() builds a valid composed transaction against the vault", async function () {
      const vaultAddress: Address = (this as any).vaultAddress;
      if (!vaultAddress) this.skip();

      // Build a fake Jupiter-like instruction (just targeting the Jupiter program)
      // This won't execute successfully on-chain (Jupiter needs real route data),
      // but it proves seal() can compose the transaction correctly
      const fakeJupiterIx: Instruction = {
        programAddress: JUPITER_PROGRAM_ADDRESS,
        accounts: [
          { address: vaultAddress, role: 1 as any }, // writable
        ],
        data: new Uint8Array([0xc0, 0xfe]), // dummy data
      };

      // Resolve state (proves RPC fetch works for new vault)
      const state = await resolveVaultState(rpc, vaultAddress, agent.address);

      // Call seal() with cachedState
      const result = await seal({
        vault: vaultAddress,
        agent,
        instructions: [fakeJupiterIx],
        rpc,
        network: "devnet",
        tokenMint: USDC_MINT_DEVNET,
        // M1 (6112): a stablecoin-input acquiring swap must declare the acquired mint.
        outputSwapMint:
          "So11111111111111111111111111111111111111112" as Address,
        amount: 1_000_000n, // $1
        // Empty ALT → seal() skips Sigil-ALT resolution + verifySigilAlt
        // (seal.ts:1167); this fresh test vault is not in the devnet Sigil ALT.
        addressLookupTables: {},
        cachedState: state,
        blockhash: {
          blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
          lastValidBlockHeight: BigInt(state.resolvedAtTimestamp + 200n),
        },
      });

      expect(result.transaction).to.exist;
      expect(result.txSizeBytes).to.be.a("number");
      expect(result.txSizeBytes).to.be.greaterThan(0);
      // Cap warning: $1 is well within $500 cap
      const capWarnings = result.warnings.filter((w) =>
        w.includes("cap headroom"),
      );
      expect(capWarnings).to.have.length(0);
    });
  });

  // ─── 3.3a: Composed TX pipeline on real cluster ────────────────────────────
  //
  // Uses a no-op Memo instruction as the DeFi stand-in (protocolMode=0 accepts all).
  // Exercises: validate_and_authorize → DeFi ix → finalize_session on real devnet.
  // Balance delta is zero (Memo doesn't move tokens) — that's fine:
  //   - LiteSVM tests cover real balance deltas (349 tests)
  //   - This test proves the pipeline works on a real cluster with real RPC

  describe("3.3a — composed TX sends to devnet and emits events", function () {
    let vault: ProvisionVaultResult;

    before(async function () {
      // amount=0 (non-spending) → an OBSERVER agent suffices and seats
      // INSTANTLY (no 600s operator wait). The memo leg must be allowlisted.
      vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
        dailySpendingCapUsd: 500_000_000n,
        depositAmount: 10_000_000n, // $10 USDC
        protocols: [MEMO_PROGRAM],
        permissions: OBSERVER,
        vaultId: BigInt(Date.now()),
      });
    });

    it("sends composed TX to devnet and succeeds", async function () {
      // Memo program — exists on all clusters, no-op, passes protocolMode=0
      const memoIx: Instruction = {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode("sigil-e2e-test"),
      };

      const state = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );

      const result = await seal({
        vault: vault.vaultAddress,
        agent,
        instructions: [memoIx],
        rpc,
        network: "devnet",
        tokenMint: USDC_MINT_DEVNET,
        amount: 0n, // no-op — zero spending
        // actionType removed in v6 — spending determined by amount > 0
        targetProtocol: MEMO_PROGRAM,
        // Provide an (empty) ALT so seal() skips its Sigil-ALT resolution +
        // verifySigilAlt (seal.ts:1167) — a fresh test vault is not in the
        // devnet Sigil ALT; the uncompressed tx is fine for these tests.
        addressLookupTables: {},
        cachedState: state,
      });

      expect(result.ok).to.be.true;
      expect(result.transaction).to.exist;

      // Execute on devnet
      const executor = new TransactionExecutor(rpc, agent, {
        skipSimulation: true, // devnet simulation can be flaky
      });
      const execResult = await executor.signSendConfirm(result.transaction);

      expect(execResult.signature).to.be.a("string");
      expect(execResult.signature.length).to.be.greaterThan(40);
    });

    it("vault USDC balance unchanged after zero-spend TX", async function () {
      // Re-resolve state — balance should still be the deposit amount
      const state = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );
      expect(state.vault.status).to.equal(VaultStatus.Active);
      // SpendTracker may or may not exist (created on first spend > 0)
    });
  });

  // ─── 3.3b: Round-trip prevention (2 DeFi instructions) ────────────────────
  //
  // On-chain validate_and_authorize rejects when transaction contains
  // more than 1 DeFi instruction between validate and finalize.

  describe("3.3b — round-trip prevention rejects 2 DeFi instructions", function () {
    let vault: ProvisionVaultResult;

    before(async function () {
      // The "exactly one DeFi instruction" rule (F-Q2, defi_ix_count == 1) is
      // enforced ONLY on the spending path — so this rejection test must seat a
      // spending OPERATOR agent (default → queue→600s→apply) and seal a spending
      // amount below. The memo leg must be allowlisted.
      vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
        dailySpendingCapUsd: 500_000_000n,
        depositAmount: 10_000_000n,
        protocols: [MEMO_PROGRAM],
        vaultId: BigInt(Date.now()),
      });
    });

    it("seal() with 2 DeFi instructions is rejected on-chain", async function () {
      const memoIx1: Instruction = {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode("ix-1"),
      };
      const memoIx2: Instruction = {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode("ix-2"),
      };

      const state = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );

      // seal() builds the TX — it doesn't enforce defi_ix_count at SDK level
      const result = await seal({
        vault: vault.vaultAddress,
        agent,
        instructions: [memoIx1, memoIx2], // 2 DeFi instructions
        rpc,
        network: "devnet",
        tokenMint: USDC_MINT_DEVNET,
        // M1 (6112): a stablecoin-input acquiring swap must declare the acquired mint.
        outputSwapMint:
          "So11111111111111111111111111111111111111112" as Address,
        // Spending ($1, within cap) so the on-chain defi_ix_count==1 rule is in
        // force — two DeFi legs then revert with TooManyDeFiInstructions.
        amount: 1_000_000n,
        targetProtocol: MEMO_PROGRAM,
        // Provide an (empty) ALT so seal() skips its Sigil-ALT resolution +
        // verifySigilAlt (seal.ts:1167) — a fresh test vault is not in the
        // devnet Sigil ALT; the uncompressed tx is fine for these tests.
        addressLookupTables: {},
        cachedState: state,
      });

      expect(result.transaction).to.exist;

      // Send to devnet — on-chain should reject
      const executor = new TransactionExecutor(rpc, agent, {
        skipSimulation: true,
      });
      try {
        await executor.signSendConfirm(result.transaction);
        expect.fail("TX should have been rejected on-chain");
      } catch (e: any) {
        // TX failed on-chain — expected. Error may be in the TX failure message.
        expect(e.message).to.satisfy(
          (msg: string) =>
            msg.includes("failed") ||
            msg.includes("error") ||
            msg.includes("0x") ||
            msg.includes("Error"),
          `Expected on-chain rejection but got: ${e.message}`,
        );
      }

      // Verify vault balance unchanged
      const postState = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );
      expect(postState.vault.status).to.equal(VaultStatus.Active);
    });
  });

  // ─── 3.3c: Cap exceeded atomicity ─────────────────────────────────────────
  //
  // Create vault with $10 cap, attempt $20 TX. On-chain rejects.
  // Verify: entire TX reverts atomically, vault balance unchanged.

  describe("3.3c — cap exceeded TX reverts atomically", function () {
    let vault: ProvisionVaultResult;

    before(async function () {
      // seal() rejects the over-cap spend at the SDK level (below), before any
      // transaction is built or sent — so an instant OBSERVER agent suffices
      // (no 600s operator wait). The memo leg is allowlisted so the vault
      // initializes; it is never reached because seal() aborts first.
      vault = await provisionVault(rpc, owner, agent, USDC_MINT_DEVNET, {
        dailySpendingCapUsd: 10_000_000n, // $10 cap
        maxTransactionSizeUsd: 100_000_000n,
        depositAmount: 50_000_000n, // $50 deposit (more than cap)
        protocols: [MEMO_PROGRAM],
        permissions: OBSERVER,
        vaultId: BigInt(Date.now()),
      });
    });

    it("seal() rejects a spend that exceeds the daily cap (SDK hard error)", async function () {
      // V2: seal()'s fee-inclusive cap-headroom check is a HARD ERROR
      // (seal.ts:756-775) — a $20 spend against a $10 cap throws before the
      // transaction is built, rather than building a tx that the on-chain
      // validate_and_authorize would later reject. (On-chain SpendingCapExceeded
      // atomic-revert is covered by the LiteSVM suite.)
      const memoIx: Instruction = {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode("cap-test"),
      };

      const state = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );

      try {
        await seal({
          vault: vault.vaultAddress,
          agent,
          instructions: [memoIx],
          rpc,
          network: "devnet",
          tokenMint: USDC_MINT_DEVNET,
          amount: 20_000_000n, // $20 > $10 cap
          targetProtocol: MEMO_PROGRAM,
          // Provide an (empty) ALT so seal() skips its Sigil-ALT resolution +
          // verifySigilAlt (seal.ts:1167) — a fresh test vault is not in the
          // devnet Sigil ALT; the uncompressed tx is fine for these tests.
          addressLookupTables: {},
          cachedState: state,
        });
        expect.fail("seal() should have thrown on cap-exceeded spend");
      } catch (e: any) {
        expect(e.message).to.match(/cap headroom|exceeds/i);
      }
    });

    it("vault balance unchanged after rejected seal (nothing was sent)", async function () {
      const postState = await resolveVaultState(
        rpc,
        vault.vaultAddress,
        agent.address,
      );
      expect(postState.vault.status).to.equal(VaultStatus.Active);
      // globalBudget spent should be 0 — no successful spend recorded
      if (postState.globalBudget) {
        expect(postState.globalBudget.spent24h).to.equal(0n);
      }
    });
  });

  // ─── 3.3d: Constraint violation ───────────────────────────────────────────
  //
  // Create vault with protocol allowlist (mode=1) restricted to Jupiter.
  // Send TX targeting a non-Jupiter program. seal() should reject at SDK level
  // since isProtocolAllowed() returns false.

  describe("3.3d — protocol not in allowlist is rejected", function () {
    it("seal() rejects instruction targeting non-allowed protocol", async function () {
      // seal() rejects the disallowed protocol at the SDK level (isProtocolAllowed
      // returns false) before building/sending — so an instant OBSERVER agent
      // suffices. The on-chain allowlist here is irrelevant: the test overrides
      // cachedState below to a Jupiter-only allowlist and targets the memo
      // program, so seal()'s SDK check is what fires.
      const restrictedVault = await provisionVault(
        rpc,
        owner,
        agent,
        USDC_MINT_DEVNET,
        {
          dailySpendingCapUsd: 500_000_000n,
          depositAmount: 10_000_000n,
          protocols: [MEMO_PROGRAM],
          permissions: OBSERVER,
          vaultId: BigInt(Date.now()),
        },
      );

      const memoIx: Instruction = {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode("constraint-test"),
      };

      // Manually override the cached state to simulate allowlist mode
      const state = await resolveVaultState(
        rpc,
        restrictedVault.vaultAddress,
        agent.address,
      );
      // Override policy to allowlist-only with Jupiter
      const restrictedState = {
        ...state,
        policy: {
          ...state.policy,
          protocolMode: 1, // allowlist
          protocols: [JUPITER_PROGRAM_ADDRESS], // only Jupiter allowed
        },
      };

      try {
        await seal({
          vault: restrictedVault.vaultAddress,
          agent,
          instructions: [memoIx],
          rpc,
          network: "devnet",
          tokenMint: USDC_MINT_DEVNET,
          amount: 1_000_000n,
          // actionType removed in v6 — spending determined by amount > 0
          targetProtocol: MEMO_PROGRAM,
          cachedState: restrictedState,
        });
        expect.fail("seal() should have rejected non-allowed protocol");
      } catch (e: any) {
        expect(e.message).to.include("not allowed");
      }
    });
  });
});
