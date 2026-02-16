import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OkxClient } from "../providers/okx/client";
import { createOkxTradingProvider } from "../providers/okx/trading";

function createMockAccountBalance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totalEq: "0",
    adjEq: undefined,
    mmr: "0",
    imr: "0",
    uTime: "1704067200000",
    details: [
      {
        ccy: "USDT",
        cashBal: "0",
      },
    ],
    ...overrides,
  };
}

function createMockClient(getBalance: ReturnType<typeof vi.fn>, simulatedTrading: boolean): OkxClient {
  return {
    rest: {
      getBalance,
    },
    ws: {} as OkxClient["ws"],
    config: {
      apiKey: "test",
      apiSecret: "test",
      apiPass: "test",
      defaultQuoteCcy: "USDT",
      simulatedTrading,
    },
    rateLimiter: {} as OkxClient["rateLimiter"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OkxClient;
}

describe("OKX Trading Provider demo balance behavior", () => {
  let mockGetBalance: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetBalance = vi.fn();
  });

  it("seeds virtual cash and buying power in demo mode when quote balance is empty", async () => {
    const client = createMockClient(mockGetBalance, true);
    const provider = createOkxTradingProvider(client);

    mockGetBalance.mockResolvedValueOnce([createMockAccountBalance()]);

    const account = await provider.getAccount();

    expect(account.cash).toBe(25000);
    expect(account.buying_power).toBe(40000);
    expect(account.equity).toBe(25000);
  });

  it("does not seed virtual values outside demo mode", async () => {
    const client = createMockClient(mockGetBalance, false);
    const provider = createOkxTradingProvider(client);

    mockGetBalance.mockResolvedValueOnce([createMockAccountBalance()]);

    const account = await provider.getAccount();

    expect(account.cash).toBe(0);
    expect(account.buying_power).toBe(0);
    expect(account.equity).toBe(0);
  });

  it("preserves reported balances in demo mode when quote balance exists", async () => {
    const client = createMockClient(mockGetBalance, true);
    const provider = createOkxTradingProvider(client);

    mockGetBalance.mockResolvedValueOnce([
      createMockAccountBalance({
        totalEq: "25000",
        adjEq: "50000",
        details: [
          {
            ccy: "USDT",
            cashBal: "12000",
          },
        ],
      }),
    ]);

    const account = await provider.getAccount();

    expect(account.cash).toBe(12000);
    expect(account.buying_power).toBe(50000);
    expect(account.equity).toBe(25000);
  });
});
