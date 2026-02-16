import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerProvider, MarketDataProvider, OptionsProvider } from "../providers/types";

const mocks = vi.hoisted(() => ({
  alpacaTradingGetAccount: vi.fn(),
  alpacaTradingCreateOrder: vi.fn(),
  polymarketTradingGetAccount: vi.fn(),
  polymarketTradingCreateOrder: vi.fn(),
}));

function createStubTrading(
  getAccountMock: ReturnType<typeof vi.fn>,
  createOrderMock: ReturnType<typeof vi.fn>
): BrokerProvider {
  return {
    getAccount: getAccountMock,
    getPositions: vi.fn(async () => []),
    getPosition: vi.fn(async () => null),
    closePosition: vi.fn(async () => ({}) as never),
    createOrder: createOrderMock,
    getOrder: vi.fn(async () => ({}) as never),
    listOrders: vi.fn(async () => []),
    cancelOrder: vi.fn(async () => {}),
    cancelAllOrders: vi.fn(async () => {}),
    getClock: vi.fn(async () => ({
      timestamp: new Date().toISOString(),
      is_open: true,
      next_open: new Date().toISOString(),
      next_close: new Date().toISOString(),
    })),
    getCalendar: vi.fn(async () => []),
    getAsset: vi.fn(async () => null),
    getPortfolioHistory: vi.fn(async () => ({
      timestamp: [],
      equity: [],
      profit_loss: [],
      profit_loss_pct: [],
      base_value: 0,
      timeframe: "1D",
    })),
  };
}

function createStubMarketData(): MarketDataProvider {
  return {
    getBars: vi.fn(async () => []),
    getLatestBar: vi.fn(async () => ({
      t: new Date().toISOString(),
      o: 0,
      h: 0,
      l: 0,
      c: 0,
      v: 0,
      n: 0,
      vw: 0,
    })),
    getLatestBars: vi.fn(async () => ({})),
    getQuote: vi.fn(async (symbol: string) => ({
      symbol,
      bid_price: 0,
      bid_size: 0,
      ask_price: 0,
      ask_size: 0,
      timestamp: new Date().toISOString(),
    })),
    getQuotes: vi.fn(async () => ({})),
    getSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      latest_trade: { price: 0, size: 0, timestamp: new Date().toISOString() },
      latest_quote: {
        symbol,
        bid_price: 0,
        bid_size: 0,
        ask_price: 0,
        ask_size: 0,
        timestamp: new Date().toISOString(),
      },
      minute_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
      daily_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
      prev_daily_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
    })),
    getSnapshots: vi.fn(async () => ({})),
    getCryptoSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      latest_trade: { price: 0, size: 0, timestamp: new Date().toISOString() },
      latest_quote: {
        symbol,
        bid_price: 0,
        bid_size: 0,
        ask_price: 0,
        ask_size: 0,
        timestamp: new Date().toISOString(),
      },
      minute_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
      daily_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
      prev_daily_bar: {
        t: new Date().toISOString(),
        o: 0,
        h: 0,
        l: 0,
        c: 0,
        v: 0,
        n: 0,
        vw: 0,
      },
    })),
  };
}

function createStubOptions(): OptionsProvider {
  return {
    isConfigured: () => true,
    getExpirations: vi.fn(async () => []),
    getChain: vi.fn(async () => ({ symbol: "AAPL", expiration: "2026-01-01", calls: [], puts: [] })),
    getSnapshot: vi.fn(async () => ({
      symbol: "AAPL240119C00100000",
      latest_quote: { bid_price: 0, bid_size: 0, ask_price: 0, ask_size: 0 },
    })),
    getSnapshots: vi.fn(async () => ({})),
  };
}

vi.mock("../providers/alpaca", () => ({
  createAlpacaProviders: vi.fn(() => ({
    trading: createStubTrading(mocks.alpacaTradingGetAccount, mocks.alpacaTradingCreateOrder),
    marketData: createStubMarketData(),
    options: createStubOptions(),
  })),
}));

