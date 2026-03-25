/**
 * Measures real wrapped Jupiter transaction sizes.
 *
 * Fetches a real Jupiter swap quote + instructions from mainnet API,
 * wraps them with Phalnx validate+finalize, and reports TX size.
 * Does NOT send — just measures.
 *
 * Usage:
 *   npx tsx sdk/kit/tests/devnet/measure-jupiter-wrap.ts
 *     → Measures WITHOUT ALTs (shows the size problem)
 *
 *   npx tsx sdk/kit/tests/devnet/measure-jupiter-wrap.ts --with-alts
 *     → Measures WITH Phalnx + Jupiter ALTs resolved via RPC
 *     → Requires SOLANA_RPC_URL or uses public devnet
 *
 * Prerequisites:
 *   Save Jupiter /swap-instructions response to /tmp/jupiter-swap-data.json:
 *   curl "https://api.jup.ag/swap/v1/swap-instructions" -d '{...}' > /tmp/jupiter-swap-data.json
 */

import { readFileSync } from "node:fs";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole, createSolanaRpc } from "@solana/kit";
import { wrap } from "../../src/wrap.js";
import { AltCache, mergeAltAddresses } from "../../src/alt-loader.js";
import { PHALNX_ALT_DEVNET } from "../../src/alt-config.js";
import { ActionType } from "../../src/generated/types/actionType.js";
import { VaultStatus } from "../../src/generated/types/vaultStatus.js";
import type { ResolvedVaultState } from "../../src/state-resolver.js";
import {
  FULL_PERMISSIONS,
  USDC_MINT_MAINNET,
  JUPITER_PROGRAM_ADDRESS,
} from "../../src/types.js";

// ─── Convert Jupiter API instruction to Kit Instruction ─────────────────────

function toKitInstruction(apiIx: {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}): Instruction {
  return {
    programAddress: apiIx.programId as Address,
    accounts: apiIx.accounts.map((a) => ({
      address: a.pubkey as Address,
      role: a.isWritable
        ? a.isSigner
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.WRITABLE
        : a.isSigner
          ? AccountRole.READONLY_SIGNER
          : AccountRole.READONLY,
    })),
    data: Buffer.from(apiIx.data, "base64"),
  };
}

// ─── Mock vault state (we're measuring size, not executing) ─────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const AGENT = "11111111111111111111111111111113" as Address;
const OWNER = "11111111111111111111111111111114" as Address;
const FEE_DEST = "11111111111111111111111111111115" as Address;

