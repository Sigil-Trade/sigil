import { expect } from "chai";
import { searchTokens } from "../../src/tools/search-tokens";
import { configureJupiterApi, resetJupiterApiConfig } from "@phalnx/sdk";

describe("shield_search_tokens", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    configureJupiterApi({ maxRetries: 0 });
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    resetJupiterApiConfig();
  });

  it("returns formatted token search results", async () => {
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
        ]),
        { status: 200 },
      );

    const result = await searchTokens({ query: "SOL", limit: 10 });
    expect(result).to.include("Token Search");
    expect(result).to.include("SOL");
    expect(result).to.include("Wrapped SOL");
    expect(result).to.include("So11111111111111111111111111111111111111112");
    expect(result).to.include("Daily Volume");
  });

  it("flags suspicious tokens with freeze authority", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify([
          {
            address: "FakeToken111111111111111111111111111111111",
            name: "Scam Token",
            symbol: "SCAM",
            decimals: 6,
            isSus: true,
            freezeAuthority: "SomeAuthority111111111111111111111111111111",
          },
        ]),
        { status: 200 },
      );

    const result = await searchTokens({ query: "SCAM" });
    expect(result).to.include("[SUSPICIOUS]");
    expect(result).to.include("Freeze Authority");
  });

  it("returns no results message for empty response", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify([]), { status: 200 });

    const result = await searchTokens({ query: "nonexistent_token_xyz" });
    expect(result).to.include("No tokens found");
    expect(result).to.include("nonexistent_token_xyz");
  });

  it("returns error on API failure", async () => {
    (globalThis as any).fetch = async () =>
      new Response("Bad Request", { status: 400 });

    const result = await searchTokens({ query: "SOL" });
    expect(result).to.include("Jupiter");
  });
});
