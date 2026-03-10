/**
 * Protocol Handler Registry
 *
 * Simple Map-backed registry for protocol handlers. Protocols register
 * when their module is explicitly imported (lazy — keeps optional deps
 * from being loaded until needed).
 *
 * Lookup by protocol ID ("drift") or by on-chain program ID (PublicKey).
 */

import type { PublicKey } from "@solana/web3.js";
import type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
} from "./protocol-handler";

export class ProtocolRegistry {
  /** Protocol ID → handler */
  private readonly handlers = new Map<string, ProtocolHandler>();
  /** Program ID (base58) → protocol ID — reverse index for program-based lookup */
  private readonly programIndex = new Map<string, string>();

  /**
   * Register a protocol handler.
   * @throws if a handler with the same protocolId is already registered
   */
  register(handler: ProtocolHandler): void {
    const id = handler.metadata.protocolId;
    if (this.handlers.has(id)) {
      throw new Error(`Protocol handler already registered: ${id}`);
    }
    this.handlers.set(id, handler);

    // Index all program IDs for reverse lookup
    for (const programId of handler.metadata.programIds) {
      this.programIndex.set(programId.toBase58(), id);
    }
  }

  /**
   * Deregister a protocol handler by ID.
   * @returns true if the handler was found and removed
   */
  deregister(protocolId: string): boolean {
    const handler = this.handlers.get(protocolId);
    if (!handler) return false;

    // Remove program ID index entries
    for (const programId of handler.metadata.programIds) {
      this.programIndex.delete(programId.toBase58());
    }

    this.handlers.delete(protocolId);
    return true;
  }

  /** Look up a handler by protocol ID (e.g. "drift"). */
  getByProtocolId(protocolId: string): ProtocolHandler | undefined {
    return this.handlers.get(protocolId);
  }

  /** Look up a handler by one of its on-chain program IDs. */
  getByProgramId(programId: PublicKey): ProtocolHandler | undefined {
    const protocolId = this.programIndex.get(programId.toBase58());
    if (!protocolId) return undefined;
    return this.handlers.get(protocolId);
  }

  /** List metadata for all registered handlers. */
  listAll(): ProtocolHandlerMetadata[] {
    return Array.from(this.handlers.values()).map((h) => h.metadata);
  }

  /** Check if a protocol ID is registered. */
  has(protocolId: string): boolean {
    return this.handlers.has(protocolId);
  }

  /** Number of registered handlers. */
  get size(): number {
    return this.handlers.size;
  }
}

/** Global singleton registry. Handlers register here on module import. */
export const globalProtocolRegistry = new ProtocolRegistry();
