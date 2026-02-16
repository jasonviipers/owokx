import type { Candle, Instrument, InstrumentType, OrderBook, Ticker, Trade } from "okx-api";
import { ErrorCode } from "../../lib/errors";
import type { Bar, BarsParams, MarketDataProvider, Quote, Snapshot } from "../types";
import type { OkxClient } from "./client";
import { handleOkxError, OkxClientError } from "./client";
import { normalizeOkxSymbol } from "./symbols";

function parseNumber(value: string | number | undefined, fallback: number = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function parseBar(raw: Candle): Bar {
  return {
    t: raw[0],
    o: parseNumber(raw[1]),
    h: parseNumber(raw[2]),
    l: parseNumber(raw[3]),
    c: parseNumber(raw[4]),
    v: parseNumber(raw[5]),
    n: 0,
    vw: parseNumber(raw[4]),
  };
}

function parseQuote(raw: Ticker): Quote {
  return {
    symbol: raw.instId,
    bid_price: parseNumber(raw.bidPx),
    bid_size: parseNumber(raw.bidSz),
    ask_price: parseNumber(raw.askPx),
    ask_size: parseNumber(raw.askSz),
    timestamp: raw.ts,
  };
}

function mapTimeframe(timeframe: string): string {
  switch (timeframe) {
    case "1m":
      return "1m";
    case "3m":
      return "3m";
    case "5m":
      return "5m";
    case "15m":
      return "15m";
    case "30m":
      return "30m";
    case "1h":
      return "1H";
    case "2h":
      return "2H";
    case "4h":
      return "4H";
    case "6h":
      return "6H";
    case "12h":
      return "12H";
    case "1d":
      return "1D";
    case "1w":
      return "1W";
    case "1M":
      return "1M";
    default:
      return "1H";
  }
}

function extractOkxCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  if (typeof record.okxCode === "string") return record.okxCode;

  if (typeof record.code === "string" && /^\d{5}$/.test(record.code)) {
    return record.code;
  }

  if (typeof record.msg === "string") {
    const msgCode = record.msg.match(/\b\d{5}\b/)?.[0];
    if (msgCode) return msgCode;
  }

  if (typeof record.message === "string") {
    const messageCode = record.message.match(/\b\d{5}\b/)?.[0];
    if (messageCode) return messageCode;
  }

  const response = record.response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    const data = responseRecord.data;
    if (data && typeof data === "object") {
      const dataCode = (data as Record<string, unknown>).code;
      if (typeof dataCode === "string") return dataCode;
    }
  }

  return undefined;
}

function extractOkxMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : undefined;
  }

  const record = error as Record<string, unknown>;
  if (typeof record.msg === "string") return record.msg;
  if (typeof record.message === "string") return record.message;

  const response = record.response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    const data = responseRecord.data;
    if (data && typeof data === "object") {
      const dataMessage = (data as Record<string, unknown>).msg;
      if (typeof dataMessage === "string") return dataMessage;
    }
  }

  return undefined;
}

function isInstrumentUnavailableError(error: unknown): boolean {
  return extractOkxCode(error) === "51001";
}

function buildUnsupportedInstrumentError(symbol: string, instId: string): OkxClientError {
  return new OkxClientError(
    `Instrument not found or unavailable: ${instId} (from symbol '${symbol}')`,
    ErrorCode.INVALID_INPUT,
    "51001"
  );
}

