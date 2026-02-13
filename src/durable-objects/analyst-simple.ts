/**
 * Analyst - Simplified Durable Object for Signal Analysis
 *
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { Env } from "../env.d";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import { createLLMProvider } from "../providers/llm/factory";

interface AnalysisCacheEntry {
  recommendations: unknown[];
  timestamp: number;
}

interface LlmHealth {
  failures: number;
  circuitOpenUntil: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastError?: string;
}

interface AnalystMetrics {
  analysisCalls: number;
  analysisCacheHits: number;
  researchCalls: number;
  researchBatchCalls: number;
  researchCacheHits: number;
}

interface AnalystState extends AgentBaseState {
  researchResults: Record<
    string,
    {
      symbol: string;
      verdict: "BUY" | "SKIP" | "WAIT";
      confidence: number;
      reasoning: string;
      timestamp: number;
    }
  >;
  analysisCache: Record<string, AnalysisCacheEntry>;
  llmHealth: LlmHealth;
  metrics: AnalystMetrics;
  lastAnalysisTime: number;
}

function createDefaultLlmHealth(): LlmHealth {
  return {
    failures: 0,
    circuitOpenUntil: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
  };
}

function createDefaultMetrics(): AnalystMetrics {
  return {
    analysisCalls: 0,
    analysisCacheHits: 0,
    researchCalls: 0,
    researchBatchCalls: 0,
    researchCacheHits: 0,
  };
}

const DEFAULT_STATE: Pick<
  AnalystState,
  "researchResults" | "analysisCache" | "llmHealth" | "metrics" | "lastAnalysisTime"
> = {
  researchResults: {},
  analysisCache: {},
  llmHealth: createDefaultLlmHealth(),
  metrics: createDefaultMetrics(),
  lastAnalysisTime: 0,
};

export class AnalystSimple extends AgentBase<AnalystState> {
  protected agentType: AgentType = "analyst";
  private readonly analysisIntervalMs = 120_000;
  private readonly researchTtlMs = 180_000;
  private readonly analysisCacheTtlMs = 90_000;
  private readonly llmTimeoutMs = 18_000;
  private readonly llmFailureThreshold = 3;
  private readonly llmMaxBackoffMs = 5 * 60 * 1000;
  private readonly maxBatchResearchSymbols = 8;
  private _llm: any = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      researchResults: this.state.researchResults ?? {},
      analysisCache: this.state.analysisCache ?? {},
      llmHealth: {
        ...createDefaultLlmHealth(),
        ...(this.state.llmHealth ?? {}),
      },
      metrics: {
        ...createDefaultMetrics(),
        ...(this.state.metrics ?? {}),
      },
      lastAnalysisTime: this.state.lastAnalysisTime ?? DEFAULT_STATE.lastAnalysisTime,
    };
  }

  protected async onStart(): Promise<void> {
    this.initializeLLM();
    await this.subscribe("signals_updated");
  }

  protected getCapabilities(): string[] {
    return [
      "analyze_signals",
      "research_signal",
      "research_signals_batch",
      "publish_analysis",
      "llm_cached_analysis",
      "llm_batched_research",
      "llm_circuit_breaker",
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
      case "analyze_signals": {
        const payload = message.payload as { signals?: unknown[] };
        const signals = Array.isArray(payload?.signals) ? payload.signals : [];
        const recommendations = await this.analyzeSignals(signals);
        return { recommendations };
      }
      case "research_signal": {
        const payload = message.payload as { symbol?: string; sentiment?: number };
        if (!payload.symbol || typeof payload.sentiment !== "number") {
          return { error: "symbol and sentiment are required" };
        }
        const research = await this.researchSignal(payload.symbol, payload.sentiment);
        return { research };
      }
      case "research_signals_batch": {
        const payload = message.payload as {
          signals?: Array<{ symbol?: string; sentiment?: number }>;
        };
        const signals = Array.isArray(payload.signals) ? payload.signals : [];
        const results = await this.researchSignalsBatch(signals);
        return { results };
      }
      case "signals_updated": {
        await this.runAnalysisFromScout();
        return { ok: true };
      }
      default:
        return { error: `Unknown topic: ${message.topic}` };
    }
  }

  private initializeLLM(): void {
    try {
      this._llm = createLLMProvider(this.env);
      if (this._llm) {
        console.log(`[Analyst] LLM Provider initialized`);
      }
    } catch (error) {
      console.error("[Analyst] Failed to initialize LLM:", error);
    }
  }

  protected async handleCustomFetch(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/analyze") {
      return this.handleAnalyze(request);
    }
    if (path === "/research") {
      return this.handleResearch(request);
    }
    if (path === "/research-batch" && request.method === "POST") {
      return this.handleResearchBatch(request);
    }
    if (path === "/analysis-cycle" && request.method === "POST") {
      await this.runAnalysisFromScout();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return super.handleCustomFetch(request, url);
  }

  private async handleAnalyze(request: Request): Promise<Response> {
    try {
      const { signals } = (await request.json()) as { signals: any[] };

      if (!signals || signals.length === 0) {
        return new Response(JSON.stringify({ recommendations: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const recommendations = await this.analyzeSignals(signals);

      this.state.lastAnalysisTime = Date.now();
      await this.ctx.storage.put("state", this.state);

      return new Response(JSON.stringify({ recommendations }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleResearch(request: Request): Promise<Response> {
    try {
      const { symbol, sentiment } = (await request.json()) as {
        symbol: string;
        sentiment: number;
      };

      const research = await this.researchSignal(symbol, sentiment);

      return new Response(JSON.stringify({ research }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleResearchBatch(request: Request): Promise<Response> {
    try {
      const payload = (await request.json()) as {
        signals?: Array<{ symbol?: string; sentiment?: number }>;
      };
      const signals = Array.isArray(payload.signals) ? payload.signals : [];
      const results = await this.researchSignalsBatch(signals);
      return new Response(JSON.stringify({ results }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async runAnalysisFromScout(): Promise<void> {
    const dataScoutId = this.env.DATA_SCOUT.idFromName("default");
    const dataScout = this.env.DATA_SCOUT.get(dataScoutId);
    const response = await dataScout.fetch("http://data-scout/signals");
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { signals?: unknown[] };
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const batchedResearch = await this.researchSignalsBatch(
      signals.map((signal) => {
        const candidate = signal as { symbol?: string; sentiment?: number };
        return {
          symbol: candidate.symbol,
          sentiment: candidate.sentiment,
        };
      })
    );
    const recommendations = await this.analyzeSignals(signals);
    this.state.lastAnalysisTime = Date.now();
    await this.saveState();

    try {
      await this.publishEvent("analysis_ready", {
        recommendations,
        batchedResearch,
        generatedAt: this.state.lastAnalysisTime,
      });
    } catch (error) {
      this.log("warn", "Unable to publish analysis_ready event", { error: String(error) });
    }
  }

  private handleHealth(): Response {
    const now = Date.now();
    const lastAnalysisAge = now - this.state.lastAnalysisTime;
    const isHealthy = lastAnalysisAge < 600000; // 10 minutes

    return new Response(
      JSON.stringify({
        healthy: isHealthy,
        lastAnalysisTime: this.state.lastAnalysisTime,
        lastAnalysisAgeMs: lastAnalysisAge,
        researchCount: Object.keys(this.state.researchResults).length,
        llmAvailable: !!this._llm,
        llmHealth: this.state.llmHealth,
        metrics: this.state.metrics,
        analysisCacheEntries: Object.keys(this.state.analysisCache).length,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  private async analyzeSignals(signals: unknown[]): Promise<any[]> {
    if (signals.length === 0) {
      return [];
    }

    const normalizedSignals = this.normalizeSignals(signals);
    const topSignals = normalizedSignals
      .filter((s) => Math.abs(s.sentiment) >= 0.3)
      .sort((a, b) => Math.abs(b.sentiment) * b.volume - Math.abs(a.sentiment) * a.volume)
      .slice(0, 5);

    if (topSignals.length === 0) {
      return [];
    }

    const cacheKey = this.buildAnalysisCacheKey(topSignals);
    const cached = this.state.analysisCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < this.analysisCacheTtlMs) {
      this.state.metrics.analysisCacheHits += 1;
      return Array.isArray(cached.recommendations) ? cached.recommendations : [];
    }

    this.state.metrics.analysisCalls += 1;
    const signalSummary = topSignals.map((s) => ({
      symbol: s.symbol,
      sentiment: (s.sentiment * 100).toFixed(0),
      sources: s.sources.join(", "),
    }));

    const prompt = `You are a trading analyst. Analyze these signals and provide recommendations.

TOP SIGNALS:
${signalSummary.map((s) => `- ${s.symbol}: ${s.sentiment}% sentiment (${s.sources})`).join("\n")}

RULES:
1. Only recommend BUY if confidence >= 0.7
2. Consider position sizing: 10% of cash per trade
3. Max 5 positions total

Output JSON array of recommendations:
[
  {
    "symbol": "AAPL",
    "action": "BUY|SKIP|WAIT",
    "confidence": 0.0-1.0,
    "reasoning": "brief reason",
    "urgency": "high|medium|low"
  }
]`;

    const recommendations = await this.runLlmWithResilience<any[]>(
      async () => {
        const response = await this._llm.complete({
          messages: [
            {
              role: "system",
              content: "You are a quantitative trading analyst. Be data-driven and risk-aware. Output valid JSON only.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 500,
          temperature: 0.2,
        });

        const parsed = this.parseJsonResponse(response.content || "{}");
        const output = Array.isArray(parsed.recommendations) ? parsed.recommendations : parsed;
        return Array.isArray(output) ? output : [];
      },
      [],
      "analyze_signals"
    );

    this.state.analysisCache[cacheKey] = {
      recommendations,
      timestamp: Date.now(),
    };
    await this.saveState();
    return recommendations;
  }

  private async researchSignal(symbol: string, sentimentScore: number): Promise<any> {
    const result = await this.researchSignalsBatch([{ symbol, sentiment: sentimentScore }]);
    return result[symbol.toUpperCase()] ?? null;
  }

  private async researchSignalsBatch(
    signals: Array<{ symbol?: string; sentiment?: number }>
  ): Promise<
    Record<
      string,
      { symbol: string; verdict: "BUY" | "SKIP" | "WAIT"; confidence: number; reasoning: string; timestamp: number }
    >
  > {
    const now = Date.now();
    const normalizedInputs = signals
      .map((signal) => ({
        symbol: typeof signal.symbol === "string" ? signal.symbol.toUpperCase() : "",
        sentiment: typeof signal.sentiment === "number" ? signal.sentiment : 0,
      }))
      .filter((signal) => signal.symbol.length > 0);

    const deduped = Array.from(new Map(normalizedInputs.map((signal) => [signal.symbol, signal])).values()).slice(
      0,
      this.maxBatchResearchSymbols * 2
    );

    const results: Record<
      string,
      { symbol: string; verdict: "BUY" | "SKIP" | "WAIT"; confidence: number; reasoning: string; timestamp: number }
    > = {};
    const uncached: Array<{ symbol: string; sentiment: number }> = [];

    for (const signal of deduped) {
      const cached = this.state.researchResults[signal.symbol];
      if (cached && now - cached.timestamp < this.researchTtlMs) {
        this.state.metrics.researchCacheHits += 1;
        results[signal.symbol] = cached;
        continue;
      }
      if (Math.abs(signal.sentiment) < 0.3) {
        continue;
      }
      uncached.push(signal);
    }

    if (uncached.length === 0) {
      return results;
    }

    const chunks: Array<Array<{ symbol: string; sentiment: number }>> = [];
    for (let i = 0; i < uncached.length; i += this.maxBatchResearchSymbols) {
      chunks.push(uncached.slice(i, i + this.maxBatchResearchSymbols));
    }

    for (const chunk of chunks) {
      this.state.metrics.researchBatchCalls += 1;
      const prompt = `Evaluate these symbols based on social sentiment.

INPUT:
${chunk.map((s) => `- ${s.symbol}: ${(s.sentiment * 100).toFixed(0)}%`).join("\n")}

Return JSON array:
[
  {
    "symbol": "AAPL",
    "verdict": "BUY|SKIP|WAIT",
    "confidence": 0.0-1.0,
    "reasoning": "brief reason"
  }
]`;

      const batchResult = await this.runLlmWithResilience<
        Array<{ symbol?: string; verdict?: "BUY" | "SKIP" | "WAIT"; confidence?: number; reasoning?: string }>
      >(
        async () => {
          const response = await this._llm.complete({
            messages: [
              {
                role: "system",
                content: "You are a stock research analyst. Output strict JSON array only.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 600,
            temperature: 0.25,
          });
          const parsed = this.parseJsonResponse(response.content || "[]");
          return Array.isArray(parsed) ? parsed : [];
        },
        [],
        "research_signals_batch"
      );

      for (const item of batchResult) {
        if (!item || typeof item.symbol !== "string") continue;
        const symbol = item.symbol.toUpperCase();
        const verdict = item.verdict ?? "WAIT";
        const confidence = typeof item.confidence === "number" ? item.confidence : 0;
        const reasoning = typeof item.reasoning === "string" ? item.reasoning : "No reasoning provided";
        const next = {
          symbol,
          verdict,
          confidence,
          reasoning,
          timestamp: Date.now(),
        };
        this.state.researchResults[symbol] = next;
        results[symbol] = next;
      }
    }

    this.state.metrics.researchCalls += uncached.length;
    await this.saveState();
    return results;
  }

  private normalizeSignals(signals: unknown[]): Array<{
    symbol: string;
    sentiment: number;
    volume: number;
    sources: string[];
  }> {
    const normalizedSignals: Array<{
      symbol: string;
      sentiment: number;
      volume: number;
      sources: string[];
    }> = [];

    for (const signal of signals) {
      const candidate = signal as {
        symbol?: string;
        sentiment?: number;
        volume?: number;
        sources?: string[];
      };
      if (typeof candidate.symbol !== "string") continue;
      if (typeof candidate.sentiment !== "number") continue;
      if (typeof candidate.volume !== "number") continue;
      normalizedSignals.push({
        symbol: candidate.symbol.toUpperCase(),
        sentiment: candidate.sentiment,
        volume: candidate.volume,
        sources: Array.isArray(candidate.sources) ? candidate.sources : [],
      });
    }

    return normalizedSignals;
  }

  private buildAnalysisCacheKey(
    signals: Array<{ symbol: string; sentiment: number; volume: number; sources: string[] }>
  ): string {
    return signals
      .map(
        (signal) =>
          `${signal.symbol}:${signal.sentiment.toFixed(3)}:${signal.volume}:${signal.sources.sort().join("|")}`
      )
      .join(";");
  }

  private parseJsonResponse(content: string): any {
    const cleaned = content.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned);
  }

  private isLlmCircuitOpen(): boolean {
    return this.state.llmHealth.circuitOpenUntil > Date.now();
  }

  private markLlmSuccess(): void {
    this.state.llmHealth = {
      failures: 0,
      circuitOpenUntil: 0,
      lastSuccessAt: Date.now(),
      lastFailureAt: this.state.llmHealth.lastFailureAt,
      lastError: undefined,
    };
  }

  private markLlmFailure(error: string): void {
    const failures = this.state.llmHealth.failures + 1;
    const shouldOpen = failures >= this.llmFailureThreshold;
    const cooldown = shouldOpen
      ? Math.min(this.llmMaxBackoffMs, 10_000 * 2 ** Math.max(0, failures - this.llmFailureThreshold))
      : 0;

    this.state.llmHealth = {
      failures,
      circuitOpenUntil: shouldOpen ? Date.now() + cooldown : 0,
      lastSuccessAt: this.state.llmHealth.lastSuccessAt,
      lastFailureAt: Date.now(),
      lastError: error,
    };
  }

  private async runLlmWithResilience<T>(operation: () => Promise<T>, fallback: T, context: string): Promise<T> {
    if (!this._llm) {
      return fallback;
    }
    if (this.isLlmCircuitOpen()) {
      this.log("warn", "LLM circuit open; using fallback", {
        context,
        openUntil: this.state.llmHealth.circuitOpenUntil,
      });
      return fallback;
    }

    try {
      const result = await this.withTimeout(operation(), this.llmTimeoutMs);
      this.markLlmSuccess();
      return result;
    } catch (error) {
      this.markLlmFailure(String(error));
      this.log("warn", "LLM call failed; fallback used", { context, error: String(error) });
      return fallback;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pruneCaches(): void {
    const now = Date.now();
    for (const cacheKey in this.state.analysisCache) {
      const entry = this.state.analysisCache[cacheKey];
      if (entry && now - entry.timestamp > this.analysisCacheTtlMs) {
        delete this.state.analysisCache[cacheKey];
      }
    }
  }

  async alarm(): Promise<void> {
    if (!this._llm) {
      this.initializeLLM();
    }

    if (Date.now() - this.state.lastAnalysisTime >= this.analysisIntervalMs) {
      await this.runAnalysisFromScout();
    }

    // Clean up old research results (older than 1 hour)
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    for (const symbol in this.state.researchResults) {
      const research = this.state.researchResults[symbol];
      if (research && research.timestamp < oneHourAgo) {
        delete this.state.researchResults[symbol];
      }
    }

    this.pruneCaches();
    await this.saveState();
    await super.alarm();
  }
}
