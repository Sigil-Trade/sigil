/**
 * SigilRpcError — domain class for RPC + transaction lifecycle errors.
 *
 * Use for: tx confirmation timeout, simulation failures, drain detection,
 * tx-too-large, RPC rate limiting, transport errors that don't already
 * fit into Shield/TEE/X402/Compose.
 *
 * Wrap upstream `@solana/kit` `SolanaError` instances via `cause` to
 * preserve the chain (use `walkSigilCause` to traverse).
 */

import { SigilError } from "./base.js";
import type { SigilRpcErrorCode } from "./codes.js";

export class SigilRpcError<
  TCode extends SigilRpcErrorCode = SigilRpcErrorCode,
> extends SigilError<TCode> {
  override name: string = "SigilRpcError";
}
