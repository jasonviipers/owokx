/**
 * DataScout - Simplified Durable Object for Data Gathering
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { Env } from "../env.d";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import { extractTickers, DEFAULT_TICKER_BLACKLIST } from "../lib/ticker";

type SourceName = "stocktwits" | "reddit";

interface SourceHealth {
  failures: number;
  circuitOpenUntil: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastError?: string;
}

interface PipelineMetrics {
  cycles: number;
  avgCycleMs: number;
  lastCycleMs: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  consecutiveFailures: number;
}

interface DataScoutState extends AgentBaseState {
  signals: Record<string, {
    symbol: string;
    sentiment: number;
    sources: string[];
    timestamp: number;
    volume: number;
  }>;
  lastGatherTime: number;
  sourceHealth: Record<SourceName, SourceHealth>;
  pipelineMetrics: PipelineMetrics;
}

function createDefaultSourceHealth(): Record<SourceName, SourceHealth> {
  return {
    stocktwits: {
      failures: 0,
      circuitOpenUntil: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
    },
    reddit: {
      failures: 0,
      circuitOpenUntil: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
    },
  };
}

function createDefaultPipelineMetrics(): PipelineMetrics {
  return {
    cycles: 0,
    avgCycleMs: 0,
    lastCycleMs: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    consecutiveFailures: 0,
  };
}

const DEFAULT_STATE: Pick<DataScoutState, "signals" | "lastGatherTime" | "sourceHealth" | "pipelineMetrics"> = {
  signals: {},
  lastGatherTime: 0,
  sourceHealth: createDefaultSourceHealth(),
  pipelineMetrics: createDefaultPipelineMetrics(),
};

export class DataScoutSimple extends AgentBase<DataScoutState> {
  protected agentType: AgentType = "scout";
  private readonly gatherIntervalMs = 300_000;
  private readonly sourceTimeoutMs = 12_000;
  private readonly staleSignalTtlMs = 3 * 60 * 60 * 1000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      signals: this.state.signals ?? {},
      lastGatherTime: this.state.lastGatherTime ?? DEFAULT_STATE.lastGatherTime,
      sourceHealth: {
        ...createDefaultSourceHealth(),
        ...(this.state.sourceHealth ?? {}),
      },
      pipelineMetrics: {
        ...createDefaultPipelineMetrics(),
        ...(this.state.pipelineMetrics ?? {}),
      },
    };
  }

  protected getCapabilities(): string[] {
    return [
      "gather_signals",
      "get_signals",
      "publish_signals",
      "pipeline_optimized",
      "source_circuit_breaker",
    ];
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
      case "get_pipeline_metrics":
        return {
          pipelineMetrics: this.state.pipelineMetrics,
          sourceHealth: this.state.sourceHealth,
        };
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
    this.cleanupStaleSignals();
    await this.saveState();
    
    return new Response(JSON.stringify({ 
      signals: Object.values(this.state.signals) 
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async runGatherCycle(): Promise<void> {
    const startedAt = Date.now();

    const [stocktwitsResult, redditResult] = await Promise.all([
      this.runSourceWithCircuitBreaker("stocktwits", () => this.gatherStockTwits()),
      this.runSourceWithCircuitBreaker("reddit", () => this.gatherReddit()),
    ]);

    this.cleanupStaleSignals();

    const cycleMs = Date.now() - startedAt;
    const hadAnySuccess = stocktwitsResult.success || redditResult.success;
    this.updatePipelineMetrics(cycleMs, hadAnySuccess);
    if (hadAnySuccess) {
      this.state.lastGatherTime = Date.now();
    }
    await this.saveState();

    try {
      await this.publishEvent("signals_updated", {
        count: Object.keys(this.state.signals).length,
        timestamp: this.state.lastGatherTime,
        processingMs: cycleMs,
        sourceStats: {
          stocktwits: stocktwitsResult,
          reddit: redditResult,
        },
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
      pipelineMetrics: this.state.pipelineMetrics,
      sourceHealth: this.state.sourceHealth,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async gatherStockTwits(): Promise<number> {
    if (!this.env.STOCKTWITS_API_TOKEN) return 0;

    const response = await this.fetchWithTimeout(
      "https://api.stocktwits.com/api/2/streams/trending.json",
      {
        headers: {
          Authorization: `Bearer ${this.env.STOCKTWITS_API_TOKEN}`,
        },
      },
      this.sourceTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`StockTwits request failed (${response.status})`);
    }

    const data = await response.json() as { messages?: Array<{ body?: string; user?: { followers?: number } }> };
    const messages = data.messages ?? [];
    let processed = 0;

    for (const msg of messages.slice(0, 20)) {
      const text = msg.body || "";
      const tickers = extractTickers(text);
      const sentiment = this.calculateSentiment(text);
      if (Math.abs(sentiment) < 0.3) continue;

      for (const ticker of tickers) {
        if (DEFAULT_TICKER_BLACKLIST.has(ticker.toUpperCase())) continue;
        const volume = msg.user?.followers || 1;
        this.upsertSignal(ticker, sentiment, "stocktwits", volume);
        processed += 1;
      }
    }

    return processed;
  }

  private async gatherReddit(): Promise<number> {
    if (!this.env.REDDIT_CLIENT_ID || !this.env.REDDIT_CLIENT_SECRET) return 0;

    const authResponse = await this.fetchWithTimeout(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${this.env.REDDIT_CLIENT_ID}:${this.env.REDDIT_CLIENT_SECRET}`)}`,
        },
        body: "grant_type=client_credentials",
      },
      this.sourceTimeoutMs
    );

    if (!authResponse.ok) {
      throw new Error(`Reddit auth failed (${authResponse.status})`);
    }

    const authData = await authResponse.json() as { access_token?: string };
    const token = authData.access_token;
    if (!token) {
      throw new Error("Reddit auth token missing");
    }

    const subredditResponse = await this.fetchWithTimeout(
      "https://oauth.reddit.com/r/wallstreetbets/hot.json?limit=20",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "okx-trading/1.0",
        },
      },
      this.sourceTimeoutMs
    );

    if (!subredditResponse.ok) {
      throw new Error(`Reddit subreddit fetch failed (${subredditResponse.status})`);
    }

    const subredditData = await subredditResponse.json() as {
      data?: {
        children?: Array<{
          data?: {
            title?: string;
            selftext?: string;
            score?: number;
          };
        }>;
      };
    };
    const posts = subredditData.data?.children ?? [];
    let processed = 0;

    for (const post of posts) {
      const data = post.data;
      const title = data?.title || "";
      const selftext = data?.selftext || "";
      const text = `${title} ${selftext}`;
      const tickers = extractTickers(text);
      const sentiment = this.calculateSentiment(text);
      if (Math.abs(sentiment) < 0.3) continue;

      for (const ticker of tickers) {
        if (DEFAULT_TICKER_BLACKLIST.has(ticker.toUpperCase())) continue;
        const volume = data?.score || 1;
        this.upsertSignal(ticker, sentiment, "reddit", volume);
        processed += 1;
      }
    }

    return processed;
  }

  private async runSourceWithCircuitBreaker(
    source: SourceName,
    runner: () => Promise<number>
  ): Promise<{ source: SourceName; success: boolean; processed: number; skipped: boolean; error?: string }> {
    const health = this.state.sourceHealth[source];
    const now = Date.now();
    if (health.circuitOpenUntil > now) {
      return {
        source,
        success: false,
        processed: 0,
        skipped: true,
        error: `circuit_open_until_${health.circuitOpenUntil}`,
      };
    }

    try {
      const processed = await runner();
      this.state.sourceHealth[source] = {
        ...health,
        failures: 0,
        circuitOpenUntil: 0,
        lastSuccessAt: Date.now(),
        lastError: undefined,
      };
      return {
        source,
        success: true,
        processed: Number.isFinite(processed) ? processed : 0,
        skipped: false,
      };
    } catch (error) {
      const failures = health.failures + 1;
      const cooloffMs = Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.max(0, failures - 1));
      this.state.sourceHealth[source] = {
        ...health,
        failures,
        circuitOpenUntil: Date.now() + cooloffMs,
        lastFailureAt: Date.now(),
        lastError: String(error),
      };
      this.log("warn", `${source} source failed`, {
        error: String(error),
        failures,
        circuitOpenUntil: this.state.sourceHealth[source].circuitOpenUntil,
      });
      return {
        source,
        success: false,
        processed: 0,
        skipped: false,
        error: String(error),
      };
    }
  }

  private upsertSignal(ticker: string, sentiment: number, source: SourceName, volume: number): void {
    const normalized = ticker.toUpperCase();
    const now = Date.now();
    const existing = this.state.signals[normalized];
    if (existing) {
      const combinedSentiment = (existing.sentiment * existing.volume + sentiment * volume) / (existing.volume + volume);
      const combinedSources = Array.from(new Set([...existing.sources, source]));
      this.state.signals[normalized] = {
        symbol: normalized,
        sentiment: combinedSentiment,
        sources: combinedSources,
        timestamp: now,
        volume: existing.volume + volume,
      };
      return;
    }

    this.state.signals[normalized] = {
      symbol: normalized,
      sentiment,
      sources: [source],
      timestamp: now,
      volume,
    };
  }

  private cleanupStaleSignals(): void {
    const now = Date.now();
    const threshold = now - this.staleSignalTtlMs;
    for (const symbol in this.state.signals) {
      const signal = this.state.signals[symbol];
      if (signal && signal.timestamp < threshold) {
        delete this.state.signals[symbol];
      }
    }
  }

  private updatePipelineMetrics(cycleMs: number, success: boolean): void {
    const previous = this.state.pipelineMetrics;
    const cycles = previous.cycles + 1;
    const avgCycleMs = previous.avgCycleMs <= 0
      ? cycleMs
      : Math.round((previous.avgCycleMs * previous.cycles + cycleMs) / cycles);

    this.state.pipelineMetrics = {
      cycles,
      avgCycleMs,
      lastCycleMs: cycleMs,
      lastSuccessAt: success ? Date.now() : previous.lastSuccessAt,
      lastFailureAt: success ? previous.lastFailureAt : Date.now(),
      consecutiveFailures: success ? 0 : previous.consecutiveFailures + 1,
    };
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([fetch(input, init), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
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
