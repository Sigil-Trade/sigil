/**
 * TA-19 / Item 3 — Verified-build program hash (SDK side).
 *
 * Computes the SHA-256 of a deployed program's executable ELF, as stored in its
 * BPFLoaderUpgradeable `ProgramData` account. This is the value an owner pins
 * into `PolicyConfig.protocol_hashes` so that `validate_and_authorize` can
 * reject a target protocol whose on-chain build no longer matches the audited
 * one — closing the upgrade-TOCTOU: an owner allowlists a program, it is later
 * upgraded to a drain contract, and pure-pubkey allowlisting keeps authorizing.
 *
 * The on-chain check (`programs/sigil/src/utils/program_hash.rs`) hashes the
 * SAME bytes: the `ProgramData` account data past its 45-byte header. The
 * `UpgradeableLoaderState::ProgramData` serialization is:
 *
 *   4 bytes  enum discriminant (variant 3)
 *   8 bytes  slot (u64 LE)
 *   1 byte   Option<Pubkey> tag for upgrade_authority_address
 *  32 bytes  upgrade authority pubkey
 *  --------
 *  45 bytes  header, then the raw ELF to EOF.
 *
 * This helper MUST stay byte-identical to that offset and primitive, or a hash
 * pinned via this function will never match the on-chain recomputation.
 */
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "./kit-adapter.js";
import { sha256 } from "./canonical-encode.js";

/**
 * BPFLoaderUpgradeable program id. Every upgradeable program's `ProgramData`
 * account is owned by — and PDA-derived under — this loader.
 */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;

/**
 * Byte length of the `UpgradeableLoaderState::ProgramData` header that precedes
 * the ELF: 4 (enum discriminant) + 8 (slot u64) + 1 (Option tag) + 32 (upgrade
 * authority) = 45. The hashed payload is `data[PROGRAM_DATA_HEADER_LEN..]`.
 */
export const PROGRAM_DATA_HEADER_LEN = 45;

/**
 * Derive the `ProgramData` account address for an upgradeable program:
 * `find_program_address([program_id], BPFLoaderUpgradeable)`.
 */
export async function getProgramDataAddress(
  programId: Address,
): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [programDataAddress] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    seeds: [addressEncoder.encode(programId)],
  });
  return programDataAddress;
}

/** Platform-agnostic base64 decode to `Uint8Array` (no `Buffer` dependency). */
function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fetch a deployed upgradeable program's `ProgramData` account and return the
 * SHA-256 (32 bytes) of its executable ELF — the value to pin into
 * `PolicyConfig.protocol_hashes` for the verified-build gate.
 *
 * Throws if the `ProgramData` account does not exist (not deployed, or not an
 * upgradeable program), is not owned by BPFLoaderUpgradeable, or is too small
 * to contain an ELF past the header — so a caller can never silently pin a hash
 * over a non-program or a malformed/truncated RPC response.
 *
 * @param rpc        a `@solana/kit` RPC client
 * @param programId  the address of the deployed program (NOT its ProgramData)
 * @returns the 32-byte SHA-256 of the program's ELF
 */
export async function getProgramDataHash(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<Uint8Array> {
  const programDataAddress = await getProgramDataAddress(programId);
  const { value } = await rpc
    .getAccountInfo(programDataAddress, { encoding: "base64" })
    .send();

  if (value === null) {
    throw new Error(
      `ProgramData account ${programDataAddress} not found for program ${programId}: ` +
        `the program is not deployed, or was not deployed with BPFLoaderUpgradeable.`,
    );
  }
  if (value.owner !== BPF_LOADER_UPGRADEABLE_PROGRAM_ID) {
    throw new Error(
      `ProgramData account ${programDataAddress} is not owned by BPFLoaderUpgradeable ` +
        `(owner=${value.owner}); refusing to pin a hash over a non-ProgramData account.`,
    );
  }

  const data = base64ToUint8(value.data[0]);
  if (data.length <= PROGRAM_DATA_HEADER_LEN) {
    throw new Error(
      `ProgramData account ${programDataAddress} is ${data.length} bytes — too small to ` +
        `contain an ELF past the ${PROGRAM_DATA_HEADER_LEN}-byte header (truncated response?).`,
    );
  }

  const elf = data.subarray(PROGRAM_DATA_HEADER_LEN);
  return sha256(elf);
}
