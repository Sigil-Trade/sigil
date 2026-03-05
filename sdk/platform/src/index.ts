/**
 * @phalnx/platform
 *
 * Lightweight client for agents to request TEE wallet provisioning
 * via the Phalnx platform's Solana Actions endpoints.
 *
 * @example
 * ```typescript
 * const platform = new PhalnxPlatform("https://app.phalnx.io");
 *
 * // 1. Generate Action URL for user to sign
 * const actionUrl = platform.getProvisionActionUrl({ dailyCap: 500 });
 *
 * // 2. Or get a blink URL (for in-chat rendering)
 * const blinkUrl = platform.getBlinkUrl({ dailyCap: 500 });
 *
 * // 3. Poll for result after user signs
 * const result = await platform.waitForProvision(txSignature);
 * // → { vaultAddress, agentPubkey, agentLocator }
 * ```
 */

export interface ProvisionOptions {
  /** Daily spending cap in USDC (e.g. 500 = 500 USDC/day) */
  dailyCap?: number;
  /** Policy template: "conservative" | "moderate" | "aggressive" */
  template?: string;
}

export interface ActionMetadata {
  type: string;
  icon: string;
  title: string;
  description: string;
  label: string;
  links: {
    actions: Array<{
      label: string;
      href: string;
      parameters?: Array<{
        name: string;
        label: string;
        required?: boolean;
      }>;
    }>;
  };
}

export interface ProvisionResult {
  status: "pending" | "confirmed" | "not_found";
  vaultAddress?: string;
  agentPubkey?: string;
  agentLocator?: string;
  template?: string;
  error?: string;
}

export class PhalnxPlatform {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Get the Solana Action URL for vault provisioning.
   * This URL can be presented to users in chat, blink renderers, or dashboards.
   */
  getProvisionActionUrl(options: ProvisionOptions = {}): string {
    const params = new URLSearchParams();

    if (options.template) {
      params.set("template", options.template);
    }
    if (options.dailyCap) {
      params.set("dailyCap", options.dailyCap.toString());
    }

    const query = params.toString();
    return `${this.baseUrl}/api/actions/provision${query ? `?${query}` : ""}`;
  }

  /**
   * Get a Dialect blink URL that renders the Action in-chat.
   */
  getBlinkUrl(options: ProvisionOptions = {}): string {
    const actionUrl = this.getProvisionActionUrl(options);
    return `https://dial.to/?action=solana-action:${encodeURIComponent(actionUrl)}`;
  }

  /**
   * Fetch the Action metadata (GET endpoint).
   */
  async getActionMetadata(): Promise<ActionMetadata> {
    const res = await fetch(`${this.baseUrl}/api/actions/provision`, {
      method: "GET",
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch action metadata: ${res.status}`);
    }

    return res.json() as Promise<ActionMetadata>;
  }

  /**
   * Request a provision transaction for a specific account.
   * Returns the base64-encoded unsigned VersionedTransaction.
   */
  async requestProvision(
    account: string,
    options: ProvisionOptions = {},
  ): Promise<{ transaction: string; message?: string }> {
    const actionUrl = this.getProvisionActionUrl(options);

    const res = await fetch(actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account }),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(
        (error as any).error || `Provision request failed: ${res.status}`,
      );
    }

    return res.json() as Promise<{ transaction: string; message?: string }>;
  }

  /**
   * Poll the status endpoint for a provision result.
   */
  async checkStatus(txSignature: string): Promise<ProvisionResult> {
    const res = await fetch(
      `${this.baseUrl}/api/actions/status/${txSignature}`,
      { method: "GET" },
    );

    if (!res.ok) {
      throw new Error(`Status check failed: ${res.status}`);
    }

    return res.json() as Promise<ProvisionResult>;
  }

  /**
   * Poll until the provision is confirmed or times out.
   *
   * @param txSignature - The transaction signature from user's wallet
   * @param timeoutMs - Max time to wait (default: 60s)
   * @param intervalMs - Poll interval (default: 2s)
   */
  async waitForProvision(
    txSignature: string,
    timeoutMs: number = 60_000,
    intervalMs: number = 2_000,
  ): Promise<ProvisionResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.checkStatus(txSignature);

      if (result.status === "confirmed") {
        return result;
      }

      if (result.status === "not_found" && result.error) {
        throw new Error(`Provision failed: ${result.error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Provision timed out after ${timeoutMs}ms. TX: ${txSignature}`,
    );
  }

  /**
   * Generate a human-readable message with the Action URL for the user.
   */
  formatProvisionMessage(options: ProvisionOptions = {}): string {
    const actionUrl = this.getProvisionActionUrl(options);
    const blinkUrl = this.getBlinkUrl(options);
    const dailyCap = options.dailyCap || 500;
    const template = options.template || "conservative";

    return [
      `I need a protected wallet to trade. Please approve the vault creation:`,
      ``,
      `**Policy:** ${template} (${dailyCap} USDC/day cap)`,
      `**Action URL:** ${actionUrl}`,
      `**Blink:** ${blinkUrl}`,
      ``,
      `Click the link above or paste the Action URL in any Solana blink-compatible app.`,
    ].join("\n");
  }
}
