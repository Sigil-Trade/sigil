/**
 * VelocityTracker — Kit-native Agent Manipulation Defense
 *
 * Monitors transaction velocity (TX/min, TX/hr, USD/hr) and detects
 * rapid-fire transaction patterns that may indicate agent manipulation.
 *
 * Integrates with ShieldState for unified spending tracking.
 */

import type { Address } from "@solana/kit";
import type { ShieldState } from "./shield.js";
import { ShieldDeniedError, type PolicyViolation } from "./shield.js";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface VelocityConfig {
  /** Max transactions per minute (default: 10) */
  maxTxPerMinute?: number;
  /** Max transactions per hour (default: 60) */
  maxTxPerHour?: number;
  /** Max USD spend per hour in base units (default: 500_000_000n = $500) */
  maxUsdPerHour?: bigint;
  /** Rapid-fire detection: count transactions within windowMs */
  rapidFireThreshold?: {
    count: number;
    windowMs: number;
  };
  /** Cooldown period in ms after velocity breach (default: 30_000 = 30s) */
  cooldownMs?: number;
}

const DEFAULT_CONFIG: Required<VelocityConfig> = {
  maxTxPerMinute: 10,
  maxTxPerHour: 60,
  maxUsdPerHour: 500_000_000n,
  rapidFireThreshold: { count: 5, windowMs: 10_000 },
  cooldownMs: 30_000,
};

// ─── VelocityTracker ────────────────────────────────────────────────────────

export class VelocityTracker {
  private readonly state: ShieldState;
  private readonly config: Required<VelocityConfig>;
  private cooldownUntil = 0;
  private txTimestamps: number[] = [];

  constructor(state: ShieldState, config?: VelocityConfig) {
    this.state = state;
    this.config = {
      maxTxPerMinute: config?.maxTxPerMinute ?? DEFAULT_CONFIG.maxTxPerMinute,
      maxTxPerHour: config?.maxTxPerHour ?? DEFAULT_CONFIG.maxTxPerHour,
      maxUsdPerHour: config?.maxUsdPerHour ?? DEFAULT_CONFIG.maxUsdPerHour,
      rapidFireThreshold: config?.rapidFireThreshold ?? DEFAULT_CONFIG.rapidFireThreshold,
      cooldownMs: config?.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
    };
  }

  /**
   * Check velocity constraints. Throws ShieldDeniedError (code 7022) on breach.
   */
  check(signerAddress: Address): void {
    const violations: PolicyViolation[] = [];

    // 0. Cooldown check
    if (this.isInCooldown()) {
      const remainingMs = this.cooldownUntil - Date.now();
      throw new ShieldDeniedError([
        {
          rule: "velocity_cooldown",
          message: `Velocity cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining`,
          suggestion: "Wait for the cooldown period to expire",
        },
      ]);
    }

    // 1. TX/minute check
    const txPerMinute = this.state.getTransactionCountInWindow(60_000);
    if (txPerMinute >= this.config.maxTxPerMinute) {
      violations.push({
        rule: "velocity_tx_per_minute",
        message: `Transaction rate ${txPerMinute}/${this.config.maxTxPerMinute} per minute exceeded`,
        suggestion: "Wait before sending more transactions",
      });
    }

    // 2. TX/hour check
    const txPerHour = this.state.getTransactionCountInWindow(3_600_000);
    if (txPerHour >= this.config.maxTxPerHour) {
      violations.push({
        rule: "velocity_tx_per_hour",
        message: `Transaction rate ${txPerHour}/${this.config.maxTxPerHour} per hour exceeded`,
        suggestion: "Wait before sending more transactions",
      });
    }

    // 3. USD/hour check
    const usdPerHour = this.state.getSpendInWindow("", 3_600_000);
    if (usdPerHour >= this.config.maxUsdPerHour) {
      violations.push({
        rule: "velocity_usd_per_hour",
        message: `Hourly USD spend ${usdPerHour} exceeds ceiling ${this.config.maxUsdPerHour}`,
        suggestion: "Reduce transaction amounts or wait for the window to reset",
      });
    }

    // 4. Rapid-fire detection
    const now = Date.now();
    this.txTimestamps.push(now);
    // Trim timestamps outside the rapid-fire window
    const cutoff = now - this.config.rapidFireThreshold.windowMs;
    this.txTimestamps = this.txTimestamps.filter((t) => t >= cutoff);

    if (this.txTimestamps.length >= this.config.rapidFireThreshold.count) {
      violations.push({
        rule: "velocity_rapid_fire",
        message: `Rapid-fire detected: ${this.txTimestamps.length} transactions in ${this.config.rapidFireThreshold.windowMs}ms`,
        suggestion: "Possible agent manipulation — transactions blocked",
      });
    }

    if (violations.length > 0) {
      // Trigger cooldown
      this.cooldownUntil = now + this.config.cooldownMs;
      throw new ShieldDeniedError(violations);
    }
  }

  /**
   * Record a transaction after successful send.
   */
  recordTransaction(usdAmount?: bigint): void {
    this.state.recordTransaction();
    if (usdAmount !== undefined) {
      this.state.recordSpend("", usdAmount);
    }
  }

  /**
   * Whether the tracker is in a cooldown period after a velocity breach.
   */
  isInCooldown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  /**
   * Get remaining cooldown time in ms. Returns 0 if not in cooldown.
   */
  getCooldownRemainingMs(): number {
    const remaining = this.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Reset the tracker (clears cooldown and timestamps).
   */
  reset(): void {
    this.cooldownUntil = 0;
    this.txTimestamps = [];
  }

  /**
   * Get current velocity stats.
   */
  getStats(): {
    txPerMinute: number;
    txPerHour: number;
    usdPerHour: bigint;
    inCooldown: boolean;
    cooldownRemainingMs: number;
  } {
    return {
      txPerMinute: this.state.getTransactionCountInWindow(60_000),
      txPerHour: this.state.getTransactionCountInWindow(3_600_000),
      usdPerHour: this.state.getSpendInWindow("", 3_600_000),
      inCooldown: this.isInCooldown(),
      cooldownRemainingMs: this.getCooldownRemainingMs(),
    };
  }
}
