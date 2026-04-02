/**
 * CrossmintWallet — WalletLike adapter for Crossmint TEE-backed signing.
 *
 * The private key lives in Crossmint's hardware enclave (Intel TDX).
 * The agent only gets a signing interface — it never sees or touches the key.
 *
 * Works with shieldWallet() out of the box:
 *   const wallet = shieldWallet(await crossmint({ apiKey }), { maxSpend: '500 USDC/day' });
 */

import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { CrossmintWalletConfig, validateConfig } from "./config.js";

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
 * Abstraction over the Crossmint SDK client for testability.
 * In production, this wraps @crossmint/wallets-sdk.
 * In tests, a mock implementation is injected.
 */
export interface CrossmintSDKClient {
  /** Create a new wallet and return its address + locator. */
  createWallet(params: {
    chain: string;
    signer: { type: string };
    linkedUser?: string;
  }): Promise<{ address: string; locator: string }>;

  /** Get an existing wallet's address by locator. */
  getWallet(locator: string): Promise<{ address: string }>;

  /** Sign a serialized transaction. Returns the signed transaction bytes (base64). */
  signTransaction(
    locator: string,
    transaction: string,
    encoding: "base58" | "base64",
  ): Promise<{ signedTransaction: string }>;
}

/**
 * Default SDK client that calls Crossmint's REST API directly.
 * This avoids a hard dependency on @crossmint/wallets-sdk at runtime,
 * making it easy to swap, mock, or use the REST API directly.
 */
export class CrossmintRESTClient implements CrossmintSDKClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createWallet(params: {
    chain: string;
    signer: { type: string };
    linkedUser?: string;
  }): Promise<{ address: string; locator: string }> {
    const body: Record<string, unknown> = {
      type: "solana-mpc-wallet",
      config: {
        adminSigner: { type: params.signer.type },
      },
    };
    if (params.linkedUser) {
      body.linkedUser = params.linkedUser;
    }

    const res = await fetch(`${this.baseUrl}/api/2022-06-09/wallets`, {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Crossmint wallet creation failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const address = data.address as string;
    if (!address) {
      throw new Error(
        "Crossmint wallet creation returned no address. Response: " +
          JSON.stringify(data),
      );
    }

    const locator = (data.locator as string) || `wallet:${address}`;
    return { address, locator };
  }

  async getWallet(locator: string): Promise<{ address: string }> {
    const encodedLocator = encodeURIComponent(locator);
    const res = await fetch(
      `${this.baseUrl}/api/2022-06-09/wallets/${encodedLocator}`,
      {
        method: "GET",
        headers: {
          "X-API-KEY": this.apiKey,
        },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Crossmint get wallet failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const address = data.address as string;
    if (!address) {
      throw new Error(
        "Crossmint wallet lookup returned no address. Response: " +
          JSON.stringify(data),
      );
    }

    return { address };
  }

  async signTransaction(
    locator: string,
    transaction: string,
    encoding: "base58" | "base64",
  ): Promise<{ signedTransaction: string }> {
    const encodedLocator = encodeURIComponent(locator);
    const res = await fetch(
      `${this.baseUrl}/api/2022-06-09/wallets/${encodedLocator}/transactions`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          params: {
            transaction,
            encoding,
          },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Crossmint transaction signing failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const signedTransaction = data.signedTransaction as string;
    if (!signedTransaction) {
      throw new Error(
        "Crossmint signing returned no signedTransaction. Response: " +
          JSON.stringify(data),
      );
    }

    return { signedTransaction };
  }
}

/**
 * CrossmintWallet — a WalletLike that signs transactions via Crossmint's TEE.
 *
 * Use the static `create()` method to instantiate:
 *   const wallet = await CrossmintWallet.create({ apiKey: '...' });
 *   const shielded = shieldWallet(wallet, { maxSpend: '500 USDC/day' });
 */
export class CrossmintWallet implements WalletLike {
  readonly publicKey: PublicKey;
  readonly locator: string;
  readonly provider: string = "crossmint";

  private readonly client: CrossmintSDKClient;

  private constructor(
    publicKey: PublicKey,
    locator: string,
    client: CrossmintSDKClient,
  ) {
    this.publicKey = publicKey;
    this.locator = locator;
    this.client = client;
  }

  /**
   * Create a CrossmintWallet. If no locator is provided, a new wallet is created
   * via the Crossmint API. The private key never leaves the TEE.
   */
  static async create(
    config: CrossmintWalletConfig,
    /** Injectable SDK client for testing. Uses REST client by default. */
    client?: CrossmintSDKClient,
  ): Promise<CrossmintWallet> {
    validateConfig(config);

    const baseUrl = config.baseUrl || "https://www.crossmint.com";
    const sdkClient = client || new CrossmintRESTClient(config.apiKey, baseUrl);
    const chain = config.chain || "solana";
    const signerType = config.signerType || "api-key";

    let address: string;
    let locator: string;

    if (config.locator) {
      // Use existing wallet
      locator = config.locator;
      const wallet = await sdkClient.getWallet(locator);
      address = wallet.address;
    } else {
      // Create new wallet
      const result = await sdkClient.createWallet({
        chain,
        signer: { type: signerType },
        linkedUser: config.linkedUser,
      });
      address = result.address;
      locator = result.locator;
    }

    const publicKey = new PublicKey(address);
    return new CrossmintWallet(publicKey, locator, sdkClient);
  }

  /**
   * Sign a transaction via Crossmint's TEE.
   * The transaction is serialized, sent to Crossmint, signed in hardware,
   * and the signed result is deserialized back.
   */
  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    const serialized = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString("base64");

    const { signedTransaction } = await this.client.signTransaction(
      this.locator,
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
   * Sign multiple transactions sequentially via the TEE.
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
   * API-based custody verification. Calls Crossmint's getWallet() API and
   * confirms the returned address matches this wallet's public key.
   */
  async verifyProviderCustody(): Promise<boolean> {
    const result = await this.client.getWallet(this.locator);
    return result.address === this.publicKey.toBase58();
  }

  /**
   * TEE attestation stub. Crossmint uses managed Intel TDX infrastructure
   * and does not expose attestation documents publicly. Returns null to
   * indicate attestation data is unavailable — the verifier will fall back
   * to ProviderTrusted status.
   */
  async getAttestation(): Promise<null> {
    return null;
  }
}
