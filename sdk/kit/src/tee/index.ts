// TEE Remote Attestation — barrel exports

export {
  AttestationStatus,
  type TeeProvider,
  type AttestationResult,
  type AttestationConfig,
  type AttestationMetadata,
  type AttestationLevel,
  type VerifiedTeeWallet,
  type NitroPcrValues,
  type TurnkeyAttestationBundle,
} from "./types";

export { AttestationCache, DEFAULT_CACHE_TTL_MS } from "./cache";

export {
  isTeeWallet,
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
} from "./wallet-types.js";
export type { WalletLike, TeeWallet } from "./wallet-types.js";

export {
  verifyTeeAttestation,
  clearAttestationCache,
  deleteFromAttestationCache,
} from "./verify";

export { verifyCrossmint } from "./providers/crossmint";
export { verifyPrivy } from "./providers/privy";
export { verifyTurnkey } from "./providers/turnkey";
