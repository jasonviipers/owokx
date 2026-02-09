/**
 * DataScout - Simplified Durable Object for Data Gathering
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { extractTickers, DEFAULT_TICKER_BLACKLIST } from "../lib/ticker";

interface DataScoutState {
  signals: Record<string, {
    symbol: string;
    sentiment: number;
    sources: string[];
    timestamp: number;
    volume: number;
  }>;
  lastGatherTime: number;
}

const DEFAULT_STATE: DataScoutState = {
  signals: {},
  lastGatherTime: 0,
};

export class DataScoutSimple extends DurableObject<Env> {
  private state: DataScoutState = { ...DEFAULT_STATE };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<DataScoutState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/gather") {
      return this.handleGather();
    } else if (path === "/signals") {
      return this.handleGetSignals();
    } else if (path === "/health") {
      return this.handleHealth();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleGather(): Promise<Response> {
    try {
      await this.gatherStockTwits();
      await this.gatherReddit();
      
      this.state.lastGatherTime = Date.now();
      await this.ctx.storage.put("state", this.state);
      
      return new Response(JSON.stringify({ 
        success: true, 
        signalCount: Object.keys(this.state.signals).length 
      }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetSignals(): Promise<Response> {
    // Clean up stale signals (older than 3 hours)
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    
    for (const symbol in this.state.signals) {
      const signal = this.state.signals[symbol];
      if (signal && signal.timestamp < threeHoursAgo) {
        delete this.state.signals[symbol];
      }
    }
    
    return new Response(JSON.stringify({ 
      signals: Object.values(this.state.signals) 
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleHealth(): Promise<Response> {
    const now = Date.now();
    const lastGatherAge = now - this.state.lastGatherTime;
    const isHealthy = lastGatherAge < 300000; // 5 minutes
    
    return new Response(JSON.stringify({
      healthy: isHealthy,
      lastGatherTime: this.state.lastGatherTime,
      lastGatherAgeMs: lastGatherAge,
      signalCount: Object.keys(this.state.signals).length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async gatherStockTwits(): Promise<void> {
    if (!this.env.STOCKTWITS_API_TOKEN) return;

    try {
      const response = await fetch("https://api.stocktwits.com/api/2/streams/trending.json", {
        headers: {
          Authorization: `Bearer ${this.env.STOCKTWITS_API_TOKEN}`,
        },
      });

      if (!response.ok) return;

      const data = await response.json() as any;
      const messages = data.messages || [];

      for (const msg of messages.slice(0, 20)) {
        const text = msg.body || "";
        const tickers = extractTickers(text);
        
        for (const ticker of tickers) {
          if (DEFAULT_TICKER_BLACKLIST.has(ticker.toUpperCase())) continue;
          
          const sentiment = this.calculateSentiment(text);
          if (Math.abs(sentiment) < 0.3) continue;
          
          const volume = msg.user?.followers || 1;
          const now = Date.now();
          
          const existing = this.state.signals[ticker];
          if (existing) {
            // Update existing signal
            const combinedSentiment = (existing.sentiment * existing.volume + sentiment * volume) / (existing.volume + volume);
            const combinedSources = Array.from(new Set([...existing.sources, "stocktwits"]));
            
            this.state.signals[ticker] = {
              symbol: ticker,
              sentiment: combinedSentiment,
              sources: combinedSources,
              timestamp: now,
              volume: existing.volume + volume,
            };
          } else {
            // Create new signal
            this.state.signals[ticker] = {
              symbol: ticker,
              sentiment,
              sources: ["stocktwits"],
              timestamp: now,
              volume,
            };
          }
        }
      }
    } catch (error) {
      console.error("StockTwits gathering error:", error);
    }
  }

  private async gatherReddit(): Promise<void> {
    if (!this.env.REDDIT_CLIENT_ID || !this.env.REDDIT_CLIENT_SECRET) return;

    try {
      // Get Reddit access token
      const authResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${this.env.REDDIT_CLIENT_ID}:${this.env.REDDIT_CLIENT_SECRET}`)}`,
        },
        body: "grant_type=client_credentials",
      });

      if (!authResponse.ok) return;

      const authData = await authResponse.json() as any;
      const token = authData.access_token;

      // Fetch from WallStreetBets
      const subredditResponse = await fetch("https://oauth.reddit.com/r/wallstreetbets/hot.json?limit=20", {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "okx-trading/1.0",
        },
      });

      if (!subredditResponse.ok) return;

      const subredditData = await subredditResponse.json() as any;
      const posts = subredditData.data?.children || [];

      for (const post of posts) {
        const data = post.data;
        const title = data.title || "";
        const selftext = data.selftext || "";
        const text = `${title} ${selftext}`;
        
        const tickers = extractTickers(text);
        
        for (const ticker of tickers) {
          if (DEFAULT_TICKER_BLACKLIST.has(ticker.toUpperCase())) continue;
          
          const sentiment = this.calculateSentiment(text);
          if (Math.abs(sentiment) < 0.3) continue;
          
          const volume = data.score || 1;
          const now = Date.now();
          
          const existing = this.state.signals[ticker];
          if (existing) {
            // Update existing signal
            const combinedSentiment = (existing.sentiment * existing.volume + sentiment * volume) / (existing.volume + volume);
            const combinedSources = Array.from(new Set([...existing.sources, "reddit"]));
            
            this.state.signals[ticker] = {
              symbol: ticker,
              sentiment: combinedSentiment,
              sources: combinedSources,
              timestamp: now,
              volume: existing.volume + volume,
            };
          } else {
            // Create new signal
            this.state.signals[ticker] = {
              symbol: ticker,
              sentiment,
              sources: ["reddit"],
              timestamp: now,
              volume,
            };
          }
        }
      }
    } catch (error) {
      console.error("Reddit gathering error:", error);
    }
  }

  private calculateSentiment(text: string): number {
    const lowerText = text.toLowerCase();
    
    const bullishWords = [
      "buy", "bull", "long", "moon", "rocket", "squeeze", "breakout",
      "upgrade", "beat", "earnings", "growth", "positive", "strong"
    ];
    
    const bearishWords = [
      "sell", "bear", "short", "crash", "dump", "breakdown",
      "downgrade", "miss", "loss", "negative", "weak", "warning"
    ];
    
    let score = 0;
    for (const word of bullishWords) {
      if (lowerText.includes(word)) score += 1;
    }
    for (const word of bearishWords) {
      if (lowerText.includes(word)) score -= 1;
    }
    
    // Normalize to -1 to 1 range
    const totalWords = bullishWords.length + bearishWords.length;
    return totalWords > 0 ? Math.tanh(score / totalWords * 3) : 0;
  }

  async alarm(): Promise<void> {
    // Auto-gather data every 5 minutes
    await this.gatherStockTwits();
    await this.gatherReddit();
    
    this.state.lastGatherTime = Date.now();
    await this.ctx.storage.put("state", this.state);
    
    // Reschedule for 5 minutes from now
    await this.ctx.storage.setAlarm(Date.now() + 300000);
  }
}