/**
 * Analyst - Simplified Durable Object for Signal Analysis
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { createLLMProvider } from "../providers/llm/factory";

interface AnalystState {
  researchResults: Record<string, {
    symbol: string;
    verdict: "BUY" | "SKIP" | "WAIT";
    confidence: number;
    reasoning: string;
    timestamp: number;
  }>;
  lastAnalysisTime: number;
}

const DEFAULT_STATE: AnalystState = {
  researchResults: {},
  lastAnalysisTime: 0,
};

export class AnalystSimple extends DurableObject<Env> {
  private state: AnalystState = { ...DEFAULT_STATE };
  private _llm: any = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<AnalystState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
      }
      this.initializeLLM();
    });
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/analyze") {
      return this.handleAnalyze(request);
    } else if (path === "/research") {
      return this.handleResearch(request);
    } else if (path === "/health") {
      return this.handleHealth();
    }

    return new Response("Not found", { status: 404 });
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

  private async handleHealth(): Promise<Response> {
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

  private async analyzeSignals(signals: any[]): Promise<any[]> {
    if (!this._llm || signals.length === 0) {
      return [];
    }

    // Filter to top 5 signals by sentiment * volume
    const topSignals = signals
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
      console.error("LLM analysis error:", error);
      return [];
    }
  }

  private async researchSignal(symbol: string, sentimentScore: number): Promise<any> {
    const cached = this.state.researchResults[symbol];
    const CACHE_TTL_MS = 180000; // 3 minutes
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
      console.error("Signal research error:", error);
      return null;
    }
  }

  async alarm(): Promise<void> {
    // Clean up old research results (older than 1 hour)
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    
    for (const symbol in this.state.researchResults) {
      const research = this.state.researchResults[symbol];
      if (research && research.timestamp < oneHourAgo) {
        delete this.state.researchResults[symbol];
      }
    }
    
    await this.ctx.storage.put("state", this.state);
    
    // Reschedule for 1 hour from now
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
}