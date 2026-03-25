/**
 * TurnkeyWallet — WalletLike adapter for Turnkey TEE-backed signing.
 *
 * The private key lives in Turnkey's secure infrastructure.
 * The agent only gets a signing interface — it never sees or touches the key.
 *
 * Turnkey uses P-256 ECDSA request stamping for authentication:
 * 1. Hash the request body with SHA-256
 * 2. Sign the hash with the API private key (P-256 ECDSA)
 * 3. Send the stamp in the X-Stamp header as JSON
 *
 * Works with shieldWallet() out of the box:
 *   const wallet = shieldWallet(await turnkey({ organizationId, apiKeyId, apiPrivateKey }), { maxSpend: '500 USDC/day' });
 */

import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TurnkeyWalletConfig, validateConfig } from "./config";
import { createHash, sign, createPrivateKey } from "crypto";

/**
 * Minimal wallet interface — identical to the one in @phalnx/kit.
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
 * Abstraction over the Turnkey SDK client for testability.
 * In production, this wraps Turnkey's REST API with P-256 request stamping.
 * In tests, a mock implementation is injected.
 */
export interface TurnkeySDKClient {
  /** Create a new Solana wallet and return its ID + address. */
  createWallet(params: {
    walletName: string;
  }): Promise<{ walletId: string; address: string }>;

  /** Get an existing wallet's Solana address by wallet ID. */
  getWallet(walletId: string): Promise<{ walletId: string; address: string }>;

  /** Sign a serialized transaction. Returns the signed transaction bytes (base64). */
  signTransaction(
    walletId: string,
    transaction: string,
    encoding: "base64",
  ): Promise<{ signedTransaction: string }>;
}

/**
 * Create a Turnkey API stamp for request authentication.
 *
 * Turnkey uses P-256 ECDSA: hash the request body, sign with the API private key,
 * and include the stamp as a JSON-encoded X-Stamp header.
 */
function createStamp(
  body: string,
  apiKeyId: string,
  apiPrivateKey: string,
): string {
  const hash = createHash("sha256").update(body).digest();

  // Parse the PEM private key
  const key = createPrivateKey({
    key: apiPrivateKey,
    format: "pem",
    type: "pkcs8",
  });

  // Sign with P-256 ECDSA (DER-encoded signature)
  const signature = sign("sha256", hash, {
    key,
    dsaEncoding: "ieee-p1363",
  });

  const stamp = {
    publicKey: apiKeyId,
    signature: signature.toString("hex"),
    scheme: "SIGNATURE_SCHEME_TK_API_P256",
  };

  return JSON.stringify(stamp);
}

/**
 * Default SDK client that calls Turnkey's REST API with P-256 request stamping.
 */
export class TurnkeyRESTClient implements TurnkeySDKClient {
  private readonly organizationId: string;
  private readonly apiKeyId: string;
  private readonly apiPrivateKey: string;
  private readonly baseUrl: string;

