import { expect } from "chai";
import { lendTokens } from "../../src/tools/lend-tokens";
import { configureJupiterApi, resetJupiterApiConfig } from "@phalnx/sdk";

describe("shield_lend_tokens", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    configureJupiterApi({ maxRetries: 0 });
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    resetJupiterApiConfig();
  });

  it("returns formatted lend token list with APY", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify([
          {
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            symbol: "USDC",
            name: "USD Coin",
            decimals: 6,
            apy: 0.085,
            totalDeposited: "15000000000000",
            totalBorrowed: "8000000000000",
            utilizationRate: 0.533,
          },
          {
            mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            symbol: "USDT",
            name: "Tether USD",
            decimals: 6,
            apy: 0.072,
            totalDeposited: "5000000000000",
            totalBorrowed: "2000000000000",
            utilizationRate: 0.4,
          },
        ]),
        { status: 200 },
      );

    const result = await lendTokens({});
    expect(result).to.include("Jupiter Lend/Earn");
    expect(result).to.include("USDC");
    expect(result).to.include("USDT");
    expect(result).to.include("8.50%");
    expect(result).to.include("53.3%");
    expect(result).to.include("7.20%");
  });

  it("returns empty message when no tokens available", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify([]), { status: 200 });

    const result = await lendTokens({});
    expect(result).to.include("No tokens available");
  });

  it("returns error on API failure", async () => {
    (globalThis as any).fetch = async () =>
      new Response("Service Unavailable", { status: 503 });

    const result = await lendTokens({});
    expect(result).to.include("Jupiter");
  });
});
