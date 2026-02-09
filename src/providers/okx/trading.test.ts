import { describe, expect, it, vi } from "vitest";
import type { OkxApiResponse, OkxClient } from "./client";
import { OkxTradingProvider } from "./trading";

describe("OKX Trading Provider", () => {
  it("creates market buy order with notional using quote_ccy sizing", async () => {
    const resp: OkxApiResponse<{ ordId: string; sCode: string; sMsg: string }> = {
      code: "0",
      msg: "",
      data: [{ ordId: "123", sCode: "0", sMsg: "" }],
    };

    const client = { request: vi.fn(async () => resp) } as unknown as OkxClient;

    const provider = new OkxTradingProvider(client, "USDT");
    const order = await provider.createOrder({
      symbol: "BTC/USD",
      notional: 100,
      side: "buy",
      type: "market",
      time_in_force: "gtc",
    });

    expect(order.id).toBe("123");
    expect(order.symbol).toBe("BTC/USDT");

    const call = (client.request as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      Record<string, string | number | undefined> | undefined,
      unknown | undefined,
    ];

    expect(call[0]).toBe("POST");
    expect(call[1]).toBe("/api/v5/trade/order");
    expect(call[3]).toMatchObject({
      instId: "BTC-USDT",
      side: "buy",
      ordType: "market",
      tdMode: "cash",
      sz: "100",
      tgtCcy: "quote_ccy",
    });
  });
});
