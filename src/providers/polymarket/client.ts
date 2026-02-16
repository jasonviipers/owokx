import { createError, ErrorCode } from "../../lib/errors";
import { sleep } from "../../lib/utils";
import { createPolymarketL2Headers, normalizePolymarketRequestPath } from "./auth";
import { isPolymarketRetryableError, PolymarketClientError, toPolymarketClientError } from "./errors";
import type {
  PolymarketApiCredentials,
  PolymarketBalanceAllowanceResponse,
  PolymarketCreateOrderResponse,
  PolymarketDataPosition,
  PolymarketGetOrderResponse,
  PolymarketLastTradePriceResponse,
  PolymarketMidpointResponse,
  PolymarketOpenOrdersResponse,
  PolymarketOrderBook,
  PolymarketOrderType,
  PolymarketPriceHistoryResponse,
  PolymarketTradesResponse,
} from "./types";

type QueryPrimitive = string | number | boolean;
type QueryValue = QueryPrimitive | QueryPrimitive[] | null | undefined;

interface PolymarketRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  privateAuth?: boolean;
  timeoutMs?: number;
  baseUrl?: string;
}

interface PolymarketClientLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

export interface PolymarketClientConfig {
  baseUrl: string;
  dataApiBaseUrl?: string;
  chainId: number;
  signatureType: number;
  requestTimeoutMs: number;
  maxRetries: number;
  maxRequestsPerSecond: number;
  credentials?: PolymarketApiCredentials;
  logger?: PolymarketClientLogger;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_REQUESTS_PER_SECOND = 10;

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function normalizeMaxRetries(maxRetries: number): number {
  if (!Number.isFinite(maxRetries)) {
    return DEFAULT_MAX_RETRIES;
  }
  return Math.max(0, Math.floor(maxRetries));
}

function normalizeMaxRequestsPerSecond(maxRequestsPerSecond: number): number {
  if (!Number.isFinite(maxRequestsPerSecond)) {
    return DEFAULT_MAX_REQUESTS_PER_SECOND;
  }
  return Math.max(0, Math.floor(maxRequestsPerSecond));
}

function defaultLogger(scope = "polymarket_client"): PolymarketClientLogger {
  return {
    debug: (message, context) => console.debug(`[${scope}] ${message}`, context ?? {}),
    info: (message, context) => console.info(`[${scope}] ${message}`, context ?? {}),
    warn: (message, context) => console.warn(`[${scope}] ${message}`, context ?? {}),
    error: (message, context) => console.error(`[${scope}] ${message}`, context ?? {}),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "https://clob.polymarket.com";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function setQueryParams(searchParams: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      searchParams.append(key, String(item));
    }
    return;
  }

  searchParams.set(key, String(value));
}

class RollingRateLimiter {
  private readonly requestTimestamps: number[] = [];

  constructor(private readonly maxRequestsPerSecond: number) {}

  private prune(now: number): void {
    const windowStart = now - 1000;
    while (this.requestTimestamps.length > 0) {
      const first = this.requestTimestamps[0];
      if (first === undefined || first > windowStart) break;
      this.requestTimestamps.shift();
    }
  }

  async waitForSlot(): Promise<void> {
    if (!Number.isFinite(this.maxRequestsPerSecond) || this.maxRequestsPerSecond <= 0) return;

    while (true) {
      const now = Date.now();
      this.prune(now);
      if (this.requestTimestamps.length < this.maxRequestsPerSecond) {
        this.requestTimestamps.push(now);
        return;
      }
      const first = this.requestTimestamps[0];
      const waitMs = first === undefined ? 0 : Math.max(0, 1000 - (now - first));
      await sleep(waitMs);
    }
  }
}

export interface PolymarketPostOrderPayload {
  order: Record<string, unknown>;
  owner: string;
  orderType: PolymarketOrderType;
}

export class PolymarketClient {
  private readonly baseUrl: string;
  private readonly dataApiBaseUrl: string;
  private readonly config: PolymarketClientConfig;
  private readonly logger: PolymarketClientLogger;
  private readonly rateLimiter: RollingRateLimiter;

