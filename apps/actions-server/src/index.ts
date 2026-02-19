import { serve } from "@hono/node-server";
import { app } from "./app";

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`[actions-server] Starting on port ${port}...`);
serve({ fetch: app.fetch, port });
console.log(`[actions-server] Listening at http://localhost:${port}`);

export { app };
