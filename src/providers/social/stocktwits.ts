export interface StockTwitMessage {
  id: number;
  body: string;
  created_at: string;
  user: {
    username: string;
    followers: number;
  };
  symbols: Array<{ symbol: string }>;
  entities?: {
    sentiment?: { basic: "Bullish" | "Bearish" | null };
  };
}

export interface StockTwitsTrending {
  symbol: string;
  watchlist_count: number;
  title: string;
}

interface StockTwitsStreamResponse {
  messages: StockTwitMessage[];
}

interface StockTwitsTrendingResponse {
  symbols: StockTwitsTrending[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_FEED_LIMIT = 100;

function clampFeedLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_FEED_LIMIT, Math.floor(limit)));
}

async function fetchJson<T>(url: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class StockTwitsProvider {
  private baseUrl = "https://api.stocktwits.com/api/2";

  async getTrendingSymbols(): Promise<StockTwitsTrending[]> {
    const data = await fetchJson<StockTwitsTrendingResponse>(`${this.baseUrl}/trending/symbols.json`);
    return data.symbols || [];
  }

  async getSymbolStream(symbol: string, limit = 30): Promise<StockTwitMessage[]> {
    const safeSymbol = encodeURIComponent(symbol.trim().toUpperCase());
    const safeLimit = clampFeedLimit(limit);
    try {
      const data = await fetchJson<StockTwitsStreamResponse>(
        `${this.baseUrl}/streams/symbol/${safeSymbol}.json?limit=${safeLimit}`
      );
      return data.messages || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)")) return [];
      throw new Error(`StockTwits API error for symbol ${safeSymbol}: ${message}`);
    }
  }

  async getTrendingStream(limit = 30): Promise<StockTwitMessage[]> {
    const safeLimit = clampFeedLimit(limit);
    const data = await fetchJson<StockTwitsStreamResponse>(`${this.baseUrl}/streams/trending.json?limit=${safeLimit}`);
    return data.messages || [];
  }

  analyzeSentiment(messages: StockTwitMessage[]): {
    symbol: string;
    bullish: number;
    bearish: number;
    total: number;
    score: number;
    trending_users: string[];
  }[] {
    const bySymbol = new Map<string, { bullish: number; bearish: number; total: number; users: Set<string> }>();

    for (const msg of messages) {
      for (const sym of msg.symbols) {
        if (!bySymbol.has(sym.symbol)) {
          bySymbol.set(sym.symbol, { bullish: 0, bearish: 0, total: 0, users: new Set() });
        }
        const data = bySymbol.get(sym.symbol)!;
        data.total++;
        data.users.add(msg.user.username);

        const sentiment = msg.entities?.sentiment?.basic;
        if (sentiment === "Bullish") data.bullish++;
        else if (sentiment === "Bearish") data.bearish++;
      }
    }

    return Array.from(bySymbol.entries()).map(([symbol, data]) => ({
      symbol,
      bullish: data.bullish,
      bearish: data.bearish,
      total: data.total,
      score: data.total > 0 ? (data.bullish - data.bearish) / data.total : 0,
      trending_users: Array.from(data.users).slice(0, 5),
    }));
  }
}

// export function createStockTwitsProvider(): StockTwitsProvider {
//   return new StockTwitsProvider();
// }

export interface TradingViewIdea {
  id: number;
  description: string; // Maps from body
  published: string; // Maps from created_at (ISO timestamp)
  author: {
    username: string;
    followers_count: number; // Maps from followers
  };
  markets: Array<{
    // Maps from symbols
    name: string; // Symbol name (e.g., "AAPL")
    exchange: string;
  }>;
  labels?: Array<{
    // Maps from sentiment
    name: "Long" | "Short" | "Neutral";
    color: string;
  }>;
}

export interface TradingViewMarket {
  name: string; // Symbol
  exchange: string;
  pricescale: number;
  minmov: number;
  description: string; // Company name/title
  volume: number;
  change: number;
  change_percent: number;
}

interface TradingViewIdeasResponse {
  data: TradingViewIdea[];
  total: number;
  page: number;
  per_page: number;
}

interface TradingViewMarketsResponse {
  data: TradingViewMarket[];
}

export class TradingViewProvider {
  private baseUrl = "https://www.tradingview.com";