export interface OkxMarketDataProvider extends MarketDataProvider {
  getTicker(symbol: string): Promise<Ticker | null>;
  getTickers(instType: InstrumentType, uly?: string, instFamily?: string): Promise<Ticker[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook | null>;
  getTrades(symbol: string, limit?: number): Promise<Trade[]>;
  getHistoricTrades(
    symbol: string,
    params?: { after?: string; before?: string; limit?: number; type?: "1" | "2" }
  ): Promise<Trade[]>;
  getInstruments(
    instType: InstrumentType,
    filters?: { uly?: string; instFamily?: string; instId?: string }
  ): Promise<Instrument[]>;
}

export function createOkxMarketDataProvider(client: OkxClient): OkxMarketDataProvider {
  const toInstId = (symbol: string): string =>
    normalizeOkxSymbol(symbol, client.config.defaultQuoteCcy ?? "USDT").instId;
  const unsupportedInstIds = new Set<string>();

  const ensureInstrumentSupported = (symbol: string, instId: string): void => {
    if (!unsupportedInstIds.has(instId)) {
      return;
    }
    throw buildUnsupportedInstrumentError(symbol, instId);
  };

  const logBatchSkip = (operation: string, symbol: string, error: unknown): void => {
    if (isInstrumentUnavailableError(error)) {
      client.logger.debug(`Skipping unsupported symbol while ${operation}`, {
        symbol,
        okxCode: "51001",
      });
      return;
    }

    client.logger.warn(`Skipping symbol while ${operation}`, {
      symbol,
      error: String(error),
    });
  };

  const handleMarketDataError = (
    message: string,
    error: unknown,
    context: Record<string, unknown>,
    instId?: string
  ): never => {
    if (instId && isInstrumentUnavailableError(error)) {
      const firstSeen = !unsupportedInstIds.has(instId);
      unsupportedInstIds.add(instId);

      if (firstSeen) {
        client.logger.debug("OKX instrument unavailable; caching as unsupported", {
          ...context,
          instId,
          okxCode: "51001",
          okxMessage: extractOkxMessage(error),
        });
      }
    } else {
      client.logger.error(message, error, context);
    }

    throw handleOkxError(error);
  };

  return {
    async getBars(symbol: string, timeframe: string, params?: BarsParams): Promise<Bar[]> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const bar = mapTimeframe(timeframe);
        const response = await client.rest.getCandles({
          instId,
          bar,
          limit: String(params?.limit ?? 100),
          after: params?.start,
          before: params?.end,
        });

        return response.map(parseBar);
      } catch (error) {
        return handleMarketDataError("Failed to fetch bars", error, { symbol, timeframe }, instId);
      }
    },

    async getLatestBar(symbol: string): Promise<Bar> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const response = await client.rest.getCandles({
          instId,
          bar: "1m",
          limit: "1",
        });

        const first = response[0];
        if (!first) {
          throw new Error(`No candle data available for ${symbol}`);
        }

