/**
 * Drift Protocol Handler
 *
 * Implements ProtocolHandler interface for the protocol registry.
 * Wraps the Drift compose functions into a uniform dispatch mechanism.
 * Registers with globalProtocolRegistry on import.
 */

import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
  ProtocolContext,
  ProtocolComposeResult,
} from "./protocol-handler";
import {
  DRIFT_PROGRAM_ID_STR,
  composeDriftDeposit,
  composeDriftWithdraw,
  composeDriftPlacePerpOrder,
  composeDriftPlaceSpotOrder,
  composeDriftCancelOrder,
  composeDriftModifyOrder,
  composeDriftSettlePnl,
  getDriftClient,
} from "./drift";
import { globalProtocolRegistry } from "./protocol-registry";

const DRIFT_PROGRAM_ID = new PublicKey(DRIFT_PROGRAM_ID_STR);

const DRIFT_METADATA: ProtocolHandlerMetadata = {
  protocolId: "drift",
  displayName: "Drift Protocol",
  programIds: [DRIFT_PROGRAM_ID],
  supportedActions: new Map([
    ["deposit", { actionType: { deposit: {} }, isSpending: true }],
    ["withdraw", { actionType: { withdraw: {} }, isSpending: false }],
    ["placePerpOrder", { actionType: { openPosition: {} }, isSpending: true }],
    ["placeSpotOrder", { actionType: { swap: {} }, isSpending: true }],
    [
      "cancelOrder",
      { actionType: { cancelLimitOrder: {} }, isSpending: false },
    ],
    ["modifyOrder", { actionType: { editLimitOrder: {} }, isSpending: false }],
    ["settlePnl", { actionType: { closePosition: {} }, isSpending: false }],
  ]),
};

export class DriftHandler implements ProtocolHandler {
  readonly metadata = DRIFT_METADATA;

  async initialize(connection: Connection): Promise<void> {
    // Pre-warm the DriftClient cache by creating and subscribing
    await getDriftClient(connection, {
      publicKey: PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
    });
  }

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
        const result = await composeDriftDeposit(ctx.program, ctx.connection, {
          ...common,
          amount: params.amount as any,
          marketIndex: params.marketIndex as number,
          tokenMint: params.tokenMint as PublicKey,
          subAccountId: params.subAccountId as number | undefined,
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
        const result = await composeDriftWithdraw(ctx.program, ctx.connection, {
          ...common,
          amount: params.amount as any,
          marketIndex: params.marketIndex as number,
          tokenMint: params.tokenMint as PublicKey,
          subAccountId: params.subAccountId as number | undefined,
          feeDestinationTokenAccount: params.feeDestinationTokenAccount as
            | PublicKey
            | undefined,
        });
        return {
          instructions: result.instructions,
          additionalSigners: result.additionalSigners,
        };
      }

      case "placePerpOrder": {
        const result = await composeDriftPlacePerpOrder(
          ctx.program,
          ctx.connection,
          {
            ...common,
            marketIndex: params.marketIndex as number,
            side: params.side as "long" | "short",
            amount: params.amount as any,
            price: params.price as any | undefined,
            orderType: params.orderType as any,
            tokenMint: params.tokenMint as PublicKey,
            subAccountId: params.subAccountId as number | undefined,
            leverageBps: params.leverageBps as number | undefined,
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

      case "placeSpotOrder": {
        const result = await composeDriftPlaceSpotOrder(
          ctx.program,
          ctx.connection,
          {
            ...common,
            marketIndex: params.marketIndex as number,
            side: params.side as "long" | "short",
            amount: params.amount as any,
            price: params.price as any | undefined,
            orderType: params.orderType as any,
            tokenMint: params.tokenMint as PublicKey,
            subAccountId: params.subAccountId as number | undefined,
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

      case "cancelOrder": {
        const result = await composeDriftCancelOrder(
          ctx.program,
          ctx.connection,
          {
            ...common,
            orderId: params.orderId as number,
            tokenMint: params.tokenMint as PublicKey,
            subAccountId: params.subAccountId as number | undefined,
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

      case "modifyOrder": {
        const result = await composeDriftModifyOrder(
          ctx.program,
          ctx.connection,
          {
            ...common,
            orderId: params.orderId as number,
            tokenMint: params.tokenMint as PublicKey,
            newAmount: params.newAmount as any | undefined,
            newPrice: params.newPrice as any | undefined,
            subAccountId: params.subAccountId as number | undefined,
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

      case "settlePnl": {
        const result = await composeDriftSettlePnl(
          ctx.program,
          ctx.connection,
          {
            ...common,
            marketIndex: params.marketIndex as number,
            tokenMint: params.tokenMint as PublicKey,
            subAccountId: params.subAccountId as number | undefined,
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
        throw new Error(`Drift handler: unsupported action "${action}"`);
    }
  }

  summarize(action: string, params: Record<string, unknown>): string {
    switch (action) {
      case "deposit":
        return `Drift deposit ${params.amount} to market ${params.marketIndex}`;
      case "withdraw":
        return `Drift withdraw ${params.amount} from market ${params.marketIndex}`;
      case "placePerpOrder":
        return `Drift ${params.side} perp order on market ${params.marketIndex}, ${params.orderType} ${params.amount}`;
      case "placeSpotOrder":
        return `Drift ${params.side} spot order on market ${params.marketIndex}, ${params.orderType} ${params.amount}`;
      case "cancelOrder":
        return `Drift cancel order #${params.orderId}`;
      case "modifyOrder":
        return `Drift modify order #${params.orderId}`;
      case "settlePnl":
        return `Drift settle PnL on market ${params.marketIndex}`;
      default:
        return `Drift ${action}`;
    }
  }
}

// Register with the global protocol registry on module import
globalProtocolRegistry.register(new DriftHandler());
