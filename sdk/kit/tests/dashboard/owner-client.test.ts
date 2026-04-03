import { expect } from "chai";
import type { Address, TransactionSigner } from "@solana/kit";
import {
  OwnerClient,
  type OwnerClientConfig,
} from "../../src/dashboard/index.js";

// ─── Test Addresses ─────────────────────────────────────────────────────────

const VAULT = "11111111111111111111111111111112" as Address;
const OWNER_ADDR = "11111111111111111111111111111114" as Address;

function mockSigner(addr: Address = OWNER_ADDR): TransactionSigner {
  return {
    address: addr,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
  } as unknown as TransactionSigner;
}

function validConfig(): OwnerClientConfig {
  return {
    rpc: {} as any,
    vault: VAULT,
    owner: mockSigner(),
    network: "devnet",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("OwnerClient", () => {
  describe("constructor", () => {
    it("stores readonly properties from config", () => {
      const config = validConfig();
      const client = new OwnerClient(config);

      expect(client.vault).to.equal(VAULT);
      expect(client.network).to.equal("devnet");
      expect(client.owner.address).to.equal(OWNER_ADDR);
    });

    it("accepts mainnet network", () => {
      const client = new OwnerClient({ ...validConfig(), network: "mainnet" });
      expect(client.network).to.equal("mainnet");
    });

    it("throws if rpc missing", () => {
      expect(
        () => new OwnerClient({ ...validConfig(), rpc: undefined as any }),
      ).to.throw("rpc is required");
    });

    it("throws if vault missing", () => {
      expect(
        () => new OwnerClient({ ...validConfig(), vault: undefined as any }),
      ).to.throw("vault is required");
    });

    it("throws if owner missing", () => {
      expect(
        () => new OwnerClient({ ...validConfig(), owner: undefined as any }),
      ).to.throw("owner is required");
    });

    it("throws if network missing", () => {
      expect(
        () => new OwnerClient({ ...validConfig(), network: undefined as any }),
      ).to.throw("network is required");
    });
  });

  describe("method count", () => {
    it("has 6 read methods", () => {
      const client = new OwnerClient(validConfig());
      const reads = [
        "getVaultState",
        "getAgents",
        "getSpending",
        "getActivity",
        "getHealth",
        "getPolicy",
      ];
      for (const name of reads) {
        expect(typeof (client as any)[name]).to.equal(
          "function",
          `${name} should be a function`,
        );
      }
    });

    it("has 23 mutation methods", () => {
      const client = new OwnerClient(validConfig());
      const mutations = [
        "freezeVault",
        "resumeVault",
        "closeVault",
        "syncPositions",
        "deposit",
        "withdraw",
        "addAgent",
        "pauseAgent",
        "unpauseAgent",
        "revokeAgent",
        "queueAgentPermissions",
        "applyAgentPermissions",
        "cancelAgentPermissions",
        "queuePolicyUpdate",
        "applyPendingPolicy",
        "cancelPendingPolicy",
        "createConstraints",
        "queueConstraintsUpdate",
        "applyConstraintsUpdate",
        "cancelConstraintsUpdate",
        "queueCloseConstraints",
        "applyCloseConstraints",
        "cancelCloseConstraints",
      ];
      for (const name of mutations) {
        expect(typeof (client as any)[name]).to.equal(
          "function",
          `${name} should be a function`,
        );
      }
    });

    it("has discoverVaults static method", () => {
      expect(typeof OwnerClient.discoverVaults).to.equal("function");
    });
  });

  describe("type exports", () => {
    it("exports OwnerClient class", async () => {
      const mod = await import("../../src/dashboard/index.js");
      expect(mod.OwnerClient).to.be.a("function");
    });
  });
});
