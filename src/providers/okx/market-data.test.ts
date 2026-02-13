import { describe, expect, it, vi } from "vitest";
import type { OkxApiResponse, OkxClient } from "./client";
import { OkxMarketDataProvider } from "./market-data";

describe("OKX Market Data Provider", () => {
  it("parses candles into ascending bars", async () => {
    const resp: OkxApiResponse<[string, string, string, string, string, string]> = {
      code: "0",
      msg: "",
      data: [
        ["1700000060000", "2", "3", "1", "2.5", "20"],
        ["1700000000000", "1", "2", "0.5", "1.5", "10"],
      ],
    };

    const client = { request: vi.fn(async () => resp) } as unknown as OkxClient;

    const provider = new OkxMarketDataProvider(client, "USDT");
    const bars = await provider.getBars("BTC/USDT", "1Min", { limit: 2 });

    expect(bars).toHaveLength(2);
    expect(new Date(bars[0]!.t).getTime()).toBeLessThan(new Date(bars[1]!.t).getTime());
    expect(bars[0]!.o).toBe(1);
    expect(bars[1]!.o).toBe(2);
  });

  it("rejects non-crypto pair symbols before issuing OKX requests", async () => {
    const requestMock = vi.fn();
    const client = { request: requestMock } as unknown as OkxClient;

    const provider = new OkxMarketDataProvider(client, "USDT");

    await expect(provider.getBars("TLT", "1Min", { limit: 2 })).rejects.toThrow(
      "requires an explicit crypto pair symbol"
    );
    expect(requestMock).not.toHaveBeenCalled();
  });
});
