/**
 * SigilComposeError — domain class for protocol composition errors.
 *
 * Leaf class (`ComposeError`) extends this and lives in
 * `src/integrations/compose-errors.ts`. Step 8 re-homes it. The legacy
 * `.code: ComposeErrorCode` (string-literal union) is preserved via
 * `.legacyComposeCode` getter; new `.code` is the canonical SigilErrorCode.
 */

import { SigilError } from "./base.js";
import type { SigilComposeErrorCode } from "./codes.js";

export class SigilComposeError<
  TCode extends SigilComposeErrorCode = SigilComposeErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilComposeError";
}
