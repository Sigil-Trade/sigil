// ---------------------------------------------------------------------------
// Jupiter API Foundation Layer
// ---------------------------------------------------------------------------
// Shared HTTP client with API key, retry, and modern base URL.
// All Jupiter integration modules use this for their API calls.
// ---------------------------------------------------------------------------

/** Configuration for the Jupiter API client. */
export interface JupiterApiConfig {
  /** x-api-key header (required for Jupiter REST endpoints in production). */
  apiKey?: string;
  /** Base URL for Jupiter API. Default: "https://api.jup.ag" */
  baseUrl?: string;
  /** Maximum number of retries on 429/5xx. Default: 3 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  retryDelayMs?: number;
  /** Request timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Maximum delay cap in ms for exponential backoff. Default: 30000 */
  maxDelayMs?: number;
}

/** Error thrown by Jupiter API calls. */
export class JupiterApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`Jupiter API error (${statusCode}): ${body}`);
    this.name = "JupiterApiError";
  }
}

// ---------------------------------------------------------------------------
// Module-level config singleton
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<JupiterApiConfig> = {
  apiKey: "",
  baseUrl: "https://api.jup.ag",
  maxRetries: 3,
  retryDelayMs: 1000,
  timeoutMs: 30_000,
  maxDelayMs: 30_000,
};

let currentConfig: Required<JupiterApiConfig> = { ...DEFAULT_CONFIG };

/**
 * Configure the global Jupiter API client.
 * Call once at startup (e.g. in PhalnxClient constructor).
 */
export function configureJupiterApi(config: JupiterApiConfig): void {
  currentConfig = {
    apiKey: config.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: (config.baseUrl ?? DEFAULT_CONFIG.baseUrl).replace(/\/$/, ""),
    maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    retryDelayMs: config.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs,
    timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
  };
}

/** Get the current Jupiter API configuration (resolved with defaults). */
export function getJupiterApiConfig(): Required<JupiterApiConfig> {
  return { ...currentConfig };
}

/**
 * Reset the Jupiter API configuration to defaults.
 * Useful for testing.
 */
export function resetJupiterApiConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ---------------------------------------------------------------------------
// Core fetch with retry
// ---------------------------------------------------------------------------

export interface JupiterFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  /** Override the configured timeout for this request. */
  timeoutMs?: number;
}

/**
 * Fetch from Jupiter API with automatic retry, API key injection, and timeout.
 *
 * @param path - API path (e.g. "/v6/quote" or "/price/v3"). Appended to baseUrl.
 * @param options - Request options.
 * @returns Parsed JSON response.
 */
export async function jupiterFetch<T>(
  path: string,
  options?: JupiterFetchOptions,
): Promise<T> {
  const config = currentConfig;
  const url = `${config.baseUrl}${path}`;
  const method = options?.method ?? "GET";
  const timeout = options?.timeoutMs ?? config.timeoutMs;

  const headers: Record<string, string> = {
    ...options?.headers,
  };

  // Inject API key if configured
  if (config.apiKey) {
    headers["x-api-key"] = config.apiKey;
  }

  // Set content-type for POST/PUT with body
  if (options?.body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  const body: string | undefined =
    options?.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : (options?.body as string | undefined);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });

      // Success
      if (response.ok) {
        return (await response.json()) as T;
      }

      const responseBody = await response.text();

      // Retryable status codes: 429 (rate limit), 5xx (server error)
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < config.maxRetries
      ) {
        const retryAfter = response.headers.get("Retry-After");
        const parsedRetry = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const delay =
          !isNaN(parsedRetry) && parsedRetry > 0
            ? Math.min(parsedRetry * 1000, config.maxDelayMs)
            : Math.min(
                config.retryDelayMs * Math.pow(2, attempt) +
                  Math.random() * config.retryDelayMs,
                config.maxDelayMs,
              );

        await sleep(delay);
        lastError = new JupiterApiError(response.status, responseBody);
        continue;
      }

      // Non-retryable error
      throw new JupiterApiError(response.status, responseBody);
    } catch (error) {
      if (error instanceof JupiterApiError) {
        throw error;
      }

      // Timeout or network error — retry if attempts remain
      if (attempt < config.maxRetries) {
        const delay = Math.min(
          config.retryDelayMs * Math.pow(2, attempt) +
            Math.random() * config.retryDelayMs,
          config.maxDelayMs,
        );
        await sleep(delay);
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      throw error;
    }
  }

  // Should not reach here, but safety net
  throw lastError ?? new Error("Jupiter API request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
