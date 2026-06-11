import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  getVaultPDA,
  getVaultPdaFromState,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getAgentOverlayPDA,
  resolveAccounts,
} from "../src/resolve-accounts.js";

// Deterministic test addresses (valid 32-byte base58 Solana addresses)
const OWNER = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;
const VAULT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const AGENT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;
const TOKEN_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const DEST_VAULT = "So11111111111111111111111111111111111111112" as Address;

describe("resolve-accounts", () => {
  describe("getVaultPDA", () => {
    it("is deterministic for same inputs", async () => {
      const [pda1] = await getVaultPDA(OWNER, 1n);
      const [pda2] = await getVaultPDA(OWNER, 1n);
      expect(pda1).to.equal(pda2);
    });

    it("different vault_id produces different PDA", async () => {
      const [pda1] = await getVaultPDA(OWNER, 1n);
      const [pda2] = await getVaultPDA(OWNER, 2n);
      expect(pda1).to.not.equal(pda2);
    });

    it("returns a bump value", async () => {
      const [, bump] = await getVaultPDA(OWNER, 1n);
      expect(bump).to.be.a("number");
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(bump).to.be.lessThanOrEqual(255);
    });
  });

  describe("getVaultPdaFromState (H-5: post-ownership-transfer)", () => {
    it("derives same PDA as getVaultPDA when authority === owner (pre-transfer)", async () => {
      const [pdaPre] = await getVaultPDA(OWNER, 3n);
      const [pdaState] = await getVaultPdaFromState({
        vaultAuthority: OWNER,
        vaultId: 3n,
      });
      expect(pdaState).to.equal(pdaPre);
    });

    it("derives different PDA than current owner when authority diverges (post-transfer)", async () => {
      // After accept_ownership_transfer, vault.owner = AGENT (new owner)
      // but vault.vault_authority stays pinned to OWNER (original initializer).
      // Passing the NEW owner to getVaultPDA would produce a wrong PDA;
      // getVaultPdaFromState with the original authority resolves correctly.
      const [pdaWrongIfDerivedFromNewOwner] = await getVaultPDA(AGENT, 3n);
      const [pdaCorrect] = await getVaultPdaFromState({
        vaultAuthority: OWNER,
        vaultId: 3n,
      });
      expect(pdaCorrect).to.not.equal(pdaWrongIfDerivedFromNewOwner);
    });

    it("returns a bump value", async () => {
      const [, bump] = await getVaultPdaFromState({
        vaultAuthority: OWNER,
        vaultId: 1n,
      });
      expect(bump).to.be.a("number");
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(bump).to.be.lessThanOrEqual(255);
    });
  });

  describe("getPolicyPDA", () => {
    it("is deterministic", async () => {
      const [pda1] = await getPolicyPDA(VAULT);
      const [pda2] = await getPolicyPDA(VAULT);
      expect(pda1).to.equal(pda2);
    });

    it("derives from vault address", async () => {
      const [pda1] = await getPolicyPDA(VAULT);
      const [pda2] = await getPolicyPDA(DEST_VAULT);
      expect(pda1).to.not.equal(pda2);
    });
  });

  describe("getTrackerPDA", () => {
    it("derives from vault address", async () => {
      const [pda1] = await getTrackerPDA(VAULT);
      const [pda2] = await getTrackerPDA(VAULT);
      expect(pda1).to.equal(pda2);

      const [pda3] = await getTrackerPDA(DEST_VAULT);
      expect(pda1).to.not.equal(pda3);
    });
  });

  describe("getSessionPDA", () => {
    it("derives from vault + agent + tokenMint", async () => {
      const [pda1] = await getSessionPDA(VAULT, AGENT, TOKEN_MINT);
      const [pda2] = await getSessionPDA(VAULT, AGENT, TOKEN_MINT);
      expect(pda1).to.equal(pda2);
    });

    it("different agent produces different PDA", async () => {
      const [pda1] = await getSessionPDA(VAULT, AGENT, TOKEN_MINT);
      const [pda2] = await getSessionPDA(VAULT, OWNER, TOKEN_MINT);
      expect(pda1).to.not.equal(pda2);
    });
  });

  describe("getAgentOverlayPDA", () => {
    it("different shard_index produces different PDA", async () => {
      const [pda1] = await getAgentOverlayPDA(VAULT, 0);
      const [pda2] = await getAgentOverlayPDA(VAULT, 1);
      expect(pda1).to.not.equal(pda2);
    });

    it("default shard_index is 0", async () => {
      const [pda1] = await getAgentOverlayPDA(VAULT);
      const [pda2] = await getAgentOverlayPDA(VAULT, 0);
      expect(pda1).to.equal(pda2);
    });
  });

  describe("resolveAccounts", () => {
    it("returns all 4 required PDAs", async () => {
      const resolved = await resolveAccounts({
        vault: VAULT,
        agent: AGENT,
        tokenMint: TOKEN_MINT,
      });
      expect(resolved.vault).to.equal(VAULT);
      expect(resolved.policyPda).to.be.a("string");
      expect(resolved.trackerPda).to.be.a("string");
      expect(resolved.sessionPda).to.be.a("string");
    });
  });
});
