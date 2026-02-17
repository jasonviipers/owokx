import { createError, ErrorCode } from "../../lib/errors";

export interface CreatePolymarketL2HeadersParams {
  method: string;
  requestPath: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  address?: string;
  timestamp?: number;
}

function decodeBase64(input: string): Uint8Array {
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(input, "base64"));
    }

    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
    const padded = `${normalized}${"=".repeat(paddingLength)}`;
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw createError(ErrorCode.INVALID_INPUT, "POLYMARKET_API_SECRET must be a valid base64 string");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function normalizePolymarketRequestPath(pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    return `${parsed.pathname}${parsed.search}`;
  }
  if (trimmed.startsWith("/")) return trimmed;
  return `/${trimmed}`;
}

export function buildPolymarketL2Message(timestampSeconds: number, method: string, requestPath: string): string {
  return `${timestampSeconds}${method.toUpperCase()}${normalizePolymarketRequestPath(requestPath)}`;
}

export async function signPolymarketL2Message(message: string, base64Secret: string): Promise<string> {
  const secretBytes = decodeBase64(base64Secret);
  const messageBytes = new TextEncoder().encode(message);

  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, messageBytes);
  return encodeBase64(new Uint8Array(signature));
}

export async function createPolymarketL2Headers(
  params: CreatePolymarketL2HeadersParams
): Promise<Record<string, string>> {
  const timestampSeconds = Math.floor(params.timestamp ?? Date.now() / 1000);
  const message = buildPolymarketL2Message(timestampSeconds, params.method, params.requestPath);
  const signature = await signPolymarketL2Message(message, params.apiSecret);

  const headers: Record<string, string> = {
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestampSeconds),
    POLY_API_KEY: params.apiKey,
    POLY_PASSPHRASE: params.apiPassphrase,
  };

  if (params.address && params.address.trim().length > 0) {
    headers.POLY_ADDRESS = params.address.trim();
  }

  return headers;
}