        return parseBar(first);
      } catch (error) {
        return handleMarketDataError("Failed to fetch latest bar", error, { symbol }, instId);
      }
    },

    async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
      const entries = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const bar = await this.getLatestBar(symbol);
            return [symbol, bar] as const;
          } catch (error) {
            logBatchSkip("fetching latest bars", symbol, error);
            return null;
          }
        })
      );

      return entries.reduce<Record<string, Bar>>((acc, entry) => {
        if (entry) {
          acc[entry[0]] = entry[1];
        }
        return acc;
      }, {});
    },

    async getQuote(symbol: string): Promise<Quote> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const response = await client.rest.getTicker({ instId });
        const first = response[0];
        if (!first) {
          throw new Error(`No ticker data for ${symbol}`);
        }

        return parseQuote(first);
      } catch (error) {
        return handleMarketDataError("Failed to fetch quote", error, { symbol }, instId);
      }
    },

    async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
      const entries = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const quote = await this.getQuote(symbol);
            return [symbol, quote] as const;
          } catch (error) {
            logBatchSkip("fetching quotes", symbol, error);
            return null;
          }
        })
      );

      return entries.reduce<Record<string, Quote>>((acc, entry) => {
        if (entry) {
          acc[entry[0]] = entry[1];
        }
        return acc;
      }, {});
    },

    async getSnapshot(symbol: string): Promise<Snapshot> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const [tickerResponse, candleResponse, tradeResponse] = await Promise.all([
          client.rest.getTicker({ instId }),
          client.rest.getCandles({ instId, bar: "1D", limit: "2" }),
          client.rest.getTrades({ instId, limit: 1 }),
        ]);

        const ticker = tickerResponse[0];
        if (!ticker) {
          throw new Error(`No ticker data for ${symbol}`);
        }

        const latestTrade = tradeResponse[0]
          ? {
              price: parseNumber(tradeResponse[0].px),
              size: parseNumber(tradeResponse[0].sz),
              timestamp: tradeResponse[0].ts,
            }
          : {
              price: parseNumber(ticker.last),
              size: parseNumber(ticker.lastSz),
              timestamp: ticker.ts,
            };

        const latestMinuteBar = await this.getLatestBar(symbol);
        const dailyBar = candleResponse[0] ? parseBar(candleResponse[0]) : latestMinuteBar;
        const previousDailyBar = candleResponse[1] ? parseBar(candleResponse[1]) : latestMinuteBar;

        return {
          symbol,
          latest_trade: latestTrade,
          latest_quote: parseQuote(ticker),
          minute_bar: latestMinuteBar,
          daily_bar: dailyBar,
          prev_daily_bar: previousDailyBar,
        };
      } catch (error) {
        return handleMarketDataError("Failed to fetch snapshot", error, { symbol }, instId);
      }
    },

    async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
      const entries = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const snapshot = await this.getSnapshot(symbol);
            return [symbol, snapshot] as const;
          } catch (error) {
            logBatchSkip("fetching snapshots", symbol, error);
            return null;
          }
        })
      );

      return entries.reduce<Record<string, Snapshot>>((acc, entry) => {
        if (entry) {
          acc[entry[0]] = entry[1];
        }
        return acc;
      }, {});
    },

    async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
      return this.getSnapshot(symbol);
    },

    async getTicker(symbol: string): Promise<Ticker | null> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const response = await client.rest.getTicker({ instId });
        return response[0] ?? null;
      } catch (error) {
        return handleMarketDataError("Failed to fetch ticker", error, { symbol }, instId);
      }
    },

    async getTickers(instType: InstrumentType, uly?: string, instFamily?: string): Promise<Ticker[]> {
      try {
        return client.rest.getTickers({ instType, uly, instFamily });
      } catch (error) {
        client.logger.error("Failed to fetch tickers", error, { instType, uly, instFamily });
        throw handleOkxError(error);
      }
    },

    async getOrderBook(symbol: string, depth: number = 20): Promise<OrderBook | null> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        const response = await client.rest.getOrderBook({
          instId,
          sz: String(depth),
        });

        return response[0] ?? null;
      } catch (error) {
        return handleMarketDataError("Failed to fetch order book", error, { symbol, depth }, instId);
      }
    },

    async getTrades(symbol: string, limit: number = 100): Promise<Trade[]> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        return client.rest.getTrades({
          instId,
          limit,
        });
      } catch (error) {
        return handleMarketDataError("Failed to fetch trades", error, { symbol, limit }, instId);
      }
    },

    async getHistoricTrades(
      symbol: string,
      params?: { after?: string; before?: string; limit?: number; type?: "1" | "2" }
    ): Promise<Trade[]> {
      const instId = toInstId(symbol);
      ensureInstrumentSupported(symbol, instId);

      try {
        return client.rest.getHistoricTrades({
          instId,
          after: params?.after,
          before: params?.before,
          limit: params?.limit ? String(params.limit) : undefined,
          type: params?.type,
        });
      } catch (error) {
        return handleMarketDataError(
          "Failed to fetch historic trades",
          error,
          { symbol, params: params as unknown as Record<string, unknown> },
          instId
        );
      }
    },

    async getInstruments(
      instType: InstrumentType,
      filters?: { uly?: string; instFamily?: string; instId?: string }
    ): Promise<Instrument[]> {
      try {
        return client.rest.getInstruments({
          instType,
          uly: filters?.uly,
          instFamily: filters?.instFamily,
          instId: filters?.instId,
        });
      } catch (error) {
        client.logger.error("Failed to fetch instruments", error, {
          instType,
          uly: filters?.uly,
          instFamily: filters?.instFamily,
          instId: filters?.instId,
        });
        throw handleOkxError(error);
      }
    },
  };
}
