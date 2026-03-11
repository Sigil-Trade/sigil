/**
 * Turnkey TEE Attestation Provider
 *
 * Two-layer verification:
 * 1. Boot Proof — COSE_Sign1 (P-384 ECDSA) with AWS Nitro cert chain + PCR3
 * 2. App Proof — P-256 ECDSA signature binding the app public key to the boot attestation
 *
 * COSE_Sign1 structure (CBOR tag 18):
 *   [protected_headers, unprotected_headers, payload, signature]
 *
 * Sig_structure for verification:
 *   CBOR(["Signature1", protected_bytes, b'', payload_bytes])
 *
 * The cert chain is extracted from unprotected headers key 33 (x5chain).
 * Each cert in the chain must chain to the embedded AWS Nitro Root CA.
 *
 * PCR3 is the SHA-384 hash of the IAM role ARN — used to bind the enclave
 * identity to a specific AWS IAM role (Turnkey's production enclave).
 */

import * as crypto from "node:crypto";
import { getAddressEncoder } from "@solana/kit";
import {
  AttestationStatus,
  type AttestationResult,
  type AttestationConfig,
  type NitroPcrValues,
  type TeeProvider,
  type TurnkeyAttestationBundle,
} from "../types.js";
import { AWS_NITRO_ROOT_CA_PEM } from "../nitro-root.js";
import {
  TeeAttestationError,
  AttestationCertChainError,
  AttestationPcrMismatchError,
} from "../wallet-types.js";
import type { TeeWallet } from "../wallet-types.js";

// Allow overriding the root CA for testing
let rootCaPem = AWS_NITRO_ROOT_CA_PEM;

/** Override the root CA PEM for testing. Only available in test environments. */
export function setTestRootCa(pem: string): void {
  if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
    throw new Error(
      "setTestRootCa() is only available in test environments (NODE_ENV=test)",
    );
  }
  rootCaPem = pem;
}

/** Restore the production root CA PEM. */
export function restoreProductionRootCa(): void {
  rootCaPem = AWS_NITRO_ROOT_CA_PEM;
}

/**
 * Convert a raw ECDSA signature (r || s concatenation) to DER format
 * for Node.js crypto.verify().
 */
function rawSigToDer(rawSig: Buffer, curveByteLen: number): Buffer {
  if (rawSig.length !== curveByteLen * 2) {
    throw new TeeAttestationError(
      `Invalid raw ECDSA signature: expected ${curveByteLen * 2} bytes, got ${rawSig.length}`,
    );
  }
  const r = rawSig.subarray(0, curveByteLen);
  const s = rawSig.subarray(curveByteLen, curveByteLen * 2);

  // Encode each integer, adding leading zero if high bit set
  function encodeInt(val: Buffer): Buffer {
    // Strip leading zeros but keep at least one byte
    let start = 0;
    while (start < val.length - 1 && val[start] === 0) start++;
    val = val.subarray(start);

    const needsPad = val[0]! >= 0x80;
    const len = val.length + (needsPad ? 1 : 0);
    const out = Buffer.alloc(2 + len);
    out[0] = 0x02; // INTEGER tag
    out[1] = len;
    if (needsPad) {
      out[2] = 0x00;
      val.copy(out, 3);
    } else {
      val.copy(out, 2);
    }
    return out;
  }

  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const seqLen = rDer.length + sDer.length;

  // SEQUENCE header
  const header =
    seqLen < 128
      ? Buffer.from([0x30, seqLen])
      : Buffer.from([0x30, 0x81, seqLen]);

  return Buffer.concat([header, rDer, sDer]);
}

/**
 * Decode a CBOR-encoded COSE_Sign1 structure.
 * Uses cbor-x for CBOR decoding.
 */
