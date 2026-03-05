import { expect } from "chai";
import { trendingTokens } from "../../src/tools/trending-tokens";
import { configureJupiterApi, resetJupiterApiConfig } from "@phalnx/sdk";

describe("shield_trending_tokens", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    configureJupiterApi({ maxRetries: 0 });
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    resetJupiterApiConfig();
  });

  it("returns formatted trending token list", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify([
          {
            address: "So11111111111111111111111111111111111111112",
            name: "Wrapped SOL",
            symbol: "SOL",
            decimals: 9,
            dailyVolume: 500000000,
            isSus: false,
          },
          {
            address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            name: "USD Coin",
            symbol: "USDC",
            decimals: 6,
            dailyVolume: 300000000,
            isSus: false,
          },
        ]),
        { status: 200 },
      );

    const result = await trendingTokens({ interval: "24h" });
    expect(result).to.include("Trending Tokens (24h)");
    expect(result).to.include("SOL");
    expect(result).to.include("USDC");
    expect(result).to.include("Daily Volume");
  });

  it("returns empty message when no trending tokens", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify([]), { status: 200 });

    const result = await trendingTokens({ interval: "1h" });
    expect(result).to.include("No trending tokens found");
    expect(result).to.include("1h");
  });

  it("flags suspicious trending tokens", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify([
          {
            address: "SusTok111111111111111111111111111111111111",
            name: "Suspicious Token",
            symbol: "SUS",
            decimals: 6,
            mintAuthority: "SomeAuth111111111111111111111111111111111",
          },
        ]),
        { status: 200 },
      );

    const result = await trendingTokens({ interval: "5m" });
    expect(result).to.include("[SUSPICIOUS]");
  });

  it("returns error on API failure", async () => {
    (globalThis as any).fetch = async () =>
      new Response("Rate limited", { status: 429 });

    const result = await trendingTokens({ interval: "6h" });
    expect(result).to.include("Jupiter");
  });
});
