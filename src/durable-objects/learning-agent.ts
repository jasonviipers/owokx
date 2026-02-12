import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { Env } from "../env.d";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";

interface TradeOutcome {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  notional: number;
  success: boolean;
  confidence?: number;
  pnl?: number;
  reason?: string;
  timestamp: number;
}

interface PerformanceMetrics {
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

interface SymbolPerformance extends PerformanceMetrics {
  symbol: string;
}

interface StrategyAdjustments {
  minConfidenceBuy: number;
  maxPositionNotional: number;
  riskMultiplier: number;
  updatedAt: number;
  rationale: string;
}

interface TradeAdvice {
  approved: boolean;
  adjustedConfidence: number;
  minRequiredConfidence: number;
  reasons: string[];
}

interface LearningState extends AgentBaseState {
  outcomes: TradeOutcome[];
  performance: PerformanceMetrics;
  symbolPerformance: Record<string, SymbolPerformance>;
  strategy: StrategyAdjustments;
  lastOptimizationTime: number;
}

const DEFAULT_PERFORMANCE: PerformanceMetrics = {
  samples: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalPnl: 0,
  avgPnl: 0,
};

const DEFAULT_STRATEGY: StrategyAdjustments = {
  minConfidenceBuy: 0.7,
  maxPositionNotional: 5000,
  riskMultiplier: 1,
  updatedAt: 0,
  rationale: "Baseline strategy",
};

const OUTCOME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OUTCOMES = 1000;
const OPTIMIZATION_INTERVAL_MS = 15 * 60 * 1000;

export class LearningAgent extends AgentBase<LearningState> {
  protected agentType: AgentType = "learning";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      outcomes: this.state.outcomes ?? [],
      performance: { ...DEFAULT_PERFORMANCE, ...(this.state.performance ?? {}) },
      symbolPerformance: this.state.symbolPerformance ?? {},
      strategy: { ...DEFAULT_STRATEGY, ...(this.state.strategy ?? {}) },
      lastOptimizationTime: this.state.lastOptimizationTime ?? 0,
    };
  }

  protected async onStart(): Promise<void> {
    await this.subscribe("trade_outcome");
  }

  protected getCapabilities(): string[] {
    return [
      "trade_outcome_analysis",
      "strategy_optimization",
      "collaborative_trade_advice",
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
      case "trade_outcome":
        await this.recordTradeOutcome(message.payload as Partial<TradeOutcome>);
        return { ok: true };
      case "get_learning_summary":
        return this.buildSummary();
      case "get_strategy_adjustments":
        return this.state.strategy;
      case "get_trade_advice":
        return this.getTradeAdvice(message.payload as { symbol?: string; confidence?: number });
      case "optimize_strategy":
        return this.optimizeStrategy(String((message.payload as { reason?: string })?.reason ?? "message"));
      default:
        return { error: `Unknown topic: ${message.topic}` };
    }
  }

  protected async handleCustomFetch(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/summary" && request.method === "GET") {
      return new Response(JSON.stringify(this.buildSummary()), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/strategy" && request.method === "GET") {
      return new Response(JSON.stringify(this.state.strategy), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/advice" && request.method === "POST") {
      const payload = await request.json() as { symbol?: string; confidence?: number };
      return new Response(JSON.stringify(this.getTradeAdvice(payload)), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/record-outcome" && request.method === "POST") {
      const payload = await request.json() as Partial<TradeOutcome>;
      await this.recordTradeOutcome(payload);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/optimize" && request.method === "POST") {
      const payload = await request.json().catch(() => ({})) as { reason?: string };
      const result = await this.optimizeStrategy(payload.reason ?? "manual");
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return super.handleCustomFetch(request, url);
  }

  private handleHealth(): Response {
    return new Response(JSON.stringify({
      healthy: true,
      samples: this.state.performance.samples,
      winRate: this.state.performance.winRate,
      strategy: this.state.strategy,
      lastOptimizationTime: this.state.lastOptimizationTime,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async recordTradeOutcome(payload: Partial<TradeOutcome>): Promise<void> {
    if (!payload.symbol || (payload.side !== "buy" && payload.side !== "sell")) {
      return;
    }

    const outcome: TradeOutcome = {
      id: payload.id ?? `outcome:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
      symbol: payload.symbol.toUpperCase(),
      side: payload.side,
      notional: Number.isFinite(payload.notional) ? Number(payload.notional) : 0,
      success: Boolean(payload.success),
      confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
      pnl: typeof payload.pnl === "number" ? payload.pnl : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      timestamp: Number.isFinite(payload.timestamp) ? Number(payload.timestamp) : Date.now(),
    };

    this.state.outcomes.push(outcome);
    if (this.state.outcomes.length > MAX_OUTCOMES) {
      this.state.outcomes = this.state.outcomes.slice(-Math.floor(MAX_OUTCOMES * 0.8));
    }

    this.pruneOutcomes();
    this.recomputePerformance();
    await this.saveState();
  }

  private pruneOutcomes(): void {
    const threshold = Date.now() - OUTCOME_RETENTION_MS;
    this.state.outcomes = this.state.outcomes.filter((outcome) => outcome.timestamp >= threshold);
  }

  private recomputePerformance(): void {
    const outcomes = this.state.outcomes;
    if (outcomes.length === 0) {
      this.state.performance = { ...DEFAULT_PERFORMANCE };
      this.state.symbolPerformance = {};
      return;
    }

    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    const symbolBuckets: Record<string, TradeOutcome[]> = {};

    for (const outcome of outcomes) {
      if (outcome.success) wins += 1;
      else losses += 1;

      totalPnl += outcome.pnl ?? (outcome.success ? outcome.notional * 0.002 : -outcome.notional * 0.002);

      if (!symbolBuckets[outcome.symbol]) {
        symbolBuckets[outcome.symbol] = [];
      }
      const bucket = symbolBuckets[outcome.symbol];
      if (bucket) {
        bucket.push(outcome);
      }
    }

    const samples = outcomes.length;
    this.state.performance = {
      samples,
      wins,
      losses,
      winRate: samples > 0 ? wins / samples : 0,
      totalPnl,
      avgPnl: samples > 0 ? totalPnl / samples : 0,
    };

    const nextSymbolPerformance: Record<string, SymbolPerformance> = {};
    for (const [symbol, symbolOutcomes] of Object.entries(symbolBuckets)) {
      let symbolWins = 0;
      let symbolLosses = 0;
      let symbolPnl = 0;
      for (const outcome of symbolOutcomes) {
        if (outcome.success) symbolWins += 1;
        else symbolLosses += 1;
        symbolPnl += outcome.pnl ?? (outcome.success ? outcome.notional * 0.002 : -outcome.notional * 0.002);
      }
      const symbolSamples = symbolOutcomes.length;
      nextSymbolPerformance[symbol] = {
        symbol,
        samples: symbolSamples,
        wins: symbolWins,
        losses: symbolLosses,
        winRate: symbolSamples > 0 ? symbolWins / symbolSamples : 0,
        totalPnl: symbolPnl,
        avgPnl: symbolSamples > 0 ? symbolPnl / symbolSamples : 0,
      };
    }

    this.state.symbolPerformance = nextSymbolPerformance;
  }

  private buildSummary(): {
    performance: PerformanceMetrics;
    strategy: StrategyAdjustments;
    symbols: SymbolPerformance[];
  } {
    return {
      performance: this.state.performance,
      strategy: this.state.strategy,
      symbols: Object.values(this.state.symbolPerformance)
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 20),
    };
  }

  private getTradeAdvice(payload: { symbol?: string; confidence?: number }): TradeAdvice {
    const inputConfidence = Number(payload.confidence ?? 0);
    const symbol = payload.symbol?.toUpperCase();
    const symbolStats = symbol ? this.state.symbolPerformance[symbol] : undefined;
    const reasons: string[] = [];

    let adjustedConfidence = inputConfidence;
    if (symbolStats && symbolStats.samples >= 3) {
      if (symbolStats.winRate < 0.35) {
        adjustedConfidence = Math.max(0, adjustedConfidence - 0.1);
        reasons.push(`Symbol ${symbol} has weak win rate (${(symbolStats.winRate * 100).toFixed(0)}%)`);
      } else if (symbolStats.winRate > 0.65) {
        adjustedConfidence = Math.min(1, adjustedConfidence + 0.05);
        reasons.push(`Symbol ${symbol} has strong win rate (${(symbolStats.winRate * 100).toFixed(0)}%)`);
      }
    }

    if (this.state.performance.samples >= 10 && this.state.performance.winRate < 0.45) {
      adjustedConfidence = Math.max(0, adjustedConfidence - 0.05);
      reasons.push("Global win rate is currently weak");
    }

    const minRequiredConfidence = this.state.strategy.minConfidenceBuy;
    const approved = adjustedConfidence >= minRequiredConfidence;
    if (!approved) {
      reasons.push(
        `Adjusted confidence ${(adjustedConfidence * 100).toFixed(0)}% is below threshold ${(minRequiredConfidence * 100).toFixed(0)}%`
      );
    } else if (reasons.length === 0) {
      reasons.push("Confidence and strategy threshold are aligned");
    }

    return {
      approved,
      adjustedConfidence,
      minRequiredConfidence,
      reasons,
    };
  }

  private async optimizeStrategy(reason: string): Promise<{
    updated: boolean;
    strategy: StrategyAdjustments;
    performance: PerformanceMetrics;
  }> {
    const perf = this.state.performance;
    let minConfidenceBuy = this.state.strategy.minConfidenceBuy;
    let maxPositionNotional = this.state.strategy.maxPositionNotional;
    let riskMultiplier = this.state.strategy.riskMultiplier;
    let updated = false;

    if (perf.samples >= 10) {
      if (perf.winRate < 0.45 || perf.avgPnl < 0) {
        minConfidenceBuy = Math.min(0.9, minConfidenceBuy + 0.05);
        maxPositionNotional = Math.max(500, Math.round(maxPositionNotional * 0.9));
        riskMultiplier = Math.max(0.5, Number((riskMultiplier * 0.95).toFixed(2)));
        updated = true;
      } else if (perf.winRate > 0.6 && perf.avgPnl > 0) {
        minConfidenceBuy = Math.max(0.6, minConfidenceBuy - 0.03);
        maxPositionNotional = Math.min(5000, Math.round(maxPositionNotional * 1.05));
        riskMultiplier = Math.min(1.5, Number((riskMultiplier * 1.03).toFixed(2)));
        updated = true;
      }
    }

    if (updated) {
      this.state.strategy = {
        minConfidenceBuy,
        maxPositionNotional,
        riskMultiplier,
        updatedAt: Date.now(),
        rationale: `Optimized from ${reason}. winRate=${(perf.winRate * 100).toFixed(1)}%, avgPnl=${perf.avgPnl.toFixed(2)}`,
      };
      this.state.lastOptimizationTime = Date.now();
      await this.saveState();

      try {
        await this.publishEvent("strategy_updated", {
          strategy: this.state.strategy,
          performance: this.state.performance,
        });
      } catch (error) {
        this.log("warn", "Unable to publish strategy_updated", { error: String(error) });
      }
    }

    return {
      updated,
      strategy: this.state.strategy,
      performance: this.state.performance,
    };
  }

  async alarm(): Promise<void> {
    this.pruneOutcomes();
    this.recomputePerformance();

    if (Date.now() - this.state.lastOptimizationTime >= OPTIMIZATION_INTERVAL_MS) {
      await this.optimizeStrategy("scheduled");
    }

    await this.saveState();
    await super.alarm();
  }
}
