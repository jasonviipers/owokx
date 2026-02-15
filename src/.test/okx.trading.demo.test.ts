import { describe, expect, it, vi } from "vitest";
import type { OkxClient } from "../providers/okx/client";
import { createOkxTradingProvider } from "../providers/okx/trading";

function createMockOkxClient(responseData: unknown) {
  return {
    request: vi.fn().mockResolvedValue({
      code: "0",
      msg: "",
      data: [responseData],
    }),
  } as unknown as OkxClient;
}

describe("OKX Trading Provider demo balance behavior", () => {
  it("uses quote cashBal/eq when availBal is zero-like", async () => {
    const client = createMockOkxClient({
      totalEq: "87472.61",
      details: [
        {
          ccy: "USDT",
          availBal: "0",
          cashBal: "1200.50",
          eq: "1200.50",
        },
      ],
    });
    const provider = createOkxTradingProvider(client, "USDT");

    const account = await provider.getAccount();

    expect(account.cash).toBe(1200.5);
    expect(account.buying_power).toBe(1200.5);
    expect(account.equity).toBe(87472.61);
  });

  it("seeds virtual cash and buying power in demo mode when quote balance is empty", async () => {
    const client = createMockOkxClient({
      totalEq: "0",
      details: [
        {
          ccy: "USDT",
          availBal: "0",
          cashBal: "0",
          eq: "0",
        },
      ],
    });
    const provider = createOkxTradingProvider(client, "USDT", {
      simulatedTrading: true,
      enableDemoVirtualBalances: true,
      demoVirtualCashUsd: 25000,
      demoVirtualBuyingPowerUsd: 40000,
    });

    const account = await provider.getAccount();

    expect(account.cash).toBe(25000);
    expect(account.buying_power).toBe(40000);
    expect(account.equity).toBe(25000);
  });

  it("never applies demo virtual balances in live mode", async () => {
    const client = createMockOkxClient({
      totalEq: "0",
      details: [
        {
          ccy: "USDT",
          availBal: "0",
          cashBal: "0",
          eq: "0",
        },
      ],
    });
    const provider = createOkxTradingProvider(client, "USDT", {
      simulatedTrading: false,
      enableDemoVirtualBalances: true,
      demoVirtualCashUsd: 25000,
      demoVirtualBuyingPowerUsd: 40000,
    });

    const account = await provider.getAccount();

    expect(account.cash).toBe(0);
    expect(account.buying_power).toBe(0);
    expect(account.equity).toBe(0);
  });
});
