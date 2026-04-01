#!/usr/bin/env npx tsx
/**
 * Extend the Sigil devnet ALT with additional shared addresses.
 *
 * Currently adds: protocol treasury USDC/USDT ATAs.
 * Future: add vault-specific PDAs for frequently-used vaults.
 *
 * Prerequisites:
 * - ALT authority keypair at ~/.config/solana/alt-authority.json
 *   (authority: 6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp)
 * - Devnet SOL for transaction fees
 *
 * Usage: npx tsx scripts/extend-sigil-alt.ts
 *
 * After running, update EXPECTED_ALT_CONTENTS_DEVNET in sdk/kit/src/alt-config.ts
 * to include the new addresses.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  AddressLookupTableProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

// ─── Configuration ────────────────────────────────────────────────────────────

const SIGIL_ALT_DEVNET = new PublicKey("BtRLCMVamw9c3R8UDwgYBCFur5YVkqACmakVh9xi2aTw");

// Protocol treasury (devnet): ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT
const PROTOCOL_TREASURY = new PublicKey("ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT");

// USDC devnet (test-controlled): DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH
const USDC_MINT_DEVNET = new PublicKey("DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH");

// USDT devnet (test-controlled): 43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze
const USDT_MINT_DEVNET = new PublicKey("43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze");

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load authority keypair — tries alt-authority.json first, falls back to id.json
  const altAuthorityPath = join(homedir(), ".config", "solana", "alt-authority.json");
  const defaultIdPath = join(homedir(), ".config", "solana", "id.json");
  const authorityPath = (() => {
    try { readFileSync(altAuthorityPath); return altAuthorityPath; } catch { return defaultIdPath; }
  })();
  let authority: Keypair;
  try {
    const raw = JSON.parse(readFileSync(authorityPath, "utf-8"));
    authority = Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    console.error(`Failed to load ALT authority keypair from ${authorityPath}`);
    console.error("Generate with: solana-keygen new --outfile ~/.config/solana/id.json");
    process.exit(1);
  }

  console.log(`ALT authority: ${authority.publicKey.toBase58()}`);
  console.log(`ALT address:   ${SIGIL_ALT_DEVNET.toBase58()}`);
  console.log();

  const connection = new Connection(RPC_URL, "confirmed");

  // Safety check: verify we're on devnet (prevents accidental mainnet ALT corruption)
  const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS) {
    console.error("SAFETY: This script is devnet-only. Connected cluster has genesis:");
    console.error(`  ${genesisHash}`);
    console.error("Expected devnet genesis:");
    console.error(`  ${DEVNET_GENESIS}`);
    process.exit(1);
  }
  console.log("Cluster: devnet (genesis verified)");
  console.log();

  // Derive treasury ATAs (allowOwnerOffCurve: treasury is a PDA, not an ed25519 key)
  const treasuryUsdcAta = await getAssociatedTokenAddress(USDC_MINT_DEVNET, PROTOCOL_TREASURY, true);
  const treasuryUsdtAta = await getAssociatedTokenAddress(USDT_MINT_DEVNET, PROTOCOL_TREASURY, true);

  console.log("New addresses to add:");
  console.log(`  Treasury USDC ATA: ${treasuryUsdcAta.toBase58()}`);
  console.log(`  Treasury USDT ATA: ${treasuryUsdtAta.toBase58()}`);
  console.log();

  // Check current ALT contents
  const altAccount = await connection.getAddressLookupTable(SIGIL_ALT_DEVNET);
  if (!altAccount.value) {
    console.error("ALT not found on-chain. Was it created?");
    process.exit(1);
  }

  const currentAddresses = altAccount.value.state.addresses.map((a) => a.toBase58());
  console.log(`Current ALT entries (${currentAddresses.length}):`);
  for (const addr of currentAddresses) {
    console.log(`  ${addr}`);
  }
  console.log();

  // Check which addresses are already in the ALT
  const toAdd: PublicKey[] = [];
  if (!currentAddresses.includes(treasuryUsdcAta.toBase58())) {
    toAdd.push(treasuryUsdcAta);
  } else {
    console.log("Treasury USDC ATA already in ALT — skipping");
  }
  if (!currentAddresses.includes(treasuryUsdtAta.toBase58())) {
    toAdd.push(treasuryUsdtAta);
  } else {
    console.log("Treasury USDT ATA already in ALT — skipping");
  }

  if (toAdd.length === 0) {
    console.log("Nothing to add — ALT is up to date.");
    return;
  }

  console.log(`Extending ALT with ${toAdd.length} new address(es)...`);

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: SIGIL_ALT_DEVNET,
    authority: authority.publicKey,
    payer: authority.publicKey,
    addresses: toAdd,
  });

  const tx = new Transaction().add(extendIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log(`Extended ALT in tx: ${sig}`);
  console.log();

  // Verify
  const updated = await connection.getAddressLookupTable(SIGIL_ALT_DEVNET);
  if (updated.value) {
    console.log(`Updated ALT entries (${updated.value.state.addresses.length}):`);
    for (const addr of updated.value.state.addresses) {
      console.log(`  ${addr.toBase58()}`);
    }
  }

  console.log();
  console.log("═══ NEXT STEPS ═══");
  console.log("1. Update EXPECTED_ALT_CONTENTS_DEVNET in sdk/kit/src/alt-config.ts");
  console.log("   with the treasury ATA addresses printed above.");
  console.log();
  console.log("2. ALT entries are usable after the next slot (~400ms).");
  console.log("   Wait 1-2 seconds before using in transactions.");
  console.log();
  console.log("3. SDK AltCache serves stale data for up to 5 minutes.");
  console.log("   If using SigilClient, call client.invalidateCaches() to force refresh.");
  console.log("   If using standalone wrap(), the module-level altCache will expire on its own.");
  console.log();
  console.log("⚠️  ALT AUTHORITY: This ALT is controlled by a single EOA keypair.");
  console.log("   For mainnet, migrate authority to a Squads V4 multisig (2-of-3).");
  console.log("   See: memory/alt-authority-migration.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
