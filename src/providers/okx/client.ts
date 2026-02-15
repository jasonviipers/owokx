import type { APIMarket, RestClientOptions } from "okx-api";
import { RestClient, WebsocketClient } from "okx-api";
import { createError, ErrorCode } from "../../lib/errors";
import { createOkxLogger, type OkxLogLevel, type OkxLogger } from "./logger";
import { OkxRateLimitedClient } from "./rate-limiter";

const OKX_ERROR_CODE_MAP: Record<
  string,
  {
    errorCode: ErrorCode;
    message: string;
    retryable?: boolean;
  }
> = {
  "50011": {
    errorCode: ErrorCode.RATE_LIMITED,
    message: "Rate limit exceeded",
    retryable: true,
  },
  "50040": {
    errorCode: ErrorCode.RATE_LIMITED,
    message: "Too frequent operations",
    retryable: true,
  },
  "50113": {
    errorCode: ErrorCode.UNAUTHORIZED,
    message: "Invalid API key, secret, or passphrase",
  },
  "50114": {
    errorCode: ErrorCode.UNAUTHORIZED,
    message: "Invalid API signature",
  },
  "50115": {
    errorCode: ErrorCode.UNAUTHORIZED,
    message: "Invalid request timestamp",
  },
  "50119": {
    errorCode: ErrorCode.UNAUTHORIZED,
    message: "API key does not exist for this OKX region/domain",
  },
  "51000": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Parameter error",
  },
  "51001": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Instrument not found or unavailable",
  },
  "51004": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Order failed due to risk checks",
  },
  "51008": {
    errorCode: ErrorCode.INSUFFICIENT_BUYING_POWER,
    message: "Insufficient balance",
  },
  "51009": {
    errorCode: ErrorCode.NOT_FOUND,
    message: "Order does not exist",
  },
  "51010": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Current account mode does not support this request",
  },
  "51015": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Order quantity too small",
  },
  "51131": {
    errorCode: ErrorCode.INVALID_INPUT,
    message: "Order price out of range",
  },
};

export interface OkxClientConfig {
  apiKey: string;
  apiSecret: string;
  apiPass: string;
  baseUrl?: string;
  market?: "GLOBAL" | "US" | "EEA";
  simulatedTrading?: boolean;
  defaultQuoteCcy?: string;
  maxRequestsPerSecond?: number;
  maxRetries?: number;
  parseExceptions?: boolean;
  strictParamValidation?: boolean;
  logLevel?: OkxLogLevel;
}

export interface OkxClient {
  rest: RestClient;
  ws: WebsocketClient;
  config: OkxClientConfig;
  rateLimiter: OkxRateLimitedClient;
  logger: OkxLogger;
}

interface ExtractedOkxError {
  okxCode?: string;
  message: string;
  details?: unknown;
  httpStatus?: number;
}

function normalizeMarket(market?: OkxClientConfig["market"]): APIMarket {
  if (market === "US" || market === "EEA") {
    return market;
  }
  return "prod";
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Create OKX request prehash string following API v5 signing rules:
 * `${timestamp}${upperMethod}${requestPathWithQuery}${rawBodyJson}`
 */
export function createOkxSignaturePayload(
  timestamp: string,
  method: string,
  requestPathWithQuery: string,
  body?: string
): string {
  return `${timestamp}${method.toUpperCase()}${requestPathWithQuery}${body ?? ""}`;
}

/**
 * Generate an OKX signature using HMAC SHA256 and base64 output.
 */
export async function generateOkxSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(payload);

  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, messageData);

  return toBase64(new Uint8Array(signature));
}

function createOkxSdkSigner(): RestClientOptions["customSignMessageFn"] {
  return async (message: string, secret: string) => generateOkxSignature(message, secret);
}

function extractOkxError(error: unknown): ExtractedOkxError {
  if (!error || typeof error !== "object") {
    return {
      message: String(error ?? "Unknown OKX error"),
      details: error,
    };
  }

  const record = error as Record<string, unknown>;

  const directCode = typeof record.code === "string" ? record.code : undefined;
  const directMessage =
    typeof record.msg === "string" ? record.msg : typeof record.message === "string" ? record.message : undefined;

  const response =
    typeof record.response === "object" && record.response ? (record.response as Record<string, unknown>) : undefined;
  const responseStatus = typeof response?.status === "number" ? response.status : undefined;

  const responseData =
    typeof response?.data === "object" && response.data ? (response.data as Record<string, unknown>) : undefined;
  const responseCode = typeof responseData?.code === "string" ? responseData.code : undefined;
  const responseMessage = typeof responseData?.msg === "string" ? responseData.msg : undefined;

  const message = responseMessage ?? directMessage ?? "Unknown OKX error";
  const okxCode = responseCode ?? directCode ?? message.match(/\b\d{5}\b/)?.[0];

  return {
    okxCode,
    message,
    details: error,
    httpStatus: responseStatus,
  };
}

