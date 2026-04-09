/**
 * Protocol Handler Types
 *
 * Interfaces for the protocol integration layer.
 * Generated {proto}-handler.ts and {proto}-compose.ts files
 * import from "./protocol-handler.js".
 */

import type { Address, Instruction } from "@solana/kit";

// ─── Handler Metadata ───────────────────────────────────────────────────────

/**
 * Static metadata describing a protocol's handler capabilities.
 * Emitted by the add-protocol pipeline alongside the handler implementation.
 */
export interface ProtocolHandlerMetadata {
  readonly protocolId: string;
  readonly displayName: string;
  readonly programIds: readonly Address[];
  readonly supportedActions: ReadonlyMap<
    string,
    { readonly actionType: number; readonly isSpending: boolean }
  >;
}

// ─── Compose Context & Result ───────────────────────────────────────────────

/**
 * Context passed to compose functions during instruction building.
 * Minimal shape — extend as compose functions are implemented (Phase A2+).
 */
export interface ProtocolContext {
  readonly vault: Address;
  readonly agent: Address;
  readonly owner: Address;
}

/**
 * Result of composing a protocol instruction.
 * Minimal shape — extend as compose functions are implemented (Phase A2+).
 */
export interface ProtocolComposeResult {
  readonly instructions: readonly Instruction[];
}

// ─── Handler Interface ──────────────────────────────────────────────────────

/**
 * Implemented by generated {proto}-handler.ts files.
 * Turns a protocol-specific action + params into Solana instructions ready
 * for inclusion in a Sigil-sealed transaction.
 *
 * Tier 1 (Verified): one ProtocolHandler per supported protocol, generated
 * by the add-protocol pipeline at build time.
 */
export interface ProtocolHandler {
  readonly metadata: ProtocolHandlerMetadata;

  /**
   * Build the Solana instructions for the given action.
   * Throws ComposeError if params are invalid or action is unsupported.
   */
  compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult>;

  /**
   * Render a human-readable description of the action for UI display.
   * Pure function — no RPC calls, no side effects.
   */
  summarize(action: string, params: Record<string, unknown>): string;
}
