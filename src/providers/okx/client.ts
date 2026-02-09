import { createError, ErrorCode } from "../../lib/errors";
import { nowISO, sanitizeForLog, sleep } from "../../lib/utils";

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

function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  const maybeBuffer = (
    globalThis as unknown as { Buffer?: { from?: (b: Uint8Array) => { toString: (enc: string) => string } } }
  ).Buffer;
  const buf = maybeBuffer?.from?.(bytes);
  if (buf) return buf.toString("base64");
  throw createError(ErrorCode.INTERNAL_ERROR, "No base64 encoder available in this runtime");
}

async function hmacSha256Base64(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, msgData);
  return base64Encode(new Uint8Array(signature));
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

export class OkxClient {
  private baseUrl: string;
  private simulatedTrading: boolean;
  private maxRequestsPerSecond: number;
  private maxRetries: number;
  private logger?: OkxLogger;

  private lastRequestAt = 0;

  constructor(private config: OkxClientConfig) {
    this.baseUrl = (config.baseUrl ?? "https://eea.okx.com").replace(/\/+$/, "");
    this.simulatedTrading = config.simulatedTrading === true;
    this.maxRequestsPerSecond = Math.max(1, config.maxRequestsPerSecond ?? 5);
    this.maxRetries = Math.max(0, config.maxRetries ?? 2);
    this.logger = config.logger;
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    body?: unknown,
    options?: { auth?: boolean }
  ): Promise<OkxApiResponse<T>> {
    const queryString = toQueryString(params);
    const requestPath = `${path}${queryString}`;
    const url = `${this.baseUrl}${requestPath}`;

    const bodyForRequest = body !== undefined ? JSON.stringify(body) : "";
    const bodyForSignature = method === "GET" || method === "DELETE" ? "" : bodyForRequest;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      const minIntervalMs = Math.ceil(1000 / this.maxRequestsPerSecond);
      const now = Date.now();
      const waitMs = Math.max(0, this.lastRequestAt + minIntervalMs - now);
      if (waitMs > 0) await sleep(waitMs);

      const headers: Record<string, string> = { "Content-Type": "application/json" };

      const wantsAuth = options?.auth !== false;
      if (wantsAuth) {
        const timestamp = nowISO();
        const signPayload = `${timestamp}${method}${requestPath}${bodyForSignature}`;
        const signature = await hmacSha256Base64(signPayload, this.config.secret);

        headers["OK-ACCESS-KEY"] = this.config.apiKey;
        headers["OK-ACCESS-SIGN"] = signature;
        headers["OK-ACCESS-TIMESTAMP"] = timestamp;
        headers["OK-ACCESS-PASSPHRASE"] = this.config.passphrase;
      }

      if (this.simulatedTrading) {
        headers["x-simulated-trading"] = "1";
      }

      const start = Date.now();
      const res = await fetch(url, {
        method,
        headers,
        body: bodyForRequest || undefined,
      });
      this.lastRequestAt = Date.now();

      const latencyMs = this.lastRequestAt - start;

      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Math.max(0, Number(retryAfterHeader) * 1000) : 0;

      const text = await res.text();
      const isJson = text.trim().startsWith("{");

      let parsed: OkxApiResponse<T> | null = null;
      if (isJson) {
        try {
          parsed = JSON.parse(text) as OkxApiResponse<T>;
        } catch {
          parsed = null;
        }
      }

      const okxCode = parsed?.code ?? (res.ok ? "0" : "HTTP_ERROR");
      const okxMsg = parsed?.msg ?? text;

      const level: "info" | "warn" | "error" =
        !res.ok || okxCode !== "0"
          ? res.status === 429 || (res.status >= 500 && res.status <= 599) || okxCode === "51001"
            ? "warn"
            : "error"
          : "info";

      this.logger?.log(level, "okx_request", {
        method,
        path,
        status: res.status,
        okx_code: okxCode,
        latency_ms: latencyMs,
        attempt,
      });

      const shouldRetry = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if ((shouldRetry || okxCode === "50011" || okxCode === "50013") && attempt <= this.maxRetries) {
        const backoffMs = retryAfterMs || Math.min(5000, 200 * 2 ** (attempt - 1));
        this.logger?.log("warn", "okx_retry", {
          method,
          path,
          status: res.status,
          okx_code: okxCode,
          backoff_ms: backoffMs,
        });
        await sleep(backoffMs);
        continue;
      }

      if (!res.ok || (parsed && parsed.code !== "0")) {
        const code = parsed?.code ?? "HTTP_ERROR";
        const message = parsed?.msg ?? okxMsg;
        const mapped = mapOkxError(code, res.status);
        throw createError(mapped, `OKX API error (${code}, HTTP ${res.status}): ${message}`, {
          method,
          path,
          params: sanitizeForLog(params),
          body: sanitizeForLog(body),
        });
      }

      if (!parsed) {
        throw createError(ErrorCode.PROVIDER_ERROR, "OKX API returned non-JSON response", {
          method,
          path,
          status: res.status,
          body: text.slice(0, 500),
        });
      }

      return parsed;
    }

    throw createError(ErrorCode.PROVIDER_ERROR, "OKX request failed after retries", { method, path });
  }
}

export function createOkxClient(config: OkxClientConfig): OkxClient {
  return new OkxClient(config);
}
