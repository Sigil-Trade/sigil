/**
 * PrivyWallet — WalletLike adapter for Privy TEE-backed signing.
 *
 * The private key lives in Privy's AWS Nitro Enclave.
 * The agent only gets a signing interface — it never sees or touches the key.
 *
 * Works with shieldWallet() out of the box:
 *   const wallet = shieldWallet(await privy({ appId, appSecret }), { maxSpend: '500 USDC/day' });
 */

import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { PrivyWalletConfig, validateConfig } from "./config.js";

/**
 * Minimal wallet interface — identical to the one in @usesigil/kit.
 * Duplicated here to avoid a hard dependency on the wrapper package.
 */
export interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]>;
}

/**
 * Abstraction over the Privy SDK client for testability.
 * In production, this wraps Privy's REST API.
 * In tests, a mock implementation is injected.
 */
export interface PrivySDKClient {
  /** Create a new Solana wallet and return its ID + address. */
  createWallet(params: {
    chainType: string;
  }): Promise<{ id: string; address: string }>;

  /** Get an existing wallet by its Privy wallet ID. */
  getWallet(walletId: string): Promise<{ id: string; address: string }>;

  /** Look up a wallet by its on-chain address. Returns null if not found. */
  getWalletByAddress(
    address: string,
  ): Promise<{ id: string; address: string } | null>;

  /** Sign a serialized transaction. Returns the signed transaction bytes (base64). */
  signTransaction(
    walletId: string,
    transaction: string,
    encoding: "base64",
  ): Promise<{ signedTransaction: string }>;
}

/**
 * Default SDK client that calls Privy's REST API directly.
 * Uses HTTP Basic Auth with appId:appSecret.
 */
