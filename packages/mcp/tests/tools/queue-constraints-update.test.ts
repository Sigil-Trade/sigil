import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { queueConstraintsUpdate } from "../../src/tools/queue-constraints-update";
import { createMockClient, TEST_VAULT_PDA } from "../helpers/mock-client";

describe("shield_queue_constraints_update", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  const entry = {
    programId: Keypair.generate().publicKey.toBase58(),
    dataConstraints: [
      {
        offset: 0,
        operator: "eq" as const,
        value: [0xc3, 0x58, 0x63, 0xa5, 0xb4, 0x8d, 0x2c, 0x81],
      },
    ],
  };

  it("queues constraints update successfully", async () => {
    const client = createMockClient();
    const result = await queueConstraintsUpdate(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("Constraints Update Queued");
    expect(result).to.include("mock-sig-queue-constraints");
  });

  it("returns error when pending exists", async () => {
    const client = createMockClient({
      shouldThrow: Object.assign(new Error("test"), { code: 6059 }),
    });
    const result = await queueConstraintsUpdate(client as any, {
      vault,
      entries: [entry],
    });
    expect(result).to.include("PendingConstraintsUpdateExists");
  });
});
