import { PublicKey } from "@solana/web3.js";
import {
  getTokenInfo as coreGetTokenInfo,
  getProtocolName as coreGetProtocolName,
  isSystemProgram as coreIsSystemProgram,
  isKnownProtocol as coreIsKnownProtocol,
} from "@phalnx/core";

export { KNOWN_PROTOCOLS, KNOWN_TOKENS, SYSTEM_PROGRAMS } from "@phalnx/core";

/**
 * Look up a token's symbol and decimals by mint address.
 * Returns undefined for unknown tokens.
 */
export function getTokenInfo(
  mint: PublicKey | string,
): { symbol: string; decimals: number } | undefined {
  const key = typeof mint === "string" ? mint : mint.toBase58();
  return coreGetTokenInfo(key);
}

/**
 * Look up a protocol's name by program ID.
 * Returns undefined for unknown protocols.
 */
export function getProtocolName(
  programId: PublicKey | string,
): string | undefined {
  const key = typeof programId === "string" ? programId : programId.toBase58();
  return coreGetProtocolName(key);
}

/**
 * Check if a program ID is a known system program (always allowed).
 */
export function isSystemProgram(programId: PublicKey | string): boolean {
  const key = typeof programId === "string" ? programId : programId.toBase58();
  return coreIsSystemProgram(key);
}

/**
 * Check if a program ID is a known DeFi protocol.
 */
export function isKnownProtocol(programId: PublicKey | string): boolean {
  const key = typeof programId === "string" ? programId : programId.toBase58();
  return coreIsKnownProtocol(key);
}