async function decodeCoseSign1(cborBytes: Buffer): Promise<{
  protectedHeaders: Buffer;
  unprotectedHeaders: Map<number, unknown>;
  payload: Buffer;
  signature: Buffer;
}> {
  // Dynamic import to handle optional dependency gracefully
  const cbor = await import("cbor-x");
  const decoded = cbor.decode(cborBytes);

  // COSE_Sign1 is a CBOR array of 4 elements
  // May be wrapped in a CBOR tag (tag 18 for COSE_Sign1)
  let arr: unknown[];
  if (Array.isArray(decoded)) {
    arr = decoded;
  } else if (
    decoded &&
    typeof decoded === "object" &&
    "value" in decoded &&
    Array.isArray(decoded.value)
  ) {
    // M2: Validate COSE_Sign1 tag (18) when present
    if ("tag" in decoded && (decoded as { tag: number }).tag !== 18) {
      throw new TeeAttestationError(
        `Invalid COSE tag: expected 18 (COSE_Sign1), got ${(decoded as { tag: number }).tag}`,
      );
    }
    arr = decoded.value;
  } else {
    throw new TeeAttestationError(
      "Invalid COSE_Sign1: expected 4-element array",
    );
  }

  if (arr.length !== 4) {
    throw new TeeAttestationError(
      `Invalid COSE_Sign1: expected 4 elements, got ${arr.length}`,
    );
  }

  // M3: Type-guard COSE_Sign1 byte-string elements
  function assertByteString(val: unknown, name: string): Uint8Array {
    if (val instanceof Uint8Array || Buffer.isBuffer(val))
      return val as Uint8Array;
    throw new TeeAttestationError(
      `Invalid COSE_Sign1: ${name} must be a byte string`,
    );
  }

  const protectedHeaders = Buffer.from(
    assertByteString(arr[0], "protected_headers"),
  );

  // Unprotected headers: may be a Map or plain object
  let unprotectedHeaders: Map<number, unknown>;
  if (arr[1] instanceof Map) {
    unprotectedHeaders = arr[1] as Map<number, unknown>;
  } else if (arr[1] && typeof arr[1] === "object") {
    unprotectedHeaders = new Map(
      Object.entries(arr[1] as Record<string, unknown>).map(([k, v]) => [
        parseInt(k, 10),
        v,
      ]),
    );
  } else {
    unprotectedHeaders = new Map();
  }

  const payload = Buffer.from(assertByteString(arr[2], "payload"));
  const signature = Buffer.from(assertByteString(arr[3], "signature"));

  return { protectedHeaders, unprotectedHeaders, payload, signature };
}

/**
 * Build the Sig_structure for COSE_Sign1 verification:
 *   CBOR(["Signature1", protected_bytes, b'', payload_bytes])
 */
async function buildSigStructure(
  protectedHeaders: Buffer,
  payload: Buffer,
): Promise<Buffer> {
  const cbor = await import("cbor-x");
  return Buffer.from(
    cbor.encode([
      "Signature1",
      protectedHeaders,
      Buffer.alloc(0), // external_aad = empty
      payload,
    ]),
  );
}

/**
 * Validate a certificate chain against the root CA.
 * Each certificate must be signed by the next certificate in the chain,
 * and the last certificate must chain to the root CA.
 */
function validateCertChain(certs: Buffer[]): crypto.X509Certificate {
  if (certs.length === 0) {
    throw new AttestationCertChainError("Empty certificate chain");
  }

  // Build X509Certificate objects
  const x509Certs = certs.map((certDer) => {
    const pem =
      "-----BEGIN CERTIFICATE-----\n" +
      certDer
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n") +
      "\n-----END CERTIFICATE-----";
    return new crypto.X509Certificate(pem);
  });

  const rootCert = new crypto.X509Certificate(rootCaPem);

  // Verify chain from leaf to root
  // certs[0] = leaf (signing cert), certs[N-1] = closest to root
  for (let i = 0; i < x509Certs.length; i++) {
    const cert = x509Certs[i]!;
    const issuer = i + 1 < x509Certs.length ? x509Certs[i + 1]! : rootCert;

    if (!cert.checkIssued(issuer)) {
      throw new AttestationCertChainError(
        `Certificate at index ${i} was not issued by certificate at index ${i + 1}`,
      );
    }

    // Verify the signature
    const issuerPublicKey = issuer.publicKey;
    if (!cert.verify(issuerPublicKey)) {
      throw new AttestationCertChainError(
        `Certificate signature verification failed at chain index ${i}`,
      );
    }

    // F1: Verify certificate is within its validity period
    const now = new Date();
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
      throw new AttestationCertChainError(
        `Certificate at index ${i} is outside its validity period ` +
          `(${cert.validFrom} to ${cert.validTo})`,
      );
    }
  }

  // Verify the last cert chains to root
  if (x509Certs.length > 0) {
    const lastCert = x509Certs[x509Certs.length - 1]!;
    if (
      !lastCert.checkIssued(rootCert) ||
      !lastCert.verify(rootCert.publicKey)
    ) {
      throw new AttestationCertChainError(
        "Certificate chain does not terminate at the AWS Nitro Root CA",
      );
    }
  }

  // Return the leaf certificate (signing cert)
  return x509Certs[0]!;
}

/**
 * Extract PCR values from a decoded Nitro attestation document payload.
 */
