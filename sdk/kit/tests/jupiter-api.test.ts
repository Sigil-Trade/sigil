import { expect } from "chai";
import {
  configureJupiterApi,
  getJupiterApiConfig,
  resetJupiterApiConfig,
} from "../src/integrations/jupiter-api.js";

describe("jupiter-api", () => {
  afterEach(() => {
    resetJupiterApiConfig();
  });

  describe("H-3: HTTPS enforcement", () => {
    it("accepts https:// baseUrl", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "https://api.jup.ag" }),
      ).to.not.throw();
      expect(getJupiterApiConfig().baseUrl).to.equal("https://api.jup.ag");
    });

    it("accepts http://localhost for testing", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "http://localhost:8080" }),
      ).to.not.throw();
      expect(getJupiterApiConfig().baseUrl).to.equal("http://localhost:8080");
    });

    it("rejects http:// non-localhost baseUrl", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "http://api.jup.ag" }),
      ).to.throw("Jupiter API base URL must use HTTPS");
    });

    it("rejects bare domain without protocol", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "api.jup.ag" }),
      ).to.throw("Invalid Jupiter API base URL");
    });

    it("default config uses https", () => {
      const config = getJupiterApiConfig();
      expect(config.baseUrl).to.match(/^https:\/\//);
    });

    it("rejects http://localhost.evil.com bypass (BUG-5)", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "http://localhost.evil.com" }),
      ).to.throw("Jupiter API base URL must use HTTPS");
    });

    it("accepts http://127.0.0.1:8080 for testing", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "http://127.0.0.1:8080" }),
      ).to.not.throw();
    });

    it("rejects ftp:// protocol", () => {
      expect(() =>
        configureJupiterApi({ baseUrl: "ftp://api.jup.ag" }),
      ).to.throw();
    });
  });
});