export class PrivyRESTClient implements PrivySDKClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;

  constructor(appId: string, appSecret: string, baseUrl: string) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private get authHeaders(): Record<string, string> {
    const credentials = Buffer.from(`${this.appId}:${this.appSecret}`).toString(
      "base64",
    );
    return {
      Authorization: `Basic ${credentials}`,
      "privy-app-id": this.appId,
      "Content-Type": "application/json",
    };
  }

  async createWallet(params: {
    chainType: string;
  }): Promise<{ id: string; address: string }> {
    const res = await fetch(`${this.baseUrl}/v1/wallets`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify({ chain_type: params.chainType }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Privy wallet creation failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const id = data.id as string;
    const address = data.address as string;
    if (!id || !address) {
      throw new Error(
        "Privy wallet creation returned no id/address. Response: " +
          JSON.stringify(data),
      );
    }

    return { id, address };
  }

  async getWallet(walletId: string): Promise<{ id: string; address: string }> {
    const res = await fetch(
      `${this.baseUrl}/v1/wallets/${encodeURIComponent(walletId)}`,
      {
        method: "GET",
        headers: this.authHeaders,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Privy get wallet failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const id = data.id as string;
    const address = data.address as string;
    if (!id || !address) {
      throw new Error(
        "Privy wallet lookup returned no id/address. Response: " +
          JSON.stringify(data),
      );
    }

    return { id, address };
  }

  async getWalletByAddress(
    address: string,
  ): Promise<{ id: string; address: string } | null> {
    const res = await fetch(
      `${this.baseUrl}/v1/users?wallet_address=${encodeURIComponent(address)}`,
      {
        method: "GET",
        headers: this.authHeaders,
      },
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Privy wallet address lookup failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    // The user object has linked_accounts that include wallet entries
    const linkedAccounts = data.linked_accounts as Array<
      Record<string, unknown>
    >;
    if (linkedAccounts) {
      const walletEntry = linkedAccounts.find(
        (a) => a.address === address && a.type === "wallet",
      );
      if (walletEntry) {
        return {
          id: (walletEntry.wallet_id as string) || "",
          address: walletEntry.address as string,
        };
      }
    }

    // Server wallets may be returned directly
    if (data.id && data.address) {
      return { id: data.id as string, address: data.address as string };
    }

    return null;
  }

  async signTransaction(
    walletId: string,
    transaction: string,
    _encoding: "base64",
  ): Promise<{ signedTransaction: string }> {
    const res = await fetch(
      `${this.baseUrl}/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
      {
        method: "POST",
        headers: this.authHeaders,
        body: JSON.stringify({
          chain_type: "solana",
          method: "signTransaction",
          params: { transaction },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Privy transaction signing failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const signedTransaction = (data.data as Record<string, unknown> | undefined)
      ?.signed_transaction as string;
    if (!signedTransaction) {
      throw new Error(
        "Privy signing returned no signed_transaction. Response: " +
          JSON.stringify(data),
      );
    }

    return { signedTransaction };
  }
}

/**
 * PrivyWallet — a WalletLike that signs transactions via Privy's AWS Nitro Enclave.
 *
 * Use the static `create()` method to instantiate:
 *   const wallet = await PrivyWallet.create({ appId: '...', appSecret: '...' });
 *   const shielded = shieldWallet(wallet, { maxSpend: '500 USDC/day' });
 */
export class PrivyWallet implements WalletLike {
  readonly publicKey: PublicKey;
  readonly walletId: string;
  readonly provider: string = "privy";

  private readonly client: PrivySDKClient;

  private constructor(
    publicKey: PublicKey,
    walletId: string,
    client: PrivySDKClient,
  ) {
    this.publicKey = publicKey;
    this.walletId = walletId;
    this.client = client;
  }

  /**
   * Create a PrivyWallet. If no walletId is provided, a new wallet is created
   * via the Privy API. The private key never leaves the Nitro Enclave.
   */
  static async create(
    config: PrivyWalletConfig,
    /** Injectable SDK client for testing. Uses REST client by default. */
    client?: PrivySDKClient,
  ): Promise<PrivyWallet> {
    validateConfig(config);

    const baseUrl = config.baseUrl || "https://api.privy.io";
    const sdkClient =
      client || new PrivyRESTClient(config.appId, config.appSecret, baseUrl);

    let address: string;
    let walletId: string;

    if (config.walletId) {
      // Use existing wallet
      walletId = config.walletId;
      const wallet = await sdkClient.getWallet(walletId);
      address = wallet.address;
    } else {
      // Create new wallet
      const result = await sdkClient.createWallet({ chainType: "solana" });
      address = result.address;
      walletId = result.id;
    }

    const publicKey = new PublicKey(address);
    return new PrivyWallet(publicKey, walletId, sdkClient);
  }

  /**
   * Sign a transaction via Privy's AWS Nitro Enclave.
   * The transaction is serialized, sent to Privy, signed in hardware,
   * and the signed result is deserialized back.
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");

    const { signedTransaction } = await this.client.signTransaction(
      this.walletId,
      serialized,
      "base64",
    );

    const signedBytes = Buffer.from(signedTransaction, "base64");

    if (tx instanceof Transaction) {
      return Transaction.from(signedBytes) as T;
    } else {
      return VersionedTransaction.deserialize(signedBytes) as T;
    }
  }

  /**
   * Sign multiple transactions sequentially via the Nitro Enclave.
   */
  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    const results: T[] = [];
    for (const tx of txs) {
      results.push(await this.signTransaction(tx));
    }
    return results;
  }

  /**
   * API-based custody verification. Looks up this wallet's address in Privy's
   * system and confirms it exists under this app's custody.
   *
   * This proves the wallet is managed by Privy's AWS Nitro Enclave infrastructure
   * for the configured app. It does NOT provide cryptographic attestation —
   * it confirms the API server acknowledges custody of this key.
   */
  async verifyProviderCustody(): Promise<boolean> {
    const result = await this.client.getWallet(this.walletId);
    return result.address === this.publicKey.toBase58();
  }
}