function mapErrorCode(okxCode?: string, httpStatus?: number): ErrorCode {
  if (okxCode && OKX_ERROR_CODE_MAP[okxCode]) {
    return OKX_ERROR_CODE_MAP[okxCode].errorCode;
  }

  if (httpStatus === 401) return ErrorCode.UNAUTHORIZED;
  if (httpStatus === 403) return ErrorCode.FORBIDDEN;
  if (httpStatus === 404) return ErrorCode.NOT_FOUND;
  if (httpStatus === 409) return ErrorCode.CONFLICT;
  if (httpStatus === 429) return ErrorCode.RATE_LIMITED;
  if (httpStatus && httpStatus >= 500) return ErrorCode.PROVIDER_ERROR;

  return ErrorCode.PROVIDER_ERROR;
}

function mapErrorMessage(okxCode: string | undefined, fallbackMessage: string): string {
  if (!okxCode) {
    return fallbackMessage;
  }

  const mapped = OKX_ERROR_CODE_MAP[okxCode];
  if (!mapped) {
    return fallbackMessage;
  }

  return `${mapped.message}: ${fallbackMessage}`;
}

function wrapRestClientWithRateLimiting(restClient: RestClient, rateLimiter: OkxRateLimitedClient): RestClient {
  return new Proxy(restClient, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);

      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => rateLimiter.execute(() => Promise.resolve(value.apply(target, args)));
    },
  });
}

function assertConfig(config: OkxClientConfig): void {
  if (!config.apiKey || !config.apiSecret || !config.apiPass) {
    throw createError(ErrorCode.UNAUTHORIZED, "OKX credentials are required (OKX_API_KEY, OKX_SECRET, OKX_PASSPHRASE)");
  }
}

export function createOkxClient(config: OkxClientConfig): OkxClient {
  assertConfig(config);

  const market = normalizeMarket(config.market);
  const customSignMessageFn = createOkxSdkSigner();
  const logger = createOkxLogger("client", config.logLevel);

  const restClient = new RestClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    apiPass: config.apiPass,
    market,
    baseUrl: config.baseUrl,
    demoTrading: config.simulatedTrading,
    parse_exceptions: config.parseExceptions ?? true,
    strict_param_validation: config.strictParamValidation ?? false,
    customSignMessageFn,
  });

  const wsClient = new WebsocketClient({
    market,
    demoTrading: config.simulatedTrading,
    customSignMessageFn,
    accounts: [
      {
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        apiPass: config.apiPass,
      },
    ],
  });

  const rateLimiter = new OkxRateLimitedClient(config.maxRequestsPerSecond ?? 10, config.maxRetries ?? 3);

  logger.info("Initialized OKX client", {
    market,
    simulatedTrading: Boolean(config.simulatedTrading),
    maxRequestsPerSecond: config.maxRequestsPerSecond ?? 10,
    maxRetries: config.maxRetries ?? 3,
  });

  return {
    rest: wrapRestClientWithRateLimiting(restClient, rateLimiter),
    ws: wsClient,
    config,
    rateLimiter,
    logger,
  };
}

export class OkxClientError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly okxCode?: string,
    public readonly httpStatus?: number,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "OkxClientError";
  }

  toOwokxError() {
    return createError(this.code, this.message, {
      okxCode: this.okxCode,
      httpStatus: this.httpStatus,
      originalError: this.originalError,
    });
  }
}

export function handleOkxError(error: unknown): never {
  if (error instanceof OkxClientError) {
    throw error;
  }

  const extracted = extractOkxError(error);
  const code = mapErrorCode(extracted.okxCode, extracted.httpStatus);
  const message = mapErrorMessage(extracted.okxCode, extracted.message);

  throw new OkxClientError(message, code, extracted.okxCode, extracted.httpStatus, extracted.details);
}
