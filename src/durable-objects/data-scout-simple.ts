/**
 * DataScout - Simplified Durable Object for Data Gathering
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { Env } from "../env.d";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import { extractTickers, DEFAULT_TICKER_BLACKLIST } from "../lib/ticker";

interface DataScoutState extends AgentBaseState {
  signals: Record<string, {
    symbol: string;
    sentiment: number;
    sources: string[];
    timestamp: number;
    volume: number;
  }>;
  lastGatherTime: number;
}

const DEFAULT_STATE: Pick<DataScoutState, "signals" | "lastGatherTime"> = {
  signals: {},
  lastGatherTime: 0,
};

export class DataScoutSimple extends AgentBase<DataScoutState> {
  protected agentType: AgentType = "scout";
  private readonly gatherIntervalMs = 300_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      signals: this.state.signals ?? DEFAULT_STATE.signals,
      lastGatherTime: this.state.lastGatherTime ?? DEFAULT_STATE.lastGatherTime,
    };
  }

  protected getCapabilities(): string[] {
    return ["gather_signals", "get_signals", "publish_signals"];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return this.handleHealth();
    }
    return super.fetch(request);
  }

  protected async handleMessage(message: AgentMessage): Promise<unknown> {
    switch (message.topic) {
      case "gather_signals":
        await this.runGatherCycle();
        return { success: true, signalCount: Object.keys(this.state.signals).length };
      case "get_signals":
        return { signals: Object.values(this.state.signals) };
      default:
        return { error: `Unknown topic: ${message.topic}` };
    }
  }

  protected async handleCustomFetch(_request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/gather") {
      return this.handleGather();
    }
    if (path === "/signals") {
      return this.handleGetSignals();
    }
    return super.handleCustomFetch(_request, url);
  }

  private async handleGather(): Promise<Response> {
    try {
      await this.runGatherCycle();
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

    await this.saveState();
    
    return new Response(JSON.stringify({ 
      signals: Object.values(this.state.signals) 
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async runGatherCycle(): Promise<void> {
    await this.gatherStockTwits();
    await this.gatherReddit();

    this.state.lastGatherTime = Date.now();
    await this.saveState();

    try {
      await this.publishEvent("signals_updated", {
        count: Object.keys(this.state.signals).length,
        timestamp: this.state.lastGatherTime,
      });
    } catch (error) {
      this.log("warn", "Unable to publish signals_updated event", { error: String(error) });
    }
  }

  private handleHealth(): Response {
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
      this.log("warn", "StockTwits gathering error", { error: String(error) });
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
      this.log("warn", "Reddit gathering error", { error: String(error) });
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
    if (Date.now() - this.state.lastGatherTime >= this.gatherIntervalMs) {
      await this.runGatherCycle();
    }
    await super.alarm();
  }
}