function mockState(): ResolvedVaultState {
  return {
    vault: {
      discriminator: new Uint8Array(8),
      owner: OWNER,
      vaultId: 0n,
      agents: [{ pubkey: AGENT, permissions: FULL_PERMISSIONS, spendingLimitUsd: 0n, paused: false }],
      feeDestination: FEE_DEST,
      status: VaultStatus.Active,
      bump: 255,
      createdAt: 1000n,
      totalTransactions: 0n,
      totalVolume: 0n,
      openPositions: 0,
      activeEscrowCount: 0,
      totalFeesCollected: 0n,
      totalDepositedUsd: 0n,
      totalWithdrawnUsd: 0n,
      totalFailedTransactions: 0n,
    },
    policy: {
      discriminator: new Uint8Array(8),
      vault: VAULT,
      dailySpendingCapUsd: 10_000_000_000n,
      maxTransactionSizeUsd: 10_000_000_000n,
      protocolMode: 0,
      protocols: [],
      maxLeverageBps: 0,
      canOpenPositions: true,
      maxConcurrentPositions: 5,
      developerFeeRate: 0,
      maxSlippageBps: 500,
      timelockDuration: 0n,
      allowedDestinations: [],
      hasConstraints: false,
      hasPendingPolicy: false,
      hasProtocolCaps: false,
      protocolCaps: [],
      sessionExpirySlots: 0n,
      bump: 255,
    },
    tracker: null,
    overlay: null,
    constraints: null,
    globalBudget: { spent24h: 0n, cap: 10_000_000_000n, remaining: 10_000_000_000n },
    agentBudget: null,
    allAgentBudgets: new Map(),
    protocolBudgets: [],
    maxTransactionUsd: 10_000_000_000n,
    stablecoinBalances: { usdc: 0n, usdt: 0n },
    resolvedAtTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Load Jupiter swap data
  const dataPath = "/tmp/jupiter-swap-data.json";
  try {
    readFileSync(dataPath);
  } catch {
    console.error(`Missing: ${dataPath}`);
    console.error(`Fetch it first: curl -s "https://api.jup.ag/swap/v1/swap-instructions" \\`);
    console.error(`  -H "Content-Type: application/json" -d '{"..."}' > ${dataPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(dataPath, "utf-8"));

  // Convert Jupiter instructions
  const swapIx = toKitInstruction(raw.swapInstruction);
  const setupIxs: Instruction[] = (raw.setupInstructions || []).map(toKitInstruction);
  const cleanupIx = raw.cleanupInstruction ? toKitInstruction(raw.cleanupInstruction) : null;
  const computeIxs: Instruction[] = (raw.computeBudgetInstructions || []).map(toKitInstruction);

  // Jupiter ALTs
  const jupiterAlts: Address[] = (raw.addressLookupTableAddresses || []) as Address[];

  console.log("═══ Jupiter Swap Instruction Analysis ═══");
  console.log(`  Swap IX accounts: ${swapIx.accounts?.length ?? 0}`);
  console.log(`  Swap IX data:     ${swapIx.data?.length ?? 0} bytes`);
  console.log(`  Setup IXs:        ${setupIxs.length}`);
  console.log(`  Cleanup IX:       ${cleanupIx ? "yes" : "no"}`);
  console.log(`  Compute IXs:      ${computeIxs.length}`);
  console.log(`  Jupiter ALTs:     ${jupiterAlts.length}`);
  console.log();

  // All DeFi instructions (setup + swap + cleanup)
  // wrap() strips ComputeBudget, so include them — they'll be filtered out
  const allDeFiIxs = [...computeIxs, ...setupIxs, swapIx];
  if (cleanupIx) allDeFiIxs.push(cleanupIx);

  console.log(`  Total DeFi IXs passed to wrap(): ${allDeFiIxs.length}`);
  console.log(`  (ComputeBudget will be stripped by wrap)`);
  console.log();

  // Wrap WITHOUT ALTs first
  const resultNoAlt = await wrap({
    vault: VAULT,
    agent: { address: AGENT, signTransactions: async (txs: any) => txs } as any,
    instructions: allDeFiIxs,
    rpc: {} as any,
    network: "mainnet",
    tokenMint: USDC_MINT_MAINNET,
    amount: 100_000_000n,
    actionType: ActionType.Swap,
    cachedState: mockState(),
    blockhash: { blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA", lastValidBlockHeight: 99999n },
    addressLookupTables: {}, // empty — no ALT compression
  });

  console.log("═══ Wrapped TX Size (NO ALTs) ═══");
  console.log(`  TX size:    ${resultNoAlt.txSizeBytes} bytes`);
  console.log(`  Limit:      1232 bytes`);
  console.log(`  Headroom:   ${1232 - resultNoAlt.txSizeBytes} bytes`);
  console.log(`  Within limit: ${resultNoAlt.txSizeBytes <= 1232 ? "YES" : "NO — WOULD FAIL"}`);
  console.log(`  Warnings:   ${resultNoAlt.warnings.length > 0 ? resultNoAlt.warnings.join("; ") : "none"}`);
  console.log();

  // Now try to measure with Jupiter's ALTs
  // We can't resolve ALTs without RPC, but we can report what Jupiter provides
  console.log("═══ Jupiter-Provided ALTs ═══");
  for (const alt of jupiterAlts) {
    console.log(`  ${alt}`);
  }
  console.log();

  // Also measure swap-only (no setup/cleanup) to show the minimal case
  const resultSwapOnly = await wrap({
    vault: VAULT,
    agent: { address: AGENT, signTransactions: async (txs: any) => txs } as any,
    instructions: [swapIx],
    rpc: {} as any,
    network: "mainnet",
    tokenMint: USDC_MINT_MAINNET,
    amount: 100_000_000n,
    actionType: ActionType.Swap,
    cachedState: mockState(),
    blockhash: { blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA", lastValidBlockHeight: 99999n },
    addressLookupTables: {},
  });

  console.log("═══ Wrapped TX Size (Swap IX only, NO ALTs) ═══");
  console.log(`  TX size:    ${resultSwapOnly.txSizeBytes} bytes`);
  console.log(`  Limit:      1232 bytes`);
  console.log(`  Headroom:   ${1232 - resultSwapOnly.txSizeBytes} bytes`);
  console.log(`  Within limit: ${resultSwapOnly.txSizeBytes <= 1232 ? "YES" : "NO — WOULD FAIL"}`);
  console.log();

  // Summary
  console.log("═══ SUMMARY ═══");
  console.log(`  Phalnx adds ~${resultSwapOnly.txSizeBytes - (swapIx.accounts?.length ?? 0) * 32} bytes overhead`);
  console.log(`  (validate_and_authorize + finalize_session + compute budget)`);
  console.log(`  Jupiter swap alone: ${swapIx.accounts?.length ?? 0} accounts × 32 bytes = ~${(swapIx.accounts?.length ?? 0) * 32} bytes for accounts`);
  console.log();

  if (resultNoAlt.txSizeBytes > 1232) {
    console.log("  ⚠️  Full Jupiter swap (with setup+cleanup) exceeds 1232 bytes WITHOUT ALTs.");
    console.log("  ✅ ALTs are REQUIRED for production. Jupiter provides them in the API response.");
    console.log("  The Phalnx ALT + Jupiter ALTs combined should bring it under limit.");
  } else {
    console.log("  ✅ Full Jupiter swap fits within 1232 bytes even WITHOUT ALTs.");
  }

  // ─── WITH ALTs mode: resolve via RPC and measure compressed size ───────
  if (process.argv.includes("--with-alts")) {
    console.log();
    console.log("═══ ALT Compression Mode (--with-alts) ═══");

    const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
    console.log(`  RPC: ${rpcUrl}`);

    const rpc = createSolanaRpc(rpcUrl);
    const altCache = new AltCache();

    // Merge Phalnx ALT + Jupiter ALTs
    const allAlts = mergeAltAddresses(PHALNX_ALT_DEVNET, jupiterAlts);
    console.log(`  ALTs to resolve: ${allAlts.length} (1 Phalnx + ${jupiterAlts.length} Jupiter)`);

    const resolvedAlts = await altCache.resolve(rpc, allAlts);
    const resolvedCount = Object.keys(resolvedAlts).length;
    let totalEntries = 0;
    for (const entries of Object.values(resolvedAlts)) {
      totalEntries += entries.length;
    }
    console.log(`  Resolved: ${resolvedCount} ALT(s) with ${totalEntries} total entries`);
    console.log();

    try {
      const resultWithAlts = await wrap({
        vault: VAULT,
        agent: { address: AGENT, signTransactions: async (txs: any) => txs } as any,
        instructions: allDeFiIxs,
        rpc: rpc as any,
        network: "mainnet",
        tokenMint: USDC_MINT_MAINNET,
        amount: 100_000_000n,
        actionType: ActionType.Swap,
        cachedState: mockState(),
        blockhash: { blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA", lastValidBlockHeight: 99999n },
        addressLookupTables: resolvedAlts,
      });

      console.log("═══ Wrapped TX Size (WITH Phalnx + Jupiter ALTs) ═══");
      console.log(`  TX size:      ${resultWithAlts.txSizeBytes} bytes`);
      console.log(`  Limit:        1232 bytes`);
      console.log(`  Headroom:     ${1232 - resultWithAlts.txSizeBytes} bytes`);
      console.log(`  Within limit: ${resultWithAlts.txSizeBytes <= 1232 ? "YES ✅" : "NO ❌"}`);
      console.log();

      const saved = resultNoAlt.txSizeBytes - resultWithAlts.txSizeBytes;
      console.log(`  ALTs saved: ${saved} bytes (${((saved / resultNoAlt.txSizeBytes) * 100).toFixed(1)}%)`);
    } catch (e) {
      console.log(`  ❌ Failed to compose with ALTs: ${e instanceof Error ? e.message : e}`);
      console.log("  This may mean the ALTs could not be resolved (wrong network, stale data, etc.)");
    }
  }
}

main().catch(console.error);
