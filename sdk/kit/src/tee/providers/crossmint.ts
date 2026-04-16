/**
 * Crossmint TEE Attestation Provider — Intel TDX enclaves.
 *
 * PR 3.B F039: collapsed to a thin wrapper around createManagedVerifier().
 * Crossmint and Privy were ~95% identical (92 vs 90 lines). The shared
 * logic now lives in managed-verifier.ts.
 */

import { createManagedVerifier } from "./managed-verifier.js";

export const verifyCrossmint = createManagedVerifier({
  provider: "crossmint",
  enclaveType: "tdx",
  infrastructureDescription: "Intel TDX infrastructure",
});