  constructor(config: PolymarketClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.dataApiBaseUrl = normalizeBaseUrl(config.dataApiBaseUrl ?? "https://data-api.polymarket.com");
    this.config = {
      ...config,
      requestTimeoutMs: normalizeTimeoutMs(config.requestTimeoutMs),
      maxRetries: normalizeMaxRetries(config.maxRetries),
      maxRequestsPerSecond: normalizeMaxRequestsPerSecond(config.maxRequestsPerSecond),
    };
    this.logger = config.logger ?? defaultLogger();
    this.rateLimiter = new RollingRateLimiter(this.config.maxRequestsPerSecond);
  }

  hasPrivateAuth(): boolean {
    return Boolean(
      this.config.credentials?.apiKey &&
        this.config.credentials?.apiSecret &&
        this.config.credentials?.apiPassphrase &&
        this.config.credentials?.address
    );
  }

  getAddress(): string | null {
    return this.config.credentials?.address ?? null;
  }

  getChainId(): number {
    return this.config.chainId;
  }

  getSignatureType(): number {
    return this.config.signatureType;
  }

  async getBook(tokenId: string): Promise<PolymarketOrderBook> {
    return this.request<PolymarketOrderBook>("GET", "/book", {
      query: { token_id: tokenId },
    });
  }

  async getMidpoint(tokenId: string): Promise<PolymarketMidpointResponse> {
    return this.request<PolymarketMidpointResponse>("GET", "/midpoint", {
      query: { token_id: tokenId },
    });
  }

  async getLastTradePrice(tokenId: string): Promise<PolymarketLastTradePriceResponse> {
    return this.request<PolymarketLastTradePriceResponse>("GET", "/last-trade-price", {
      query: { token_id: tokenId },
    });
  }

  async getPricesHistory(tokenId: string): Promise<PolymarketPriceHistoryResponse> {
    return this.request<PolymarketPriceHistoryResponse>("GET", "/prices-history", {
      query: { market: tokenId },
    });
  }

  async getBalanceAllowance(assetType = "COLLATERAL"): Promise<PolymarketBalanceAllowanceResponse> {
    return this.request<PolymarketBalanceAllowanceResponse>("GET", "/balance-allowance", {
      privateAuth: true,
      query: {
        asset_type: assetType,
        signature_type: this.config.signatureType,
      },
    });
  }

  async listOrders(params?: Record<string, QueryValue>): Promise<PolymarketOpenOrdersResponse> {
    return this.request<PolymarketOpenOrdersResponse>("GET", "/data/orders", {
      privateAuth: true,
      query: params,
    });
  }

  async getOrder(orderId: string): Promise<PolymarketGetOrderResponse> {
    return this.request<PolymarketGetOrderResponse>("GET", `/data/order/${encodeURIComponent(orderId)}`, {
      privateAuth: true,
    });
  }

  async postOrder(payload: PolymarketPostOrderPayload): Promise<PolymarketCreateOrderResponse> {
    return this.request<PolymarketCreateOrderResponse>("POST", "/order", {
      privateAuth: true,
      body: payload,
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", "/order", {
      privateAuth: true,
      body: { orderID: orderId },
    });
  }

  async cancelAllOrders(): Promise<void> {
    await this.request("DELETE", "/cancel-all", {
      privateAuth: true,
      body: {},
    });
  }

  async listTrades(params?: Record<string, QueryValue>): Promise<PolymarketTradesResponse> {
    return this.request<PolymarketTradesResponse>("GET", "/data/trades", {
      privateAuth: true,
      query: params,
    });
  }

