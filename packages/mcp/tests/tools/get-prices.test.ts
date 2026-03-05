import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { getPrices } from "../../src/tools/get-prices";
import { configureJupiterApi, resetJupiterApiConfig } from "@phalnx/sdk";

describe("shield_get_prices", () => {
  const mint1 = Keypair.generate().publicKey.toBase58();
  const mint2 = Keypair.generate().publicKey.toBase58();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Disable retries so tests don't hang on mock failures
    configureJupiterApi({ maxRetries: 0 });
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    resetJupiterApiConfig();
  });

  it("returns formatted prices for multiple mints", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            [mint1]: { id: mint1, type: "derivedPrice", price: "1.50" },
            [mint2]: { id: mint2, type: "derivedPrice", price: "42.00" },
          },
          timeTaken: 15,
        }),
        { status: 200 },
      );

    const result = await getPrices({ mints: [mint1, mint2] });
    expect(result).to.include("Token Prices");
    expect(result).to.include(mint1);
    expect(result).to.include("$1.50");
    expect(result).to.include(mint2);
    expect(result).to.include("$42.00");
    expect(result).to.include("15ms");
  });

  it("returns no data message for empty response", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ data: {}, timeTaken: 5 }), { status: 200 });

    const result = await getPrices({ mints: [mint1] });
    expect(result).to.include("No price data found");
  });

  it("includes confidence level when showExtraInfo is true", async () => {
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            [mint1]: {
              id: mint1,
              type: "derivedPrice",
              price: "3.14",
              extraInfo: { confidenceLevel: "high" },
            },
          },
          timeTaken: 10,
        }),
        { status: 200 },
      );

    const result = await getPrices({ mints: [mint1], showExtraInfo: true });
    expect(result).to.include("$3.14");
    expect(result).to.include("Confidence: high");
  });

  it("returns error on API failure", async () => {
    (globalThis as any).fetch = async () =>
      new Response("Internal Server Error", { status: 500 });

    const result = await getPrices({ mints: [mint1] });
    expect(result).to.include("Jupiter");
  });
});
