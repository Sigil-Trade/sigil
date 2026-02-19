import { Hono } from "hono";

const discovery = new Hono();

/**
 * GET /.well-known/actions.json — Solana Actions discovery endpoint.
 * Tells blink renderers which paths are Action endpoints.
 */
discovery.get("/.well-known/actions.json", (c) => {
  return c.json({
    rules: [
      {
        pathPattern: "/api/actions/**",
        apiPath: "/api/actions/**",
      },
    ],
  });
});

export { discovery };
