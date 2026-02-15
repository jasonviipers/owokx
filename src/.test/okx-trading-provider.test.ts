import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OkxClient } from "../providers/okx/client";
import { createOkxTradingProvider } from "../providers/okx/trading";

describe("OKX Trading Provider", () => {
  let mockClient: OkxClient;
  let mockGetInstruments: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetInstruments = vi.fn();

    mockClient = {
      rest: {
        getInstruments: mockGetInstruments,
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
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as OkxClient;
  });

  it("does not return false-positive assets when instId does not match", async () => {
    const provider = createOkxTradingProvider(mockClient);
    mockGetInstruments
      .mockResolvedValueOnce([
        {
          instId: "BTC-USDT",
          instType: "SPOT",
          state: "live",
          minSz: "0.00001",
        },
      ])
      .mockResolvedValue([]);

    const asset = await provider.getAsset("WEEDCOIN.X");
    expect(asset).toBeNull();
  });

  it("returns an asset when the exact instId exists", async () => {
    const provider = createOkxTradingProvider(mockClient);
    mockGetInstruments.mockResolvedValueOnce([
      {
        instId: "CAW-USDT",
        instType: "SPOT",
        state: "live",
        minSz: "1",
      },
    ]);

    const asset = await provider.getAsset("CAW/USDT");
    expect(asset).not.toBeNull();
    expect(asset?.id).toBe("CAW-USDT");
    expect(asset?.tradable).toBe(true);
  });
});

