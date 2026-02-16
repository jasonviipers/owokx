import type { ErrorCode } from "../../lib/errors";
import { ErrorCode as OwokxErrorCode } from "../../lib/errors";

export class PolymarketClientError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly status?: number,
    public readonly response?: unknown,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "PolymarketClientError";
  }
}

function getObjectProperty(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

export function extractPolymarketErrorMessage(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof payload !== "object") {
    return String(payload);
  }

  const candidates = ["errorMsg", "error", "message", "msg", "detail"];
  for (const key of candidates) {
    const value = getObjectProperty(payload, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function inferCodeByMessage(message: string): ErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("insufficient") || normalized.includes("not enough balance")) {
    return OwokxErrorCode.INSUFFICIENT_BUYING_POWER;
  }
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return OwokxErrorCode.RATE_LIMITED;
  }
  if (normalized.includes("not found")) {
    return OwokxErrorCode.NOT_FOUND;
  }
  if (normalized.includes("invalid") || normalized.includes("bad request")) {
    return OwokxErrorCode.INVALID_INPUT;
  }
  if (normalized.includes("unauthorized") || normalized.includes("forbidden")) {
    return OwokxErrorCode.UNAUTHORIZED;
  }
  return OwokxErrorCode.PROVIDER_ERROR;
}

export function mapPolymarketError(
  status: number | undefined,
  payload: unknown,
  fallbackMessage: string
): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
} {
  const message = extractPolymarketErrorMessage(payload) ?? fallbackMessage;
  const messageCode = inferCodeByMessage(message);

  if (status === 400) {
    return {
      code: messageCode === OwokxErrorCode.PROVIDER_ERROR ? OwokxErrorCode.INVALID_INPUT : messageCode,
      message,
      retryable: false,
    };
  }
  if (status === 401) return { code: OwokxErrorCode.UNAUTHORIZED, message, retryable: false };
  if (status === 403) return { code: OwokxErrorCode.FORBIDDEN, message, retryable: false };
  if (status === 404) return { code: OwokxErrorCode.NOT_FOUND, message, retryable: false };
  if (status === 409) return { code: OwokxErrorCode.CONFLICT, message, retryable: false };
  if (status === 429) return { code: OwokxErrorCode.RATE_LIMITED, message, retryable: true };
  if (typeof status === "number" && status >= 500) {
    return { code: OwokxErrorCode.PROVIDER_ERROR, message, retryable: true };
  }

  if (messageCode === OwokxErrorCode.RATE_LIMITED) {
    return { code: messageCode, message, retryable: true };
  }

  return { code: messageCode, message, retryable: false };
}

export function toPolymarketClientError(
  status: number | undefined,
  payload: unknown,
  fallbackMessage: string
): PolymarketClientError {
  const mapped = mapPolymarketError(status, payload, fallbackMessage);
  return new PolymarketClientError(mapped.message, mapped.code, status, payload, mapped.retryable);
}

export function isPolymarketRetryableError(error: unknown): boolean {
  if (error instanceof PolymarketClientError) {
    return error.retryable;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = String((error as Record<string, unknown>).message ?? error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("temporarily unavailable")
  );
}
