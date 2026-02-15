import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OkxClient } from "../providers/okx/client";
import { createOkxMarketDataProvider } from "../providers/okx/market-data";

describe("OKX Market Data Provider", () => {
  let mockClient: OkxClient;
  let mockGetCandles: ReturnType<typeof vi.fn>;
  let mockLoggerWarn: ReturnType<typeof vi.fn>;
  let mockLoggerError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetCandles = vi.fn();
    mockLoggerWarn = vi.fn();
    mockLoggerError = vi.fn();

    mockClient = {
      rest: {
        getCandles: mockGetCandles,
      },
      ws: {} as OkxClient["ws"],
      config: {
        apiKey: "test",
        apiSecret: "test",
        apiPass: "test",
        defaultQuoteCcy: "USDT",
      },
      rateLimiter: {} as OkxClient["rateLimiter"],
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: mockLoggerWarn,
        error: mockLoggerError,
      },
    } as unknown as OkxClient;
  });

  it("caches unsupported instruments after first 51001 response", async () => {
    const provider = createOkxMarketDataProvider(mockClient);
    mockGetCandles.mockRejectedValueOnce({
      code: "51001",
      msg: "Instrument ID, Instrument ID code, or Spread ID doesn't exist.",
    });

    await expect(provider.getBars("WEEDCOIN.X", "1Day")).rejects.toMatchObject({
      okxCode: "51001",
    });

    await expect(provider.getBars("WEEDCOIN.X", "1Day")).rejects.toMatchObject({
      okxCode: "51001",
    });

    expect(mockGetCandles).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "OKX instrument unavailable; caching as unsupported",
      expect.objectContaining({
        symbol: "WEEDCOIN.X",
        instId: "WEEDCOIN-USDT",
        okxCode: "51001",
      })
    );
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

