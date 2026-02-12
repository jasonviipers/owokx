import { RestClient } from "okx-api";
import { createError, ErrorCode } from "../../lib/errors";
import { sanitizeForLog, sleep } from "../../lib/utils";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface OkxLogger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

export interface OkxClientConfig {
  apiKey: string;
  secret: string;
  passphrase: string;
  baseUrl?: string;
  simulatedTrading?: boolean;
  maxRequestsPerSecond?: number;
  maxRetries?: number;
  logger?: OkxLogger;
}

export interface OkxApiResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

interface ParsedOkxError {
  code: string;
  message: string;
  httpStatus: number;
}

function toQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      sp.set(k, String(v));
    } else {
      sp.set(k, JSON.stringify(v));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

function mapOkxError(code: string, httpStatus: number): ErrorCode {
  if (httpStatus === 401) return ErrorCode.UNAUTHORIZED;
  if (httpStatus === 403) return ErrorCode.FORBIDDEN;
  if (httpStatus === 404) return ErrorCode.NOT_FOUND;
  if (httpStatus === 429) return ErrorCode.RATE_LIMITED;

  if (code === "51000") return ErrorCode.INVALID_INPUT;
  if (code === "51008") return ErrorCode.INSUFFICIENT_BUYING_POWER;
  if (code === "51009") return ErrorCode.NOT_FOUND;
  if (code === "50011" || code === "50013") return ErrorCode.RATE_LIMITED;

  return ErrorCode.PROVIDER_ERROR;
}

function parseOkxError(error: unknown): ParsedOkxError {
  const source = error as
    | {
        code?: unknown;
        msg?: unknown;
        message?: unknown;
        status?: unknown;
        response?: {
          status?: unknown;
          data?: {
            code?: unknown;
            msg?: unknown;
            message?: unknown;
          };
        };
      }
    | undefined;

  const responseStatus = source?.response?.status;
  const status =
    typeof source?.status === "number" ? source.status : typeof responseStatus === "number" ? responseStatus : 0;

  const responseData = source?.response?.data;
  const codeCandidate = responseData?.code ?? source?.code;
  const msgCandidate = responseData?.msg ?? responseData?.message ?? source?.msg ?? source?.message;

  const code = typeof codeCandidate === "string" && codeCandidate.length > 0 ? codeCandidate : "HTTP_ERROR";
  const message = typeof msgCandidate === "string" && msgCandidate.length > 0 ? msgCandidate : String(error);

  return {
    code,
    message,
    httpStatus: status,
  };
}

function normalizeData<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload === undefined || payload === null) {
    return [];
  }
  return [payload as T];
}

export class OkxClient {
  private maxRequestsPerSecond: number;
  private maxRetries: number;
  private logger?: OkxLogger;
  private lastRequestAt = 0;
  private readonly restClient: RestClient;

  constructor(config: OkxClientConfig) {
    this.maxRequestsPerSecond = Math.max(1, config.maxRequestsPerSecond ?? 5);
    this.maxRetries = Math.max(0, config.maxRetries ?? 2);
    this.logger = config.logger;

    this.restClient = new RestClient({
      apiKey: config.apiKey,
      apiSecret: config.secret,
      apiPass: config.passphrase,
      baseUrl: (config.baseUrl ?? "https://eea.okx.com").replace(/\/+$/, ""),
      demoTrading: config.simulatedTrading === true,
    });
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    body?: unknown,
    options?: { auth?: boolean }
  ): Promise<OkxApiResponse<T>> {
    const wantsAuth = options?.auth !== false;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const minIntervalMs = Math.ceil(1000 / this.maxRequestsPerSecond);
      const now = Date.now();
      const waitMs = Math.max(0, this.lastRequestAt + minIntervalMs - now);
      if (waitMs > 0) await sleep(waitMs);

      const startedAt = Date.now();

      try {
        const rawData = await this.executeRequest(method, path, params, body, wantsAuth);
        this.lastRequestAt = Date.now();

        this.logger?.log("info", "okx_request", {
          method,
          path,
          okx_code: "0",
          latency_ms: this.lastRequestAt - startedAt,
          attempt,
        });

        return {
          code: "0",
          msg: "",
          data: normalizeData<T>(rawData),
        };
      } catch (error) {
        this.lastRequestAt = Date.now();

        const parsedError = parseOkxError(error);
        const shouldRetry =
          parsedError.httpStatus === 429 ||
          (parsedError.httpStatus >= 500 && parsedError.httpStatus <= 599) ||
          parsedError.code === "50011" ||
          parsedError.code === "50013";

        this.logger?.log(shouldRetry ? "warn" : "error", "okx_request", {
          method,
          path,
          okx_code: parsedError.code,
          status: parsedError.httpStatus || undefined,
          latency_ms: this.lastRequestAt - startedAt,
          attempt,
        });

        if (shouldRetry && attempt <= this.maxRetries) {
          const backoffMs = Math.min(5000, 200 * 2 ** (attempt - 1));
          this.logger?.log("warn", "okx_retry", {
            method,
            path,
            okx_code: parsedError.code,
            status: parsedError.httpStatus || undefined,
            backoff_ms: backoffMs,
            attempt,
          });
          await sleep(backoffMs);
          continue;
        }

        const mapped = mapOkxError(parsedError.code, parsedError.httpStatus);
        throw createError(
          mapped,
          `OKX API error (${parsedError.code}${parsedError.httpStatus ? `, HTTP ${parsedError.httpStatus}` : ""}): ${parsedError.message}`,
          {
            method,
            path,
            params: sanitizeForLog(params),
            body: sanitizeForLog(body),
          }
        );
      }
    }

    throw createError(ErrorCode.PROVIDER_ERROR, "OKX request failed after retries", { method, path });
  }

  private async executeRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, unknown> | undefined,
    body: unknown,
    wantsAuth: boolean
  ): Promise<unknown> {
    if (method === "GET") {
      return wantsAuth ? this.restClient.getPrivate(path, params) : this.restClient.get(path, params);
    }

    if (method === "POST") {
      const payload = body ?? {};
      if (params && Object.keys(params).length > 0) {
        const endpoint = `${path}${toQueryString(params)}`;
        return wantsAuth ? this.restClient.postPrivate(endpoint, payload) : this.restClient.post(endpoint, payload);
      }
      return wantsAuth ? this.restClient.postPrivate(path, payload) : this.restClient.post(path, payload);
    }

    if (method === "DELETE") {
      if (!wantsAuth) {
        throw createError(ErrorCode.NOT_SUPPORTED, "Public DELETE requests are not supported by OKX adapter");
      }
      return this.restClient.deletePrivate(path, body ?? params ?? {});
    }

    throw createError(ErrorCode.INVALID_INPUT, `Unsupported method: ${method}`);
  }
}

export function createOkxClient(config: OkxClientConfig): OkxClient {
  return new OkxClient(config);
}
