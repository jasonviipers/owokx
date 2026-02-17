import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolymarketClient } from "./client";

const baseConfig = {
  baseUrl: "https://clob.polymarket.com",
  chainId: 137,
  signatureType: 2,
  requestTimeoutMs: 10_000,
  maxRetries: 2,
  maxRequestsPerSecond: 10,
} as const;

const originalFetch = globalThis.fetch;

function createJsonResponse(payload: unknown): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const textPayload = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => textPayload,
    json: async () => payload,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("PolymarketClient config sanitization", () => {
  it("does not hang when maxRequestsPerSecond/maxRetries are non-finite", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ token_id: "123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createPolymarketClient({
      ...baseConfig,
      requestTimeoutMs: Number.NaN,
      maxRetries: Number.NaN,
      maxRequestsPerSecond: Number.NaN,
    });

    const result = await Promise.race([
      client.getBook("123"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("request timed out in test")), 250);
      }),
    ]);

    expect(result).toEqual({ token_id: "123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
