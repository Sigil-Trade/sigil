import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  PHALNX_PROGRAM_ID,
} from "../src/index";

describe("Accounts — PDA Derivation", () => {
  const owner = PublicKey.unique();
  const owner2 = PublicKey.unique();
  const agent = PublicKey.unique();
  const agent2 = PublicKey.unique();
  const vaultId = new BN(1);
  const vaultId2 = new BN(2);

  describe("getVaultPDA", () => {
    it("returns deterministic [PublicKey, number]", () => {
      const [pda, bump] = getVaultPDA(owner, vaultId);
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
    });

    it("same inputs produce same PDA (idempotent)", () => {
      const [pda1] = getVaultPDA(owner, vaultId);
      const [pda2] = getVaultPDA(owner, vaultId);
      expect(pda1.equals(pda2)).to.be.true;
    });

    it("different owner produces different PDA", () => {
      const [pda1] = getVaultPDA(owner, vaultId);
      const [pda2] = getVaultPDA(owner2, vaultId);
      expect(pda1.equals(pda2)).to.be.false;
    });

    it("different vaultId produces different PDA", () => {
      const [pda1] = getVaultPDA(owner, vaultId);
      const [pda2] = getVaultPDA(owner, vaultId2);
      expect(pda1.equals(pda2)).to.be.false;
    });
  });

  describe("getPolicyPDA", () => {
    it("returns deterministic PDA", () => {
      const [vault] = getVaultPDA(owner, vaultId);
      const [pda1] = getPolicyPDA(vault);
      const [pda2] = getPolicyPDA(vault);
      expect(pda1.equals(pda2)).to.be.true;
    });
  });

  describe("getTrackerPDA", () => {
    it("returns deterministic PDA", () => {
      const [vault] = getVaultPDA(owner, vaultId);
      const [pda1] = getTrackerPDA(vault);
      const [pda2] = getTrackerPDA(vault);
      expect(pda1.equals(pda2)).to.be.true;
    });

    it("differs from policy PDA for same vault", () => {
      const [vault] = getVaultPDA(owner, vaultId);
      const [policyPda] = getPolicyPDA(vault);
      const [trackerPda] = getTrackerPDA(vault);
      expect(policyPda.equals(trackerPda)).to.be.false;
    });
  });

  describe("getSessionPDA", () => {
    const tokenMint = PublicKey.unique();

    it("returns deterministic PDA", () => {
      const [vault] = getVaultPDA(owner, vaultId);
      const [pda1] = getSessionPDA(vault, agent, tokenMint);
      const [pda2] = getSessionPDA(vault, agent, tokenMint);
      expect(pda1.equals(pda2)).to.be.true;
    });

    it("different agent produces different PDA", () => {
      const [vault] = getVaultPDA(owner, vaultId);
      const [pda1] = getSessionPDA(vault, agent, tokenMint);
      const [pda2] = getSessionPDA(vault, agent2, tokenMint);
      expect(pda1.equals(pda2)).to.be.false;
    });
  });

  describe("bump range", () => {
    it("all bumps are 0-255", () => {
      const tokenMint = PublicKey.unique();
      const [, vaultBump] = getVaultPDA(owner, vaultId);
      const [vault] = getVaultPDA(owner, vaultId);
      const [, policyBump] = getPolicyPDA(vault);
      const [, trackerBump] = getTrackerPDA(vault);
      const [, sessionBump] = getSessionPDA(vault, agent, tokenMint);

      for (const bump of [vaultBump, policyBump, trackerBump, sessionBump]) {
        expect(bump).to.be.at.least(0);
        expect(bump).to.be.at.most(255);
      }
    });
  });

  describe("custom programId", () => {
    it("uses custom programId when provided", () => {
      const customProgram = PublicKey.unique();
      const [pda1] = getVaultPDA(owner, vaultId, PHALNX_PROGRAM_ID);
      const [pda2] = getVaultPDA(owner, vaultId, customProgram);
      expect(pda1.equals(pda2)).to.be.false;
    });
  });
});
