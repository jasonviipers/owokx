import { createError, ErrorCode } from "../../lib/errors";
import type { Bar, BarsParams, MarketDataProvider, Quote, Snapshot } from "../types";
import type { OkxClient } from "./client";
import { hasExplicitOkxQuote, normalizeOkxSymbol } from "./symbols";

interface OkxTicker {
  instId: string;
  last: string;
  bidPx?: string;
  bidSz?: string;
  askPx?: string;
  askSz?: string;
  ts: string;
}

interface OkxTrade {
  ts: string;
  px: string;
  sz: string;
}

type OkxCandle = [string, string, string, string, string, string, ...string[]];

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function mapTimeframe(timeframe: string): string {
  const tf = timeframe.toLowerCase();
  if (tf === "1min" || tf === "1m") return "1m";
  if (tf === "5min" || tf === "5m") return "5m";
  if (tf === "15min" || tf === "15m") return "15m";
  if (tf === "30min" || tf === "30m") return "30m";
  if (tf === "1hour" || tf === "1h") return "1H";
  if (tf === "4hour" || tf === "4h") return "4H";
  if (tf === "1day" || tf === "1d") return "1D";
  if (tf === "1week" || tf === "1w") return "1W";
  return timeframe;
}

function candleToBar(c: OkxCandle): Bar {
  const ts = Number(c[0]);
  return {
    t: new Date(ts).toISOString(),
    o: parseNumber(c[1]),
    h: parseNumber(c[2]),
    l: parseNumber(c[3]),
    c: parseNumber(c[4]),
    v: parseNumber(c[5]),
    n: 0,
    vw: parseNumber(c[4]),
  };
}

function assertOkxMarketSymbol(symbol: string): void {
  if (hasExplicitOkxQuote(symbol)) {
    return;
  }

  throw createError(
    ErrorCode.INVALID_INPUT,
    `OKX market data requires an explicit crypto pair symbol (for example BTC/USDT). Received: ${symbol}`
  );
}

export class OkxMarketDataProvider implements MarketDataProvider {
  constructor(
    private client: OkxClient,
    private defaultQuote: string
  ) {}

  async getBars(symbol: string, timeframe: string, params?: BarsParams): Promise<Bar[]> {
    assertOkxMarketSymbol(symbol);
    const info = normalizeOkxSymbol(symbol, this.defaultQuote);
    const bar = mapTimeframe(timeframe);
    const limit = params?.limit ?? 100;
    const res = await this.client.request<OkxCandle>(
      "GET",
      "/api/v5/market/candles",
      {
        instId: info.instId,
        bar,
        limit,
      },
      undefined,
      { auth: false }
    );
    const data = res.data ?? [];
    return data.map(candleToBar).reverse();
  }

  async getLatestBar(symbol: string): Promise<Bar> {
    const bars = await this.getBars(symbol, "1m", { limit: 1 });
    const latest = bars[bars.length - 1];
    if (!latest) throw createError(ErrorCode.NOT_FOUND, `No bars found for ${symbol}`);
    return latest;
  }

  async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
    const results = await Promise.all(symbols.map(async (s) => [s, await this.getLatestBar(s)] as const));
    return Object.fromEntries(results);
  }

  async getQuote(symbol: string): Promise<Quote> {
    assertOkxMarketSymbol(symbol);
    const info = normalizeOkxSymbol(symbol, this.defaultQuote);
    const res = await this.client.request<OkxTicker>(
      "GET",
      "/api/v5/market/ticker",
      { instId: info.instId },
      undefined,
      { auth: false }
    );
    const t = res.data[0];
    if (!t) throw createError(ErrorCode.NOT_FOUND, `No ticker found for ${symbol}`);

    return {
      symbol: info.normalizedSymbol,
      bid_price: parseNumber(t.bidPx),
      bid_size: parseNumber(t.bidSz),
      ask_price: parseNumber(t.askPx),
      ask_size: parseNumber(t.askSz),
      timestamp: new Date(Number(t.ts)).toISOString(),
    };
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const results = await Promise.all(symbols.map(async (s) => [s, await this.getQuote(s)] as const));
    return Object.fromEntries(results);
  }

  async getSnapshot(symbol: string): Promise<Snapshot> {
    return this.getCryptoSnapshot(symbol);
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const results = await Promise.all(symbols.map(async (s) => [s, await this.getCryptoSnapshot(s)] as const));
    return Object.fromEntries(results);
  }

  async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
    assertOkxMarketSymbol(symbol);
    const info = normalizeOkxSymbol(symbol, this.defaultQuote);

    const [tickerRes, tradeRes, minuteBars, dailyBars] = await Promise.all([
      this.client.request<OkxTicker>("GET", "/api/v5/market/ticker", { instId: info.instId }, undefined, {
        auth: false,
      }),
      this.client.request<OkxTrade>("GET", "/api/v5/market/trades", { instId: info.instId, limit: 1 }, undefined, {
        auth: false,
      }),
      this.getBars(info.normalizedSymbol, "1m", { limit: 2 }),
      this.getBars(info.normalizedSymbol, "1D", { limit: 3 }),
    ]);

    const ticker = tickerRes.data[0];
    if (!ticker) throw createError(ErrorCode.NOT_FOUND, `No ticker found for ${symbol}`);

    const trade = tradeRes.data[0];
    const price = parseNumber(ticker.last);

    const minute =
      minuteBars[minuteBars.length - 1] ??
      candleToBar([ticker.ts, String(price), String(price), String(price), String(price), "0"]);
    const daily = dailyBars[dailyBars.length - 1] ?? minute;
    const prevDaily = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2]! : daily;

    const ts = new Date(Number(ticker.ts)).toISOString();

    return {
      symbol: info.normalizedSymbol,
      latest_trade: {
        price: trade ? parseNumber(trade.px) : price,
        size: trade ? parseNumber(trade.sz) : 0,
        timestamp: trade ? new Date(Number(trade.ts)).toISOString() : ts,
      },
      latest_quote: {
        symbol: info.normalizedSymbol,
        bid_price: parseNumber(ticker.bidPx),
        bid_size: parseNumber(ticker.bidSz),
        ask_price: parseNumber(ticker.askPx),
        ask_size: parseNumber(ticker.askSz),
        timestamp: ts,
      },
      minute_bar: minute,
      daily_bar: daily,
      prev_daily_bar: prevDaily,
    };
  }
}

export function createOkxMarketDataProvider(client: OkxClient, defaultQuote: string): OkxMarketDataProvider {
  return new OkxMarketDataProvider(client, defaultQuote);
}
