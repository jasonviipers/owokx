/**
 * Analyst - Simplified Durable Object for Signal Analysis
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { Env } from "../env.d";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import { createLLMProvider } from "../providers/llm/factory";

interface AnalystState extends AgentBaseState {
  researchResults: Record<string, {
    symbol: string;
    verdict: "BUY" | "SKIP" | "WAIT";
    confidence: number;
    reasoning: string;
    timestamp: number;
  }>;
  lastAnalysisTime: number;
}

const DEFAULT_STATE: Pick<AnalystState, "researchResults" | "lastAnalysisTime"> = {
  researchResults: {},
  lastAnalysisTime: 0,
};

export class AnalystSimple extends AgentBase<AnalystState> {
  protected agentType: AgentType = "analyst";
  private readonly analysisIntervalMs = 120_000;
  private readonly researchTtlMs = 180_000;
  private _llm: any = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      researchResults: this.state.researchResults ?? DEFAULT_STATE.researchResults,
      lastAnalysisTime: this.state.lastAnalysisTime ?? DEFAULT_STATE.lastAnalysisTime,
    };
  }

  protected async onStart(): Promise<void> {
    this.initializeLLM();
    await this.subscribe("signals_updated");
  }

  protected getCapabilities(): string[] {
    return ["analyze_signals", "research_signal", "publish_analysis"];
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
      const { signals } = await request.json() as { signals: any[] };
      
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
      const { symbol, sentiment } = await request.json() as {
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

  private async runAnalysisFromScout(): Promise<void> {
    const dataScoutId = this.env.DATA_SCOUT.idFromName("default");
    const dataScout = this.env.DATA_SCOUT.get(dataScoutId);
    const response = await dataScout.fetch("http://data-scout/signals");
    if (!response.ok) {
      return;
    }

    const payload = await response.json() as { signals?: unknown[] };
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    const recommendations = await this.analyzeSignals(signals);
    this.state.lastAnalysisTime = Date.now();
    await this.saveState();

    try {
      await this.publishEvent("analysis_ready", {
        recommendations,
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

    return new Response(JSON.stringify({
      healthy: isHealthy,
      lastAnalysisTime: this.state.lastAnalysisTime,
      lastAnalysisAgeMs: lastAnalysisAge,
      researchCount: Object.keys(this.state.researchResults).length,
      llmAvailable: !!this._llm,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async analyzeSignals(signals: unknown[]): Promise<any[]> {
    if (!this._llm || signals.length === 0) {
      return [];
    }

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
        symbol: candidate.symbol,
        sentiment: candidate.sentiment,
        volume: candidate.volume,
        sources: Array.isArray(candidate.sources) ? candidate.sources : [],
      });
    }

    // Filter to top 5 signals by sentiment * volume
    const topSignals = normalizedSignals
      .filter(s => Math.abs(s.sentiment) >= 0.3)
      .sort((a, b) => Math.abs(b.sentiment) * b.volume - Math.abs(a.sentiment) * a.volume)
      .slice(0, 5);

    if (topSignals.length === 0) {
      return [];
    }

    const signalSummary = topSignals.map(s => ({
      symbol: s.symbol,
      sentiment: (s.sentiment * 100).toFixed(0),
      sources: s.sources.join(", "),
    }));

    const prompt = `You are a trading analyst. Analyze these signals and provide recommendations.

TOP SIGNALS:
${signalSummary.map(s => `- ${s.symbol}: ${s.sentiment}% sentiment (${s.sources})`).join("\n")}

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

    try {
      const response = await this._llm.complete({
        model: "gpt-4o-mini",
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

      const content = response.content || "{}";
      const data = JSON.parse(content.replace(/```json\n?|```/g, "").trim());
      const recommendations = Array.isArray(data.recommendations) ? data.recommendations : data;

      return recommendations;
    } catch (error) {
      this.log("warn", "LLM analysis error", { error: String(error) });
      return [];
    }
  }

  private async researchSignal(symbol: string, sentimentScore: number): Promise<any> {
    const cached = this.state.researchResults[symbol];
    if (cached && Date.now() - cached.timestamp < this.researchTtlMs) {
      return cached;
    }

    if (!this._llm || Math.abs(sentimentScore) < 0.3) {
      return null;
    }

    const prompt = `Should we BUY this stock based on social sentiment?

SYMBOL: ${symbol}
SENTIMENT: ${(sentimentScore * 100).toFixed(0)}% bullish

Evaluate if this is a good entry. Consider: Is the sentiment justified? Is it too late (already pumped)? Any red flags?

JSON response:
{
  "verdict": "BUY|SKIP|WAIT",
  "confidence": 0.0-1.0,
  "reasoning": "brief reason",
  "red_flags": ["any concerns"],
  "catalysts": ["positive factors"]
}`;

    try {
      const response = await this._llm.complete({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a stock research analyst. Be skeptical of hype. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 250,
        temperature: 0.3,
      });

      const content = response.content || "{}";
      const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
        verdict: "BUY" | "SKIP" | "WAIT";
        confidence: number;
        reasoning: string;
        red_flags: string[];
        catalysts: string[];
      };

      const result = {
        symbol,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        timestamp: Date.now(),
      };

      this.state.researchResults[symbol] = result;
      await this.ctx.storage.put("state", this.state);
      
      return result;
    } catch (error) {
      this.log("warn", "Signal research error", { error: String(error), symbol });
      return null;
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

    await this.saveState();
    await super.alarm();
  }
}
