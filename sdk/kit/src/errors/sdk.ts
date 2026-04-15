/**
 * SigilSdkDomainError — domain class for SDK-level errors (validation,
 * config, state, runtime guards) raised from sdk/kit/src.
 *
 * Named with `Domain` suffix to disambiguate from the existing
 * `SigilSdkError` in `src/agent-errors.ts` which implements the AgentError
 * interface contract (deferred from PR 2.A rebasing per UD3 + R4).
 *
 * Use this class for new typed throws in SDK code where AgentError
 * conformance is NOT required. Example:
 *
 *   import {
 *     SigilSdkDomainError as SigilSdkError,
 *     SIGIL_ERROR__SDK__VAULT_INACTIVE,
 *   } from "./errors/index.js";
 *
 *   throw new SigilSdkDomainError(
 *     SIGIL_ERROR__SDK__VAULT_INACTIVE,
 *     `Vault is not active (status: ${status})`,
 *     { context: { vault, status } as never },
 *   );
 *
 * Future cleanup PR: promote AgentError to SigilAgentError class, then
 * unify these two SDK error classes under a single hierarchy.
 */

import { SigilError } from "./base.js";
import type { SigilSdkErrorCode } from "./codes.js";

export class SigilSdkDomainError<
  TCode extends SigilSdkErrorCode = SigilSdkErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilSdkDomainError";
}