  async getTrendingMarkets(): Promise<TradingViewMarket[]> {
    // TradingView uses a different API structure - often requires auth or uses internal endpoints
    // This uses their public hotlists/screener data
    const data = await fetchJson<TradingViewMarketsResponse>(`${this.baseUrl}/hotlists/?format=json&limit=50`);
    return data.data || [];
  }

  async getMarketIdeas(symbol: string, limit = 30): Promise<TradingViewIdea[]> {
    // Fetch ideas for a specific symbol/market
    const safeSymbol = encodeURIComponent(symbol.trim().toUpperCase());
    const safeLimit = clampFeedLimit(limit);
    try {
      const data = await fetchJson<TradingViewIdeasResponse>(
        `${this.baseUrl}/ideas/${safeSymbol}/?format=json&limit=${safeLimit}`
      );
      return data.data || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)")) return [];
      throw new Error(`TradingView API error for symbol ${safeSymbol}: ${message}`);
    }
  }

  async getTrendingIdeas(limit = 30): Promise<TradingViewIdea[]> {
    // Fetch trending ideas across all markets
    const safeLimit = clampFeedLimit(limit);
    const data = await fetchJson<TradingViewIdeasResponse>(
      `${this.baseUrl}/ideas/?format=json&sort=trending&limit=${safeLimit}`
    );
    return data.data || [];
  }

  async getUserIdeas(username: string, limit = 30): Promise<TradingViewIdea[]> {
    // Fetch ideas from a specific user
    const safeUsername = encodeURIComponent(username.trim());
    const safeLimit = clampFeedLimit(limit);
    try {
      const data = await fetchJson<TradingViewIdeasResponse>(
        `${this.baseUrl}/u/${safeUsername}/ideas/?format=json&limit=${safeLimit}`
      );
      return data.data || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)")) return [];
      throw new Error(`TradingView API error for user ${safeUsername}: ${message}`);
    }
  }

  analyzeSentiment(ideas: TradingViewIdea[]): {
    symbol: string;
    long: number;
    short: number;
    neutral: number;
    total: number;
    score: number;
    trending_users: string[];
  }[] {
    const bySymbol = new Map<
      string,
      {
        long: number;
        short: number;
        neutral: number;
        total: number;
        users: Set<string>;
      }
    >();

    for (const idea of ideas) {
      for (const market of idea.markets) {
        if (!bySymbol.has(market.name)) {
          bySymbol.set(market.name, {
            long: 0,
            short: 0,
            neutral: 0,
            total: 0,
            users: new Set(),
          });
        }

        const data = bySymbol.get(market.name)!;
        data.total++;
        data.users.add(idea.author.username);

        // TradingView uses labels for sentiment: Long (Bullish), Short (Bearish)
        const sentiment = idea.labels?.[0]?.name;
        if (sentiment === "Long") data.long++;
        else if (sentiment === "Short") data.short++;
        else data.neutral++;
      }
    }

    return Array.from(bySymbol.entries()).map(([symbol, data]) => ({
      symbol,
      long: data.long,
      short: data.short,
      neutral: data.neutral,
      total: data.total,
      score: data.total > 0 ? (data.long - data.short) / data.total : 0,
      trending_users: Array.from(data.users).slice(0, 5),
    }));
  }

  // Helper to map old StockTwits format to TradingView format
  static fromStockTwitsFormat(stockTwitsData: StockTwitMessage): TradingViewIdea {
    return {
      id: stockTwitsData.id,
      description: stockTwitsData.body,
      published: stockTwitsData.created_at,
      author: {
        username: stockTwitsData.user?.username,
        followers_count: stockTwitsData.user?.followers || 0,
      },
      markets: (stockTwitsData.symbols || []).map((s) => ({
        name: s.symbol,
        exchange: "NASDAQ", // Default fallback
      })),
      labels: stockTwitsData.entities?.sentiment?.basic
        ? [
            {
              name: stockTwitsData.entities.sentiment.basic === "Bullish" ? "Long" : "Short",
              color: stockTwitsData.entities.sentiment.basic === "Bullish" ? "green" : "red",
            },
          ]
        : undefined,
    };
  }
}

export function createTradingViewProvider(): TradingViewProvider {
  return new TradingViewProvider();
}

// Backward compatibility alias
export function createStockTwitsProvider(): StockTwitsProvider {
  return new StockTwitsProvider();
}