  constructor(
    organizationId: string,
    apiKeyId: string,
    apiPrivateKey: string,
    baseUrl: string,
  ) {
    this.organizationId = organizationId;
    this.apiKeyId = apiKeyId;
    this.apiPrivateKey = apiPrivateKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async stampedRequest(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const bodyStr = JSON.stringify(body);
    const stamp = createStamp(bodyStr, this.apiKeyId, this.apiPrivateKey);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stamp": stamp,
      },
      body: bodyStr,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Turnkey API error (${res.status}): ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  async createWallet(params: {
    walletName: string;
  }): Promise<{ walletId: string; address: string }> {
    const data = await this.stampedRequest("/public/v1/submit/create_wallet", {
      type: "ACTIVITY_TYPE_CREATE_WALLET",
      timestampMs: Date.now().toString(),
      organizationId: this.organizationId,
      parameters: {
        walletName: params.walletName,
        accounts: [
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/501'/0'/0'",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      },
    });

    const activity = data.activity as Record<string, unknown> | undefined;
    const result = activity?.result as Record<string, unknown> | undefined;
    const walletResult = result?.createWalletResult as
      | Record<string, unknown>
      | undefined;
    const walletId = walletResult?.walletId as string;
    const addresses = walletResult?.addresses as
      | Array<Record<string, unknown>>
      | undefined;
    const address = addresses?.[0]?.address as string;

    if (!walletId || !address) {
      throw new Error(
        "Turnkey wallet creation returned no walletId/address. Response: " +
          JSON.stringify(data),
      );
    }

    return { walletId, address };
  }

  async getWallet(
    walletId: string,
  ): Promise<{ walletId: string; address: string }> {
    const data = await this.stampedRequest(
      "/public/v1/query/get_wallet_accounts",
      {
        organizationId: this.organizationId,
        walletId,
      },
    );

    const accounts = data.accounts as
      | Array<Record<string, unknown>>
      | undefined;
    const solanaAccount = accounts?.find(
      (a) => a.addressFormat === "ADDRESS_FORMAT_SOLANA",
    );
    const address = solanaAccount?.address as string;

    if (!address) {
      throw new Error(
        "Turnkey wallet lookup returned no Solana address. Response: " +
          JSON.stringify(data),
      );
    }

    return { walletId, address };
  }

  async signTransaction(
    walletId: string,
    transaction: string,
    _encoding: "base64",
  ): Promise<{ signedTransaction: string }> {
    const data = await this.stampedRequest(
      "/public/v1/submit/sign_transaction",
      {
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION",
        timestampMs: Date.now().toString(),
        organizationId: this.organizationId,
        parameters: {
          signWith: walletId,
          unsignedTransaction: transaction,
          type: "TRANSACTION_TYPE_SOLANA",
        },
      },
    );

    const activity = data.activity as Record<string, unknown> | undefined;
    const result = activity?.result as Record<string, unknown> | undefined;
    const signResult = result?.signTransactionResult as
      | Record<string, unknown>
      | undefined;
    const signedTransaction = signResult?.signedTransaction as string;

    if (!signedTransaction) {
      throw new Error(
        "Turnkey signing returned no signedTransaction. Response: " +
          JSON.stringify(data),
      );
    }

    return { signedTransaction };
  }
}

/**
 * TurnkeyWallet — a WalletLike that signs transactions via Turnkey's secure infrastructure.
 *
 * Use the static `create()` method to instantiate:
 *   const wallet = await TurnkeyWallet.create({ organizationId: '...', apiKeyId: '...', apiPrivateKey: '...' });
 *   const shielded = shieldWallet(wallet, { maxSpend: '500 USDC/day' });
 */
export class TurnkeyWallet implements WalletLike {
  readonly publicKey: PublicKey;
  readonly walletId: string;
  readonly provider: string = "turnkey";

  private readonly client: TurnkeySDKClient;

  private constructor(
    publicKey: PublicKey,
    walletId: string,
    client: TurnkeySDKClient,
  ) {
    this.publicKey = publicKey;
    this.walletId = walletId;
    this.client = client;
  }

  /**
   * Create a TurnkeyWallet. If no walletId is provided, a new wallet is created
   * via the Turnkey API. The private key never leaves Turnkey's secure infrastructure.
   */
  static async create(
    config: TurnkeyWalletConfig,
    /** Injectable SDK client for testing. Uses REST client by default. */
    client?: TurnkeySDKClient,
  ): Promise<TurnkeyWallet> {
    validateConfig(config);

    const baseUrl = config.baseUrl || "https://api.turnkey.com";
    const sdkClient =
      client ||
      new TurnkeyRESTClient(
        config.organizationId,
        config.apiKeyId,
        config.apiPrivateKey,
        baseUrl,
      );

    let address: string;
    let walletId: string;

    if (config.walletId) {
      // Use existing wallet
      walletId = config.walletId;
      const wallet = await sdkClient.getWallet(walletId);
      address = wallet.address;
    } else {
      // Create new wallet
      const result = await sdkClient.createWallet({
        walletName: `phalnx-agent-${Date.now()}`,
      });
      address = result.address;
      walletId = result.walletId;
    }

    const publicKey = new PublicKey(address);
    return new TurnkeyWallet(publicKey, walletId, sdkClient);
  }

  /**
   * Sign a transaction via Turnkey's secure infrastructure.
   * The transaction is serialized, sent to Turnkey, signed in hardware,
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
   * Sign multiple transactions sequentially via Turnkey.
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
   * API-based custody verification. Looks up this wallet in Turnkey's
   * system and confirms the Solana address matches.
   */
  async verifyProviderCustody(): Promise<boolean> {
    const result = await this.client.getWallet(this.walletId);
    return result.address === this.publicKey.toBase58();
  }
}
