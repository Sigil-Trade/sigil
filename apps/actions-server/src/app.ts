import { Hono } from "hono";
import { discovery } from "./routes/discovery";
import { provision } from "./routes/provision";
import { provisionTee } from "./routes/provision-tee";
import { fund } from "./routes/fund";
import { status } from "./routes/status";
import { tiers } from "./routes/tiers";

const app = new Hono();

// Mount routes
app.route("/", discovery);
app.route("/", provision);
app.route("/", provisionTee);
app.route("/", fund);
app.route("/", status);
app.route("/", tiers);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export { app };
