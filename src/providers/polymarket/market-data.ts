import type { Bar, BarsParams, MarketDataProvider, Quote, Snapshot } from "../types";
import type { PolymarketClient } from "./client";
import { PolymarketClientError } from "./errors";
import { type PolymarketSymbolMap, resolvePolymarketTokenId } from "./symbols";
import { toQuote, toSnapshot, toSyntheticBar } from "./transformers";
import type { PolymarketPriceHistoryPoint, PolymarketPriceHistoryResponse } from "./types";

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseHistoryPoint(point: PolymarketPriceHistoryPoint | undefined): { t: string; p: number } | null {
  if (!point) return null;
  const rawTimestamp = point.timestamp ?? point.t;
  const rawPrice = point.price ?? point.p;
  const price = parseNumber(rawPrice, NaN);
  if (!Number.isFinite(price)) return null;

  if (typeof rawTimestamp === "string" && rawTimestamp.trim().length > 0) {
    const parsed = Date.parse(rawTimestamp);
    if (Number.isFinite(parsed)) {
      return { t: new Date(parsed).toISOString(), p: price };
    }
    const asNumber = Number.parseInt(rawTimestamp, 10);
    if (Number.isFinite(asNumber)) {
      const ms = rawTimestamp.length > 10 ? asNumber : asNumber * 1000;
      return { t: new Date(ms).toISOString(), p: price };
    }
  }

  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)) {
    const ms = rawTimestamp > 1_000_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    return { t: new Date(ms).toISOString(), p: price };
  }

  return {
    t: new Date().toISOString(),
    p: price,
  };
}

function parseHistory(response: PolymarketPriceHistoryResponse | undefined): Array<{ t: string; p: number }> {
  if (!response) return [];
  const points = (response.history ?? response.data ?? [])
    .map((point) => parseHistoryPoint(point))
    .filter((point): point is { t: string; p: number } => point !== null);
  return points.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function historyToBars(points: Array<{ t: string; p: number }>): Bar[] {
  return points.map((point) => toSyntheticBar(point.t, point.p));
}

export interface PolymarketMarketDataProvider extends MarketDataProvider {}

export function createPolymarketMarketDataProvider(
  client: PolymarketClient,
  symbolMap: PolymarketSymbolMap
): PolymarketMarketDataProvider {
  return {
    async getBars(symbol: string, _timeframe: string, params?: BarsParams): Promise<Bar[]> {
      const tokenId = resolvePolymarketTokenId(symbol, symbolMap);
      let bars = historyToBars(parseHistory(await client.getPricesHistory(tokenId)));

      if (params?.start || params?.end) {
        const startMs = params.start ? Date.parse(params.start) : Number.NEGATIVE_INFINITY;
        const endMs = params.end ? Date.parse(params.end) : Number.POSITIVE_INFINITY;
        bars = bars.filter((bar) => {
          const barMs = Date.parse(bar.t);
          return barMs >= startMs && barMs <= endMs;
        });
      }

      if (params?.limit && params.limit > 0 && bars.length > params.limit) {
        bars = bars.slice(-params.limit);
      }

      if (bars.length > 0) {
        return bars;
      }

      const snapshot = await this.getSnapshot(symbol);
      return [snapshot.minute_bar];
    },

    async getLatestBar(symbol: string): Promise<Bar> {
      const bars = await this.getBars(symbol, "1m", { limit: 1 });
      const latest = bars[bars.length - 1];
      if (!latest) {
        throw new Error(`No market data for ${symbol}`);
      }
      return latest;
    },

    async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
      const out: Record<string, Bar> = {};
      for (const symbol of symbols) {
        out[symbol] = await this.getLatestBar(symbol);
      }
      return out;
    },

    async getQuote(symbol: string): Promise<Quote> {
      const tokenId = resolvePolymarketTokenId(symbol, symbolMap);
      const book = await client.getBook(tokenId);
      return toQuote(symbol, book);
    },

    async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
      const out: Record<string, Quote> = {};
      for (const symbol of symbols) {
        out[symbol] = await this.getQuote(symbol);
      }
      return out;
    },

    async getSnapshot(symbol: string): Promise<Snapshot> {
      const tokenId = resolvePolymarketTokenId(symbol, symbolMap);
      const [book, midpoint, lastTradePrice] = await Promise.all([
        client.getBook(tokenId),
        client.getMidpoint(tokenId).catch(() => ({ mid: undefined })),
        client.getLastTradePrice(tokenId).catch(() => ({ price: undefined })),
      ]);

      const quote = toQuote(symbol, book);
      const mid = parseNumber(midpoint.mid, Number.NaN);
      const last = parseNumber(lastTradePrice.price, Number.NaN);
      const quoteMid = quote.bid_price > 0 && quote.ask_price > 0 ? (quote.bid_price + quote.ask_price) / 2 : 0;
      const referencePrice =
        Number.isFinite(mid) && mid > 0 ? mid : Number.isFinite(last) && last > 0 ? last : quoteMid;

      return toSnapshot(symbol, quote, referencePrice > 0 ? referencePrice : quoteMid);
    },

    async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
      const out: Record<string, Snapshot> = {};
      for (const symbol of symbols) {
        out[symbol] = await this.getSnapshot(symbol);
      }
      return out;
    },

    async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
      try {
        return await this.getSnapshot(symbol);
      } catch (error) {
        if (error instanceof PolymarketClientError && error.code === "NOT_FOUND") {
          throw new Error(`No Polymarket market data found for ${symbol}`);
        }
        throw error;
      }
    },
  };
}
