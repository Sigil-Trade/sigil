/**
 * TEE Remote Attestation — Core Types
 *
 * Defines the provider enum, attestation result/config interfaces,
 * and provider-specific metadata types.
 */

/** Supported TEE custody providers. */
export type TeeProvider = "crossmint" | "turnkey" | "privy";

/** Attestation verification result status. */
export enum AttestationStatus {
  /**
   * Full cryptographic verification passed — COSE_Sign1 signature validated,
   * certificate chain verified against AWS Nitro root, and PCR values checked.
   * This is the strongest guarantee: mathematical proof that the key lives in
   * a specific enclave image. Currently only Turnkey provides this level.
   */
  CryptographicallyVerified = "cryptographically_verified",
  /**
   * Provider API confirmed custody of the wallet key. The SDK called the
   * provider's API (e.g. Crossmint getWallet, Privy wallets.get) and verified
   * the returned address matches this wallet's public key.
   *
   * **What this proves:** The provider's API server acknowledges that this
   * address exists in their custody system and is managed by their TEE
   * infrastructure. An attacker cannot spoof this without access to valid
   * API credentials for the correct app/account.
   *
   * **What this does NOT prove:** There is no cryptographic chain from the
   * enclave hardware to this verification. You are trusting the provider's
   * API server to report custody truthfully. A compromised provider API or
   * a man-in-the-middle could theoretically return false confirmations.
   *
   * Use `minAttestationLevel: "cryptographic"` if you require hardware-rooted proof.
   */
  ProviderVerified = "provider_verified",
  /**
   * The wallet declares a known TEE provider but no custody verification was
   * performed. This happens when: (1) the wallet does not implement
   * `verifyProviderCustody()`, or (2) the custody API call failed and this
   * is a fallback result.
   *
   * **Security implication:** Any object with `{ provider: "crossmint" }` can
   * reach this status. Use `minAttestationLevel: "provider_verified"` to require
   * at least API-confirmed custody.
   */
  ProviderTrusted = "provider_trusted",
  /** Attestation verification failed. */
  Failed = "failed",
  /** No attestation data available (provider doesn't support it). */
  Unavailable = "unavailable",
}

/** AWS Nitro Enclave PCR values (SHA-384 hashes). */
export interface NitroPcrValues {
  /** PCR0: Enclave image hash */
  pcr0?: string;
  /** PCR1: Linux kernel hash */
  pcr1?: string;
  /** PCR2: Application hash */
  pcr2?: string;
  /** PCR3: IAM role ARN hash (used by Turnkey for identity binding) */
  pcr3?: string;
}

/** Turnkey-specific attestation bundle containing boot + app proofs. */
export interface TurnkeyAttestationBundle {
  /** COSE_Sign1 encoded boot attestation document (base64) */
  bootProof: string;
  /** P-256 ECDSA signature over the app public key (hex). Optional — omit when no app proof is available. */
  appSignature?: string;
  /** App public key derived from boot attestation (hex). Optional — omit when no app proof is available. */
  appPublicKey?: string;
}

/** Metadata attached to an attestation result. */
export interface AttestationMetadata {
  /** TEE provider name */
  provider: TeeProvider;
  /** Enclave type (e.g. "nitro", "tdx", "sgx") */
  enclaveType?: string;
  /** PCR values (AWS Nitro specific) */
  pcrValues?: NitroPcrValues;
  /** Certificate chain used for verification */
  certChainLength?: number;
  /** When the attestation was verified */
  verifiedAt: number;
  /** Raw attestation data for advanced consumers */
  rawAttestation?: unknown;
}

/** Result of a TEE attestation verification. */
export interface AttestationResult {
  /** Verification status */
  status: AttestationStatus;
  /** Provider that was verified */
  provider: TeeProvider;
  /** Base58-encoded public key of the attested wallet */
  publicKey: string;
  /** Detailed metadata about the attestation */
  metadata: AttestationMetadata;
  /** Human-readable message */
  message: string;
}

/** Minimum attestation level required. Ordered from weakest to strongest. */
export type AttestationLevel =
  | "provider_trusted"
  | "provider_verified"
  | "cryptographic";

/** Configuration for TEE attestation verification. */
export interface AttestationConfig {
  /** Require attestation to pass — throws on failure. Default: false */
  requireAttestation?: boolean;
  /** Cache TTL in milliseconds. Default: 3_600_000 (1 hour). Set to 0 to disable caching. */
  cacheTtlMs?: number;
  /** Callback fired after successful verification. */
  onVerified?: (result: AttestationResult) => void;
  /** Expected PCR3 value for Turnkey (SHA-384 hash of IAM role ARN). */
  expectedPcr3?: string;
  /** Minimum acceptable verification level. Default: "provider_trusted" (backward-compatible). */
  minAttestationLevel?: AttestationLevel;
}

/** A wallet that has passed TEE attestation verification. */
export interface VerifiedTeeWallet {
  /** The attestation result */
  attestation: AttestationResult;
  /** Base58 public key */
  publicKey: string;
  /** The provider that was verified */
  provider: TeeProvider;
}
