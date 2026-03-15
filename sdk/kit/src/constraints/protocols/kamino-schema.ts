/**
 * Kamino Lending Protocol Schema — Instruction Layouts
 *
 * All discriminators, field offsets, and account indices are sourced from
 * the Kamino KLend program IDL.
 *
 * All 4 instructions have identical data layout: [8 disc][8 amount] = 16 bytes.
 * The u64 amount field is at offset 8 for all instructions.
 */

import type { Address } from "@solana/kit";
import type { InstructionSchema, ProtocolSchema } from "../types.js";

export const KAMINO_LENDING_PROGRAM: Address =
  "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;

// ─── Discriminator Constants ────────────────────────────────────────────────

export const DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR = new Uint8Array([108, 209, 4, 72, 21, 22, 118, 133]);
export const BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR = new Uint8Array([121, 127, 18, 204, 73, 245, 225, 65]);
export const REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR = new Uint8Array([145, 178, 13, 225, 76, 240, 147, 72]);
export const WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR = new Uint8Array([75, 93, 93, 220, 34, 150, 218, 196]);

// ─── Instruction Schemas ────────────────────────────────────────────────────

const depositCollateral: InstructionSchema = {
  name: "depositCollateral",
  discriminator: DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR,
  fields: [
    { name: "collateralAmount", offset: 8, type: "u64", size: 8 },
  ],
  accounts: { depositReserve: 3 },
  dataSize: 16, // 8+8
};

const borrowLiquidity: InstructionSchema = {
  name: "borrowLiquidity",
  discriminator: BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  fields: [
    { name: "liquidityAmount", offset: 8, type: "u64", size: 8 },
  ],
  accounts: { borrowReserve: 4 },
  dataSize: 16, // 8+8
};

const repayLiquidity: InstructionSchema = {
  name: "repayLiquidity",
  discriminator: REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  fields: [
    { name: "liquidityAmount", offset: 8, type: "u64", size: 8 },
  ],
  accounts: { repayReserve: 3 },
  dataSize: 16, // 8+8
};

const withdrawCollateral: InstructionSchema = {
  name: "withdrawCollateral",
  discriminator: WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR,
  fields: [
    { name: "collateralAmount", offset: 8, type: "u64", size: 8 },
  ],
  accounts: { withdrawReserve: 4 },
  dataSize: 16, // 8+8
};

// ─── Protocol Schema ────────────────────────────────────────────────────────

const instructions = new Map<string, InstructionSchema>();
for (const ix of [
  depositCollateral,
  borrowLiquidity,
  repayLiquidity,
  withdrawCollateral,
]) {
  instructions.set(ix.name, ix);
}

export const KAMINO_SCHEMA: ProtocolSchema = {
  protocolId: "kamino",
  programAddress: KAMINO_LENDING_PROGRAM,
  instructions,
};

// ─── Action Categories ──────────────────────────────────────────────────────

/** Actions that put money INTO the protocol (deposit, repay) */
export const KAMINO_SPENDING_ACTIONS = [
  "depositCollateral",
  "repayLiquidity",
] as const;

/** Actions that get money OUT of the protocol (borrow, withdraw) */
export const KAMINO_RISK_REDUCING_ACTIONS = [
  "borrowLiquidity",
  "withdrawCollateral",
] as const;

/** Actions with an amount field (all 4 for Kamino) */
export const KAMINO_AMOUNT_CONSTRAINED_ACTIONS = [
  "depositCollateral",
  "borrowLiquidity",
  "repayLiquidity",
  "withdrawCollateral",
] as const;
