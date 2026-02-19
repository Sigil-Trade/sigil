import { Hono } from "hono";
import { discovery } from "./routes/discovery";
import { provision } from "./routes/provision";
import { status } from "./routes/status";

const app = new Hono();

// Mount routes
app.route("/", discovery);
app.route("/", provision);
app.route("/", status);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export { app };
