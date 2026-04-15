/**
 * SigilTeeError — domain class for TEE attestation + custody errors.
 *
 * Leaf classes (`TeeAttestationError`, `AttestationCertChainError`,
 * `AttestationPcrMismatchError`) extend this and live in
 * `src/tee/wallet-types.ts`. They are NOT defined here.
 *
 * Step 4 of the migration adds this class. Step 6 re-homes the leaves under
 * this domain. The two `instanceof TeeAttestationError` re-throw guards in
 * `src/tee/providers/turnkey.ts:359, :563` continue to work because the
 * leaf class name is preserved and the prototype chain only grows upward.
 */

import { SigilError } from "./base.js";
import type { SigilTeeErrorCode } from "./codes.js";

export class SigilTeeError<
  TCode extends SigilTeeErrorCode = SigilTeeErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilTeeError";
}
