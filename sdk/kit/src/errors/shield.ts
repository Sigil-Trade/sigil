/**
 * SigilShieldError — domain class for policy enforcement errors.
 *
 * Leaf classes (`ShieldDeniedError`, `ShieldConfigError`) extend this and live
 * in `src/shield.ts` / `src/core/errors.ts` for blame-history continuity. They
 * are NOT defined here.
 *
 * Step 4 of the migration adds this class. Step 5 collapses the dual
 * `ShieldDeniedError` definition and re-homes both leaves under this domain.
 */

import { SigilError } from "./base.js";
import type { SigilShieldErrorCode } from "./codes.js";

export class SigilShieldError<
  TCode extends SigilShieldErrorCode = SigilShieldErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilShieldError";
}
