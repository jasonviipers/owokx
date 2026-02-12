import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";

const {
  restClientCtorMock,
  getPrivateMock,
  getPublicMock,
  postPrivateMock,
  postPublicMock,
  deletePrivateMock,
} = vi.hoisted(() => ({
  restClientCtorMock: vi.fn(),
  getPrivateMock: vi.fn(),
  getPublicMock: vi.fn(),
  postPrivateMock: vi.fn(),
  postPublicMock: vi.fn(),
  deletePrivateMock: vi.fn(),
}));

vi.mock("okx-api", () => ({
  RestClient: vi.fn().mockImplementation((options: unknown) => {
    restClientCtorMock(options);
    return {
      getPrivate: getPrivateMock,
      get: getPublicMock,
      postPrivate: postPrivateMock,
      post: postPublicMock,
      deletePrivate: deletePrivateMock,
    };
  }),
}));

import { createOkxClient } from "./client";

describe("OKX Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes official okx-api RestClient with auth config", async () => {
    getPrivateMock.mockResolvedValueOnce([]);

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/account/balance");

    expect(restClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        apiSecret: "test-secret",
        apiPass: "test-pass",
        baseUrl: "https://eea.okx.com",
        demoTrading: false,
      })
    );
    expect(getPrivateMock).toHaveBeenCalledWith("/api/v5/account/balance", undefined);
  });

  it("enables demo trading mode when simulatedTrading is true", async () => {
    getPrivateMock.mockResolvedValueOnce([]);

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      simulatedTrading: true,
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/account/balance");

    expect(restClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        demoTrading: true,
      })
    );
  });

  it("maps OKX business errors from SDK responses", async () => {
    postPrivateMock.mockRejectedValueOnce({ code: "51008", msg: "Insufficient balance", data: [] });

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

  it("maps HTTP 429-style responses to RATE_LIMITED", async () => {
    getPrivateMock.mockRejectedValueOnce({
      response: {
        status: 429,
        data: { code: "50011", msg: "Too many requests", data: [] },
      },
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

  it("uses public SDK methods when auth is disabled", async () => {
    getPublicMock.mockResolvedValueOnce([{ instId: "BTC-USDT" }]);

    const client = createOkxClient({
      apiKey: "test-key",
      secret: "test-secret",
      passphrase: "test-pass",
      maxRetries: 0,
    });

    await client.request("GET", "/api/v5/market/ticker", { instId: "BTC-USDT" }, undefined, { auth: false });

    expect(getPublicMock).toHaveBeenCalledWith("/api/v5/market/ticker", { instId: "BTC-USDT" });
    expect(getPrivateMock).not.toHaveBeenCalled();
  });
});
