/**
 * Test-process-wide setup. Installs per-test hooks that prevent
 * cross-test state bleed. Loaded via mocha root-hooks plugin from the
 * `--require tests/global-setup.ts` flag in package.json.
 *
 * H2 from adversarial review: `_sigilModuleLogger` is process-wide
 * mutable state. Tests that install a capture logger via
 * `setSigilModuleLogger(spy)` and fail before their local try/finally
 * reset would leak the capture into every subsequent test. A global
 * `afterEach` hook guarantees the module logger always resets to
 * NOOP_LOGGER after each test, regardless of what the test body did.
 *
 * Uses the `mochaHooks` root-hook plugin pattern so the hook is
 * registered at mocha-load time, not at module-evaluation time (which
 * runs before `afterEach` is available on the mocha runtime).
 * See https://mochajs.org/#root-hook-plugins
 */

import { setSigilModuleLogger, NOOP_LOGGER } from "../src/logger.js";

export const mochaHooks = {
  afterEach(): void {
    setSigilModuleLogger(NOOP_LOGGER);
  },
};
