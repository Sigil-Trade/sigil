/**
 * Partial-sign elevated OWNER-OP builders (take-over 2026-06-17).
 *
 * On a cosign-required vault the hardened program requires the BOUND cosigner to
 * co-sign these six previously-owner-only ops. These builders mirror
 * buildQueuePolicyElevated's partial-sign mechanics (proven in
 * elevated-policy.test.ts); here we assert the op-specific wiring: each builder
 * returns the partial owner-signed wire tx AND binds the cosigner as a REQUIRED
 * signer (so the on-chain has_bound_cosigner / disable / close gates are
 * satisfiable once the cosigner co-signs).
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
} from "@solana/kit";
import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";

import {
  buildCancelAgentGrantElevated,
  buildCancelAgentPermissionsElevated,
  buildCancelPendingPolicyElevated,
  buildApplyAgentPermissionsElevated,
  buildApplyPendingPolicyElevated,
  buildCloseVaultElevated,
  type CosignedActionBundle,
} from "../../src/dashboard/mutations.js";
import { getPolicyConfigEncoder } from "../../src/generated/accounts/policyConfig.js";
import { getAgentVaultEncoder } from "../../src/generated/accounts/agentVault.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import { getPolicyPDA } from "../../src/resolve-accounts.js";
import { createMockVaultState } from "../../src/testing/mock-state.js";

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}
function accountInfo(dataB64: string) {
  return {
    value: {
      data: [dataB64, "base64"] as [string, "base64"],
      executable: false,
      lamports: 10_000_000n,
      owner: SIGIL_PROGRAM_ADDRESS,
      rentEpoch: 0n,
      space: BigInt(Buffer.from(dataB64, "base64").length),
    },
  };
}
/** Decode the partial wire tx → the signer set + Sigil ix presence. */
function decodePartial(wireB64: string): {
  staticAccounts: Address[];
  numSigners: number;
  hasSigilIx: boolean;
} {
  const bytes = new Uint8Array(getBase64Encoder().encode(wireB64));
  const numSigs = bytes[0]!;
  const messageBytes = bytes.slice(1 + numSigs * 64);
  const m = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: Address[];
    instructions: ReadonlyArray<{ programAddressIndex: number }>;
  };
  return {
    staticAccounts: m.staticAccounts,
    numSigners: m.header.numSignerAccounts,
    hasSigilIx: m.instructions.some(
      (i) => m.staticAccounts[i.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
    ),
  };
}

describe("partial-sign elevated owner-op builders (take-over 2026-06-17)", () => {
  let owner: TransactionSigner;
  let cosigner: TransactionSigner;
  let agent: Address;
  let vault: Address;
  let rpc: Rpc<SolanaRpcApi>;

  function buildMockRpc(
    policyB64: string,
    vaultB64: string,
    policyAddr: Address,
  ): Rpc<SolanaRpcApi> {
    return {
      // vault + policy resolve to state; every other PDA (pending_*) → absent.
      getAccountInfo: (address: Address) => ({
        send: async () => {
          if (address === policyAddr) return accountInfo(policyB64);
          if (address === vault) return accountInfo(vaultB64);
          return { value: null };
        },
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
            lastValidBlockHeight: 1000n,
          },
        }),
      }),
      getSlot: () => ({ send: async () => 100n }),
      // resolveVaultStateForOwner (used by the close path) fetches via
      // getMultipleAccounts → fetchEncodedAccounts.
      getMultipleAccounts: (addresses: readonly Address[]) => ({
        send: async () => ({
          value: addresses.map((a) =>
            a === policyAddr
              ? accountInfo(policyB64).value
              : a === vault
                ? accountInfo(vaultB64).value
                : null,
          ),
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  before(async () => {
    owner = await generateKeyPairSigner();
    cosigner = await generateKeyPairSigner();
    agent = (await generateKeyPairSigner()).address;
    vault = (await generateKeyPairSigner()).address;
    const state = createMockVaultState({
      vault,
      agent,
      owner: owner.address,
      feeDestination: (await generateKeyPairSigner()).address,
    });
    const [policyAddr] = await getPolicyPDA(vault);
    rpc = buildMockRpc(
      toBase64(getPolicyConfigEncoder().encode(state.policy as never)),
      toBase64(getAgentVaultEncoder().encode(state.vault as never)),
      policyAddr,
    );
  });

  // Each builder must: (1) echo the cosigner as cosignSession, (2) include a
  // Sigil instruction, (3) bind the cosigner as a REQUIRED signer of the
  // partial tx (so the on-chain cosign gate is satisfiable).
  function assertBound(bundle: CosignedActionBundle): void {
    expect(bundle.cosignSession).to.equal(cosigner.address);
    expect(bundle.partialTransactionBase64).to.be.a("string").and.not.empty;
    const { staticAccounts, numSigners, hasSigilIx } = decodePartial(
      bundle.partialTransactionBase64,
    );
    expect(hasSigilIx, "partial tx must contain a Sigil instruction").to.be
      .true;
    const requiredSigners = staticAccounts.slice(0, numSigners);
    expect(
      requiredSigners.includes(cosigner.address),
      "bound cosigner must be a required signer of the partial tx",
    ).to.be.true;
    expect(
      requiredSigners.includes(owner.address),
      "owner must be a required signer",
    ).to.be.true;
  }

  it("buildCancelAgentGrantElevated binds the cosigner", async () => {
    assertBound(
      await buildCancelAgentGrantElevated(rpc, vault, owner, cosigner.address),
    );
  });

  it("buildCancelAgentPermissionsElevated binds the cosigner", async () => {
    assertBound(
      await buildCancelAgentPermissionsElevated(
        rpc,
        vault,
        owner,
        agent,
        cosigner.address,
      ),
    );
  });

  it("buildCancelPendingPolicyElevated binds the cosigner", async () => {
    assertBound(
      await buildCancelPendingPolicyElevated(
        rpc,
        vault,
        owner,
        cosigner.address,
      ),
    );
  });

  it("buildApplyAgentPermissionsElevated binds the cosigner (H-1)", async () => {
    assertBound(
      await buildApplyAgentPermissionsElevated(
        rpc,
        vault,
        owner,
        agent,
        cosigner.address,
      ),
    );
  });

  it("buildApplyPendingPolicyElevated binds the cosigner (disable)", async () => {
    assertBound(
      await buildApplyPendingPolicyElevated(
        rpc,
        vault,
        owner,
        cosigner.address,
      ),
    );
  });

  it("buildCloseVaultElevated binds the cosigner", async () => {
    assertBound(
      await buildCloseVaultElevated(
        rpc,
        vault,
        owner,
        "devnet",
        cosigner.address,
      ),
    );
  });

  it("rejects a cosigner equal to the owner (ErrCosignRequired class)", async () => {
    let threw = false;
    try {
      await buildCancelPendingPolicyElevated(rpc, vault, owner, owner.address);
    } catch {
      threw = true;
    }
    expect(threw, "cosigner == owner must be rejected").to.be.true;
  });
});