function extractPcrValues(
  attestationDoc: Record<string, unknown>,
): NitroPcrValues {
  const pcrs = attestationDoc.pcrs as
    | Map<number, Buffer>
    | Record<number, Buffer>
    | undefined;
  if (!pcrs) return {};

  const getHex = (index: number): string | undefined => {
    const val =
      pcrs instanceof Map
        ? pcrs.get(index)
        : (pcrs as Record<number, Buffer>)[index];
    return val ? Buffer.from(val).toString("hex") : undefined;
  };

  return {
    pcr0: getHex(0),
    pcr1: getHex(1),
    pcr2: getHex(2),
    pcr3: getHex(3),
  };
}

/**
 * Verify a Turnkey wallet's TEE attestation.
 *
 * Expects the wallet to have a `getAttestation()` method that returns
 * a TurnkeyAttestationBundle. If the method doesn't exist or returns null,
 * falls back to ProviderTrusted.
 */
export async function verifyTurnkey(
  wallet: TeeWallet,
  config?: AttestationConfig,
): Promise<AttestationResult> {
  // Kit Address is already base58 — no conversion needed
  const publicKey = wallet.publicKey;

  // Check if wallet provides attestation data
  const walletRecord = wallet as unknown as Record<string, unknown>;
  const getAttestation =
    typeof walletRecord.getAttestation === "function"
      ? (walletRecord.getAttestation as () => Promise<TurnkeyAttestationBundle | null>)
      : undefined;
  // H2: Turnkey wallets without getAttestation() cannot be cryptographically
  // verified. Return Unavailable instead of ProviderTrusted to prevent
  // spoofed wallets from passing requireAttestation.
  if (!getAttestation) {
    return {
      status: AttestationStatus.Unavailable,
      provider: "turnkey",
      publicKey,
      metadata: {
        provider: "turnkey",
        enclaveType: "nitro",
        verifiedAt: Date.now(),
      },
      message:
        "Turnkey wallet does not expose getAttestation() — " +
        "cannot verify enclave identity. Pass a wallet with getAttestation() " +
        "for cryptographic verification.",
    };
  }

  const ATTESTATION_TIMEOUT_MS = 30_000;
  let bundle: TurnkeyAttestationBundle | null;
  try {
    let timer: ReturnType<typeof setTimeout>;
    bundle = await Promise.race([
      getAttestation.call(wallet).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TeeAttestationError(
                "Turnkey getAttestation() timed out after 30s",
              ),
            ),
          ATTESTATION_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof TeeAttestationError) throw err;
    return {
      status: AttestationStatus.Failed,
      provider: "turnkey",
      publicKey,
      metadata: { provider: "turnkey", verifiedAt: Date.now() },
      message: `Failed to fetch attestation bundle: ${(err as Error).message ?? err}`,
    };
  }

  if (!bundle) {
    return {
      status: AttestationStatus.Unavailable,
      provider: "turnkey",
      publicKey,
      metadata: {
        provider: "turnkey",
        enclaveType: "nitro",
        verifiedAt: Date.now(),
      },
      message:
        "Turnkey getAttestation() returned null — cannot verify enclave identity.",
    };
  }

  // === Boot Proof Verification (COSE_Sign1 + P-384) ===
  try {
    // F9: Validate bundle field types before processing
    if (typeof bundle.bootProof !== "string" || bundle.bootProof.length === 0) {
      throw new TeeAttestationError(
        "Invalid attestation bundle: bootProof must be a non-empty base64 string",
      );
    }

    // F2: Enforce size limit to prevent OOM from malicious payloads
    const MAX_ATTESTATION_BYTES = 64 * 1024; // 64KB — Nitro docs are ~3-5KB
    const bootBytes = Buffer.from(bundle.bootProof, "base64");
    if (bootBytes.length > MAX_ATTESTATION_BYTES) {
      throw new TeeAttestationError(
        `Boot proof exceeds maximum size (${bootBytes.length} > ${MAX_ATTESTATION_BYTES} bytes)`,
      );
    }
    const { protectedHeaders, unprotectedHeaders, payload, signature } =
      await decodeCoseSign1(bootBytes);

    // Extract certificate chain from unprotected headers key 33 (x5chain)
    const x5chain = unprotectedHeaders.get(33);
    if (!x5chain || !Array.isArray(x5chain)) {
      throw new AttestationCertChainError(
        "No x5chain (key 33) in COSE_Sign1 unprotected headers",
      );
    }

    const certBuffers = (x5chain as unknown[]).map((c, i) => {
      if (!(c instanceof Uint8Array) && !Buffer.isBuffer(c)) {
        throw new AttestationCertChainError(
          `x5chain entry at index ${i} is not a byte string`,
        );
      }
      return Buffer.from(c);
    });
    const signingCert = validateCertChain(certBuffers);

    // Build Sig_structure and verify ECDSA P-384 signature
    const sigStructure = await buildSigStructure(protectedHeaders, payload);
    const derSig = rawSigToDer(signature, 48); // P-384 = 48 bytes per component

    const verified = crypto.verify(
      "SHA384",
      sigStructure,
      {
        key: signingCert.publicKey,
        dsaEncoding: "der",
      },
      derSig,
    );

    if (!verified) {
      throw new TeeAttestationError("COSE_Sign1 signature verification failed");
    }

    // Decode the attestation document payload
    const cbor = await import("cbor-x");
    const attestationDoc = cbor.decode(payload) as Record<string, unknown>;

    // Extract and check PCR values
    const pcrValues = extractPcrValues(attestationDoc);

    // C4: Check PCR3 if expected value is provided — require it to be present
    if (config?.expectedPcr3) {
      if (!pcrValues.pcr3) {
        throw new AttestationPcrMismatchError(
          3,
          config.expectedPcr3,
          "<absent>",
        );
      }
      if (pcrValues.pcr3.toLowerCase() !== config.expectedPcr3.toLowerCase()) {
        throw new AttestationPcrMismatchError(
          3,
          config.expectedPcr3,
          pcrValues.pcr3,
        );
      }
    }

    // Extract the boot public key from the attestation document
    const bootPublicKeyBytes = attestationDoc.public_key as
      | Buffer
      | Uint8Array
      | undefined;

    // === App Proof Verification (P-256 ECDSA) ===
    // F3: Use explicit undefined/null checks — empty strings must not silently skip verification
    const hasAppProof =
      bundle.appSignature !== undefined && bundle.appPublicKey !== undefined;
    if (hasAppProof) {
      // C2: If app proof is provided, bootPublicKeyBytes MUST be present in the
      // attestation document — otherwise there is no enclave binding.
      if (!bootPublicKeyBytes || Buffer.from(bootPublicKeyBytes).length === 0) {
        throw new TeeAttestationError(
          "App proof provided but attestation document lacks public_key — cannot bind enclave to wallet",
        );
      }

      if (!bundle.appSignature || !bundle.appPublicKey) {
        throw new TeeAttestationError(
          "App proof fields present but empty — possible attestation tampering",
        );
      }

      // Validate app proof field types
      if (
        typeof bundle.appSignature !== "string" ||
        typeof bundle.appPublicKey !== "string"
      ) {
        throw new TeeAttestationError(
          "Invalid attestation bundle: appSignature and appPublicKey must be strings",
        );
      }

      const appPubKeyBytes = Buffer.from(bundle.appPublicKey, "hex");

      // F5: Reject invalid P-256 key format immediately
      if (appPubKeyBytes.length !== 65) {
        throw new TeeAttestationError(
          `Invalid app public key: expected 65 bytes (uncompressed P-256), got ${appPubKeyBytes.length}`,
        );
      }

      // C1: Always verify the P-256 signature binding the wallet key to the enclave.
      // The app signature proves the wallet's Ed25519 public key was generated inside
      // the attested enclave. This MUST be checked regardless of whether the app key
      // matches the boot key — the signature is the binding proof, not key equality.
      const appSig = Buffer.from(bundle.appSignature, "hex");
      // Kit Address → 32-byte Ed25519 public key via encoder
      const walletPubKeyBytes = Buffer.from(
        getAddressEncoder().encode(wallet.publicKey),
      );

      const keyObj = crypto.createPublicKey({
        key: Buffer.concat([
          // SubjectPublicKeyInfo header for P-256 uncompressed point
          Buffer.from(
            "3059301306072a8648ce3d020106082a8648ce3d030107034200",
            "hex",
          ),
          appPubKeyBytes,
        ]),
        format: "der",
        type: "spki",
      });

      const appVerified = crypto.verify(
        "SHA256",
        walletPubKeyBytes,
        { key: keyObj, dsaEncoding: "der" },
        appSig,
      );

      if (!appVerified) {
        throw new TeeAttestationError(
          "App proof P-256 signature verification failed",
        );
      }
    }

    return {
      status: AttestationStatus.CryptographicallyVerified,
      provider: "turnkey",
      publicKey,
      metadata: {
        provider: "turnkey",
        enclaveType: "nitro",
        pcrValues,
        certChainLength: certBuffers.length,
        verifiedAt: Date.now(),
      },
      message:
        "Turnkey attestation cryptographically verified: " +
        "COSE_Sign1 P-384 signature valid, cert chain trusted, PCR values checked.",
    };
  } catch (err) {
    // F8: Only base class check needed — subclasses extend TeeAttestationError
    if (err instanceof TeeAttestationError) throw err;
    throw new TeeAttestationError(
      `Turnkey attestation verification failed: ${(err as Error).message ?? err}`,
    );
  }
}
