import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { provision } from "../../src/tools/provision";

describe("shield_provision", () => {
  const agentPubkey = Keypair.generate().publicKey.toBase58();

  it("generates action URL with defaults", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "conservative",
    });
    expect(result).to.include(
      "agent-middleware.vercel.app/api/actions/provision",
    );
    expect(result).to.include("conservative");
    expect(result).to.include("500 USDC");
  });

  it("generates blink URL", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "conservative",
    });
    expect(result).to.include("dial.to");
    expect(result).to.include("solana-action:");
  });

  it("uses moderate template", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "moderate",
    });
    expect(result).to.include("2000 USDC");
    expect(result).to.include("moderate");
  });

  it("uses aggressive template", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "aggressive",
    });
    expect(result).to.include("10000 USDC");
    expect(result).to.include("aggressive");
  });

  it("includes custom dailyCap in params", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "conservative",
      dailyCap: 1000,
    });
    expect(result).to.include("dailyCap=1000");
    expect(result).to.include("1000 USDC");
  });

  it("includes agentPubkey in params", async () => {
    const result = await provision(null, {
      platformUrl: "https://agent-middleware.vercel.app",
      template: "conservative",
      agentPubkey,
    });
    expect(result).to.include(`agentPubkey=${agentPubkey}`);
  });
});
