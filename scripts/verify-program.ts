#!/usr/bin/env npx tsx
/**
 * Verify deployed Phalnx program matches source code.
 *
 * Uses solana-verify CLI for deterministic build comparison.
 * Also checks upgrade authority and warns if single-key.
 *
 * Prerequisites:
 * - cargo install solana-verify
 * - Docker installed and running (for deterministic builds)
 *
 * Usage:
 *   npx tsx scripts/verify-program.ts                  # devnet (default)
 *   npx tsx scripts/verify-program.ts --cluster mainnet # mainnet
 */

import { spawnSync } from "node:child_process";

const PROGRAM_ID = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";
const cluster = process.argv.includes("--cluster")
  ? process.argv[process.argv.indexOf("--cluster") + 1] ?? "devnet"
  : "devnet";
const rpcUrl =
  cluster === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";

function run(
  cmd: string,
  args: string[],
): { stdout: string; ok: boolean } {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: 600_000,
  });
  return { stdout: (result.stdout ?? "").trim(), ok: result.status === 0 };
}

// 1. Check solana-verify is installed
console.log("=== Phalnx Program Verification ===\n");
const ver = run("solana-verify", ["--version"]);
if (!ver.ok) {
  console.error(
    "ERROR: solana-verify not found. Install with: cargo install solana-verify",
  );
  process.exit(1);
}
console.log(`solana-verify ${ver.stdout}`);
console.log(`Cluster: ${cluster}`);
console.log(`Program: ${PROGRAM_ID}\n`);

// 2. Verify program bytecode
console.log("--- Bytecode Verification ---");
const verify = run("solana-verify", [
  "verify-from-repo",
  "--program-id",
  PROGRAM_ID,
  "--library-name",
  "phalnx",
  "--mount-path",
  "programs/phalnx",
  "--url",
  rpcUrl,
]);
console.log(verify.stdout);
if (!verify.ok) {
  console.error(
    "\n❌ VERIFICATION FAILED — deployed binary does NOT match source code.",
  );
  console.error(
    "See ON-CHAIN-IMPLEMENTATION-PLAN.md 'Verification Failure Runbook' for next steps.",
  );
  process.exit(1);
}
console.log("\n✅ VERIFIED — deployed binary matches source code.\n");

// 3. Check upgrade authority
console.log("--- Upgrade Authority ---");
const show = run("solana", [
  "program",
  "show",
  PROGRAM_ID,
  "--url",
  rpcUrl,
  "--output",
  "json",
]);
if (show.ok) {
  try {
    const info = JSON.parse(show.stdout);
    const authority = info.authority ?? "unknown";
    console.log(`Authority: ${authority}`);
    if (authority !== "none") {
      console.log("⚠️  WARNING: Program is upgradeable.");
      console.log(
        "   Verify this is a multisig before trusting on mainnet.",
      );
    } else {
      console.log("✅ Program is immutable (authority renounced).");
    }
  } catch {
    console.log("Could not parse program info. Run manually:");
    console.log(`  solana program show ${PROGRAM_ID} --url ${rpcUrl}`);
  }
} else {
  console.log(
    "Could not query program info (is solana CLI configured?)",
  );
}
