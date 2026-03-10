/**
 * Kamino Lending Protocol Handler
 *
 * Implements ProtocolHandler interface for the protocol registry.
 * Wraps the Kamino compose functions into a uniform dispatch mechanism.
 * Registers with globalProtocolRegistry on import.
 */

import { PublicKey } from "@solana/web3.js";
import type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
  ProtocolContext,
  ProtocolComposeResult,
} from "./protocol-handler";
import {
  KAMINO_LEND_PROGRAM_ID_STR,
  composeKaminoDeposit,
  composeKaminoBorrow,
  composeKaminoRepay,
  composeKaminoWithdraw,
} from "./kamino";
import { globalProtocolRegistry } from "./protocol-registry";

const KAMINO_LEND_PROGRAM_ID = new PublicKey(KAMINO_LEND_PROGRAM_ID_STR);

const KAMINO_METADATA: ProtocolHandlerMetadata = {
  protocolId: "kamino-lending",
  displayName: "Kamino Lending",
  programIds: [KAMINO_LEND_PROGRAM_ID],
  supportedActions: new Map([
    ["deposit", { actionType: { deposit: {} }, isSpending: true }],
    ["borrow", { actionType: { withdraw: {} }, isSpending: false }],
    ["repay", { actionType: { deposit: {} }, isSpending: true }],
    ["withdraw", { actionType: { withdraw: {} }, isSpending: false }],
  ]),
};

export class KaminoHandler implements ProtocolHandler {
  readonly metadata = KAMINO_METADATA;

  // No initialize() needed — KaminoMarket.load() is stateless

  async compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult> {
    const common = {
      owner: ctx.owner,
      vaultId: ctx.vaultId,
      agent: ctx.agent,
    };

    switch (action) {
      case "deposit": {
        const result = await composeKaminoDeposit(ctx.program, ctx.connection, {
          ...common,
          amount: params.amount as any,
          tokenMint: params.tokenMint as PublicKey,
          market: params.market as PublicKey | undefined,
          feeDestinationTokenAccount: params.feeDestinationTokenAccount as
            | PublicKey
            | undefined,
        });
        return {
          instructions: result.instructions,
          additionalSigners: result.additionalSigners,
        };
      }

      case "borrow": {
        const result = await composeKaminoBorrow(ctx.program, ctx.connection, {
          ...common,
          amount: params.amount as any,
          tokenMint: params.tokenMint as PublicKey,
          market: params.market as PublicKey | undefined,
          feeDestinationTokenAccount: params.feeDestinationTokenAccount as
            | PublicKey
            | undefined,
        });
        return {
          instructions: result.instructions,
          additionalSigners: result.additionalSigners,
        };
      }

      case "repay": {
        const result = await composeKaminoRepay(ctx.program, ctx.connection, {
          ...common,
          amount: params.amount as any,
          tokenMint: params.tokenMint as PublicKey,
          market: params.market as PublicKey | undefined,
          feeDestinationTokenAccount: params.feeDestinationTokenAccount as
            | PublicKey
            | undefined,
        });
        return {
          instructions: result.instructions,
          additionalSigners: result.additionalSigners,
        };
      }

      case "withdraw": {
        const result = await composeKaminoWithdraw(
          ctx.program,
          ctx.connection,
          {
            ...common,
            amount: params.amount as any,
            tokenMint: params.tokenMint as PublicKey,
            market: params.market as PublicKey | undefined,
            feeDestinationTokenAccount: params.feeDestinationTokenAccount as
              | PublicKey
              | undefined,
          },
        );
        return {
          instructions: result.instructions,
          additionalSigners: result.additionalSigners,
        };
      }

      default:
        throw new Error(`Kamino handler: unsupported action "${action}"`);
    }
  }

  summarize(action: string, params: Record<string, unknown>): string {
    switch (action) {
      case "deposit":
        return `Kamino deposit ${params.amount} of ${params.tokenMint}`;
      case "borrow":
        return `Kamino borrow ${params.amount} of ${params.tokenMint}`;
      case "repay":
        return `Kamino repay ${params.amount} of ${params.tokenMint}`;
      case "withdraw":
        return `Kamino withdraw ${params.amount} of ${params.tokenMint}`;
      default:
        return `Kamino ${action}`;
    }
  }
}

// Register with the global protocol registry on module import
globalProtocolRegistry.register(new KaminoHandler());
