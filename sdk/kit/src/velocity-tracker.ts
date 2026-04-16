/**
 * VelocityTracker — Kit-native Agent Manipulation Defense
 *
 * Monitors transaction velocity (TX/min, TX/hr, USD/hr) and detects
 * rapid-fire transaction patterns that may indicate agent manipulation.
 *
 * Integrates with ShieldState for unified spending tracking.
 */

import type { Address } from "./kit-adapter.js";
import type { ShieldState } from "./shield.js";
import { ShieldDeniedError, type PolicyViolation } from "./shield.js";

// ─── Spend Status ────────────────────────────────────────────────────────────

export interface SpendStatus {
  globalSpent24h: bigint;
  globalCap: bigint | null;
  globalRemaining: bigint | null;
  agentSpent24h: bigint | null;
  agentCap: bigint | null;
  source: "on-chain" | "client-side";
}

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
      rapidFireThreshold:
        config?.rapidFireThreshold ?? DEFAULT_CONFIG.rapidFireThreshold,
      cooldownMs: config?.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
    };
  }

  /**
   * Check velocity constraints. Throws ShieldDeniedError (code 7022) on breach.
   *
   * @param signerAddress - The signer to check
   * @param dryRun - S-6: When true, checks without incrementing the rapid-fire counter.
   *                 Useful for precheck queries that shouldn't pollute velocity state.
   */
  check(signerAddress: Address, dryRun = false): void {
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

    // 3. USD/hour check (cross-mint aggregation — BUG-3 fix)
    const usdPerHour = this.state.getTotalSpendInWindow(3_600_000);
    if (usdPerHour >= this.config.maxUsdPerHour) {
      violations.push({
        rule: "velocity_usd_per_hour",
        message: `Hourly USD spend ${usdPerHour} exceeds ceiling ${this.config.maxUsdPerHour}`,
        suggestion:
          "Reduce transaction amounts or wait for the window to reset",
      });
    }

    // 3b. On-chain 24h cap check (when synced)
    const rs = this.state.resolvedState;
    if (rs) {
      const effectiveSpent = this.state.getEffectiveGlobalSpent24h();
      if (effectiveSpent >= rs.globalBudget.cap) {
        violations.push({
          rule: "velocity_on_chain_cap",
          message: `On-chain daily cap reached: ${effectiveSpent} >= ${rs.globalBudget.cap}`,
          suggestion: "Wait for the 24h rolling window to expire some spend",
        });
      }
    }

    // 4. Rapid-fire detection
    const now = Date.now();
    // S-6: Filter existing timestamps regardless of dryRun
    const cutoff = now - this.config.rapidFireThreshold.windowMs;
    this.txTimestamps = this.txTimestamps.filter((t) => t >= cutoff);

    // Compute what the count would be if we added this check
    const wouldBeCount = this.txTimestamps.length + 1;
    if (wouldBeCount >= this.config.rapidFireThreshold.count) {
      violations.push({
        rule: "velocity_rapid_fire",
        message: `Rapid-fire detected: ${wouldBeCount} transactions in ${this.config.rapidFireThreshold.windowMs}ms`,
        suggestion: "Possible agent manipulation — transactions blocked",
      });
    }

    if (violations.length > 0) {
      // Trigger cooldown
      this.cooldownUntil = now + this.config.cooldownMs;
      throw new ShieldDeniedError(violations);
    }

    // S-6: Only push timestamp if not a dry run
    if (!dryRun) {
      this.txTimestamps.push(now);
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
   * Get current spend status. Returns on-chain data when ShieldState is synced.
   */
  getSpendStatus(): SpendStatus {
    const rs = this.state.resolvedState;
    if (rs) {
      return {
        globalSpent24h: this.state.getEffectiveGlobalSpent24h(),
        globalCap: rs.globalBudget.cap,
        globalRemaining: this.state.getEffectiveGlobalRemaining(),
        agentSpent24h: this.state.getEffectiveAgentSpent24h(),
        agentCap: rs.agentBudget?.cap ?? null,
        source: "on-chain",
      };
    }
    const clientSpend = this.state.getTotalSpendInWindow(86_400_000);
    return {
      globalSpent24h: clientSpend,
      globalCap: null,
      globalRemaining: null,
      agentSpent24h: null,
      agentCap: null,
      source: "client-side",
    };
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
      usdPerHour: this.state.getTotalSpendInWindow(3_600_000),
      inCooldown: this.isInCooldown(),
      cooldownRemainingMs: this.getCooldownRemainingMs(),
    };
  }
}