vi.mock("../providers/okx", () => ({
  createOkxProviders: vi.fn(() => ({
    trading: createStubTrading(
      vi.fn(async () => ({})),
      vi.fn(async () => ({}))
    ),
    marketData: createStubMarketData(),
    options: createStubOptions(),
    websocket: {},
  })),
}));

vi.mock("../providers/polymarket", () => ({
  createPolymarketProviders: vi.fn(() => ({
    trading: createStubTrading(mocks.polymarketTradingGetAccount, mocks.polymarketTradingCreateOrder),
    marketData: createStubMarketData(),
    options: createStubOptions(),
    client: {},
  })),
}));

import { createBrokerProviders, resolveBroker } from "../providers/broker-factory";

function createEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ALPACA_API_KEY: "alpaca-key",
    ALPACA_API_SECRET: "alpaca-secret",
    OKX_API_KEY: "okx-key",
    OKX_SECRET: "okx-secret",
    OKX_PASSPHRASE: "okx-passphrase",
    POLYMARKET_API_KEY: "poly-key",
    POLYMARKET_API_SECRET: "poly-secret",
    POLYMARKET_API_PASSPHRASE: "poly-passphrase",
    POLYMARKET_ADDRESS: "0xabc",
    ...overrides,
  } as any;
}

describe("broker-factory", () => {
  beforeEach(() => {
    mocks.alpacaTradingGetAccount.mockReset();
    mocks.alpacaTradingCreateOrder.mockReset();
    mocks.polymarketTradingGetAccount.mockReset();
    mocks.polymarketTradingCreateOrder.mockReset();

    mocks.alpacaTradingGetAccount.mockResolvedValue({ id: "alpaca-account" });
    mocks.alpacaTradingCreateOrder.mockResolvedValue({ id: "alpaca-order" });

    mocks.polymarketTradingGetAccount.mockResolvedValue({ id: "polymarket-account" });
    mocks.polymarketTradingCreateOrder.mockRejectedValue({ code: "PROVIDER_ERROR", message: "primary failed" });
  });

  it("resolves polymarket broker ids", () => {
    expect(resolveBroker(createEnv({ BROKER_PROVIDER: "polymarket" }) as any)).toBe("polymarket");
    expect(resolveBroker(createEnv() as any, "polymarket")).toBe("polymarket");
  });

  it("falls back on read calls when primary broker fails", async () => {
    mocks.polymarketTradingGetAccount.mockRejectedValueOnce({ code: "PROVIDER_ERROR", message: "down" });
    const providers = createBrokerProviders(
      createEnv({
        BROKER_PROVIDER: "polymarket",
        BROKER_FALLBACK_PROVIDER: "alpaca",
      }) as any
    );

    const account = await providers.trading.getAccount();
    expect(account.id).toBe("alpaca-account");
  });

  it("does not fallback on unauthorized errors", async () => {
    mocks.polymarketTradingGetAccount.mockRejectedValueOnce({ code: "UNAUTHORIZED", message: "bad creds" });
    const providers = createBrokerProviders(
      createEnv({
        BROKER_PROVIDER: "polymarket",
        BROKER_FALLBACK_PROVIDER: "alpaca",
      }) as any
    );

    await expect(providers.trading.getAccount()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("does not fallback trading submits by default", async () => {
    const providers = createBrokerProviders(
      createEnv({
        BROKER_PROVIDER: "polymarket",
        BROKER_FALLBACK_PROVIDER: "alpaca",
        BROKER_FALLBACK_ALLOW_TRADING: "false",
      }) as any
    );

    await expect(
      providers.trading.createOrder({
        symbol: "AAPL",
        notional: 100,
        side: "buy",
        type: "market",
        time_in_force: "day",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("can fallback trading submits when explicitly enabled", async () => {
    const providers = createBrokerProviders(
      createEnv({
        BROKER_PROVIDER: "polymarket",
        BROKER_FALLBACK_PROVIDER: "alpaca",
        BROKER_FALLBACK_ALLOW_TRADING: "true",
      }) as any
    );

    const order = await providers.trading.createOrder({
      symbol: "AAPL",
      notional: 100,
      side: "buy",
      type: "market",
      time_in_force: "day",
    });
    expect(order.id).toBe("alpaca-order");
  });
});
