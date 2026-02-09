import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";
import { createOkxClient } from "./client";

describe("OKX Client", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends required auth headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ code: "0", msg: "", data: [] }),
    });

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/account/balance");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("https://eea.okx.com/api/v5/account/balance");
    expect(call[1].headers).toMatchObject({
      "OK-ACCESS-KEY": "test-key",
      "OK-ACCESS-PASSPHRASE": "test-pass",
      "Content-Type": "application/json",
    });

    const headers = call[1].headers as Record<string, string>;
    expect(headers["OK-ACCESS-SIGN"]).toBeTruthy();
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBeTruthy();
  });

  it("sends simulated trading header when enabled", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ code: "0", msg: "", data: [] }),
    });

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      simulatedTrading: true,
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/account/balance");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[1].headers).toMatchObject({
      "x-simulated-trading": "1",
    });
  });

  it("maps OKX business errors even when HTTP 200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ code: "51008", msg: "Insufficient balance", data: [] }),
    });

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await expect(client.request("POST", "/api/v5/trade/order", undefined, { foo: "bar" })).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_BUYING_POWER,
      message: expect.stringContaining("Insufficient balance"),
    });
  });

  it("maps HTTP 429 to RATE_LIMITED", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => JSON.stringify({ code: "50011", msg: "Too many requests", data: [] }),
    });

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await expect(client.request("GET", "/api/v5/account/balance")).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
  });

  it("does not send auth headers when auth is disabled", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ code: "0", msg: "", data: [] }),
    });

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/market/ticker", { instId: "BTC-USDT" }, undefined, { auth: false });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["OK-ACCESS-KEY"]).toBeUndefined();
    expect(headers["OK-ACCESS-SIGN"]).toBeUndefined();
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBeUndefined();
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBeUndefined();
  });
});
