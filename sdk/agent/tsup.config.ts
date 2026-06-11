import { defineConfig } from "tsup";

/**
 * Bundle target: a single-file ESM CLI that runs via `npx @usesigil/agent`.
 * The `bin` entry in package.json points to dist/index.js — we shebang it
 * via tsup's `banner` so npx invocations work without a separate launcher.
 *
 * `splitting: false` because this is a CLI, not a library — one file makes
 * `npx` cold-starts faster (no extra fs reads).
 *
 * `noExternal: false` keeps deps as runtime requires (so `@usesigil/kit`
 * upgrades don't require an agent republish). Tradeoff: install footprint
 * is the dep tree, not 50kb. Acceptable since `npx` caches.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  minify: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