  async getDataPositions(
    userAddress: string,
    params?: {
      market?: string;
      limit?: number;
      offset?: number;
      sizeThreshold?: number;
    }
  ): Promise<PolymarketDataPosition[]> {
    const user = userAddress.trim();
    if (!user) return [];
    return this.request<PolymarketDataPosition[]>("GET", "/positions", {
      baseUrl: this.dataApiBaseUrl,
      query: {
        user,
        market: params?.market,
        limit: params?.limit,
        offset: params?.offset,
        sizeThreshold: params?.sizeThreshold,
      },
    });
  }

  private buildPathWithQuery(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = normalizePolymarketRequestPath(path);
    if (!query || Object.keys(query).length === 0) return normalizedPath;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      setQueryParams(searchParams, key, value);
    }
    const queryString = searchParams.toString();
    if (!queryString) return normalizedPath;
    return `${normalizedPath}?${queryString}`;
  }

  private getPrivateCredentials(): PolymarketApiCredentials {
    const creds = this.config.credentials;
    if (
      !creds ||
      !creds.apiKey ||
      !creds.apiSecret ||
      !creds.apiPassphrase ||
      !creds.address ||
      !creds.address.trim()
    ) {
      throw createError(
        ErrorCode.UNAUTHORIZED,
        "Polymarket private auth requires POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE, and POLYMARKET_ADDRESS"
      );
    }
    return creds;
  }

  private shouldRetry(error: unknown): boolean {
    return isPolymarketRetryableError(error);
  }

  private computeRetryDelayMs(attempt: number, error: unknown): number {
    if (error instanceof PolymarketClientError && error.code === ErrorCode.RATE_LIMITED) {
      return Math.min(5000, 250 * 2 ** attempt);
    }
    const jitter = Math.floor(Math.random() * 50);
    return Math.min(5000, 200 * 2 ** attempt) + jitter;
  }

  private async request<T>(method: string, path: string, options: PolymarketRequestOptions = {}): Promise<T> {
    const requestPath = this.buildPathWithQuery(path, options.query);
    const baseUrl = normalizeBaseUrl(options.baseUrl ?? this.baseUrl);
    const url = `${baseUrl}${requestPath}`;
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.rateLimiter.waitForSlot();
        return await this.executeFetch<T>(method, url, requestPath, options, timeoutMs);
      } catch (error) {
        lastError = error;
        const shouldRetry = attempt < this.config.maxRetries && this.shouldRetry(error);
        if (!shouldRetry) {
          throw error;
        }

        const delayMs = this.computeRetryDelayMs(attempt, error);
        this.logger.warn("Retrying Polymarket request", {
          method,
          requestPath,
          attempt: attempt + 1,
          delayMs,
          error: String(error),
        });
        await sleep(delayMs);
      }
    }

    throw lastError ?? createError(ErrorCode.PROVIDER_ERROR, "Polymarket request failed unexpectedly");
  }

  private async executeFetch<T>(
    method: string,
    url: string,
    requestPath: string,
    options: PolymarketRequestOptions,
    timeoutMs: number
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.privateAuth) {
      const creds = this.getPrivateCredentials();
      Object.assign(
        headers,
        await createPolymarketL2Headers({
          method,
          requestPath,
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
          address: creds.address,
        })
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = text.length > 0 ? this.tryParseJson(text) : undefined;

      if (!response.ok) {
        throw toPolymarketClientError(response.status, payload ?? text, `Polymarket HTTP ${response.status}`);
      }

      if (response.status === 204 || text.length === 0) {
        return undefined as T;
      }

      return (payload ?? text) as T;
    } catch (error) {
      if (error instanceof PolymarketClientError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new PolymarketClientError(
          "Polymarket request timed out",
          ErrorCode.PROVIDER_ERROR,
          undefined,
          undefined,
          true
        );
      }

      throw new PolymarketClientError(String(error), ErrorCode.PROVIDER_ERROR, undefined, error, true);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

export function createPolymarketClient(config: PolymarketClientConfig): PolymarketClient {
  return new PolymarketClient(config);
}
