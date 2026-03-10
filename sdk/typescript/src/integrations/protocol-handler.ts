/**
 * Protocol Handler Interface
 *
 * Defines the contract for protocol adapters in the Phalnx SDK.
 * Bridges hand-crafted adapters (Tier 1) and future runtime-registered
 * handlers (Tier 2) into a uniform dispatch mechanism.
 */

import type {
  PublicKey,
  TransactionInstruction,
  Connection,
  Signer,
} from "@solana/web3.js";
import type { BN, Program } from "@coral-xyz/anchor";
import type { Phalnx, ActionType } from "../types";

// ─── Compose Result ──────────────────────────────────────────────────────────

/**
 * Returned by ProtocolHandler.compose() — everything needed to build
 * the composed Phalnx transaction sandwich.
 */
export interface ProtocolComposeResult {
  /** DeFi instructions to place between validate_and_authorize and finalize_session */
  instructions: TransactionInstruction[];
  /** Extra signers required by the protocol instructions (e.g. ephemeral keypairs) */
  additionalSigners?: Signer[];
  /** Address lookup table addresses for versioned transaction compression */
  addressLookupTables?: PublicKey[];
}

// ─── Protocol Context ────────────────────────────────────────────────────────

/**
 * Shared vault context passed to every ProtocolHandler.compose() call.
 * Equivalent to the common fields in ComposeActionParams.
 */
export interface ProtocolContext {
  /** Anchor program instance for Phalnx */
  program: Program<Phalnx>;
  /** Solana connection for RPC calls */
  connection: Connection;
  /** Vault PDA address */
  vault: PublicKey;
  /** Vault owner public key */
  owner: PublicKey;
  /** Vault identifier */
  vaultId: BN;
  /** Agent signing key */
  agent: PublicKey;
}

// ─── Handler Metadata ────────────────────────────────────────────────────────

/** Action descriptor mapping a handler action name to an on-chain ActionType */
export interface ProtocolActionDescriptor {
  /** On-chain ActionType enum variant */
  actionType: ActionType;
  /** Whether this action counts against the spending cap */
  isSpending: boolean;
}

/**
 * Static metadata describing a protocol handler's capabilities.
 */
export interface ProtocolHandlerMetadata {
  /** Unique protocol identifier (e.g. "drift", "kamino-lending") */
  protocolId: string;
  /** Human-readable display name (e.g. "Drift Protocol") */
  displayName: string;
  /** On-chain program IDs this handler covers */
  programIds: PublicKey[];
  /** Map of action names to their ActionType + spending classification */
  supportedActions: Map<string, ProtocolActionDescriptor>;
}

// ─── Protocol Handler Interface ──────────────────────────────────────────────

/**
 * Interface for protocol adapters that integrate with Phalnx composed transactions.
 *
 * Each handler wraps a DeFi protocol's instruction building into a uniform
 * interface that the registry and client can dispatch to.
 */
export interface ProtocolHandler {
  /** Static metadata about this handler */
  readonly metadata: ProtocolHandlerMetadata;

  /**
   * Build DeFi instructions for a given action.
   *
   * @param ctx - Vault context (program, connection, vault, owner, vaultId, agent)
   * @param action - Handler-specific action name (e.g. "deposit", "placePerpOrder")
   * @param params - Action-specific parameters (type-safe within each handler)
   * @returns Instructions + optional signers/ALTs for the composed transaction
   */
  compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult>;

  /**
   * Produce a human-readable summary of an action for display/logging.
   */
  summarize(action: string, params: Record<string, unknown>): string;

  /**
   * Optional one-time initialization (e.g. loading Drift client state).
   * Called lazily on first use via the registry.
   */
  initialize?(connection: Connection): Promise<void>;
}
