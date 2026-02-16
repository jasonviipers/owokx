/**
 * Trader - Simplified Durable Object for Order Execution
 *
 * Follows the same pattern as OwokxHarness for consistency.
 */

import type { Env } from "../env.d";
import { executeOrder, isAcceptedSubmissionState } from "../execution/execute-order";
import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import { getDefaultPolicyConfig, type PolicyConfig } from "../policy/config";
import { createBrokerProviders } from "../providers/broker-factory";
import type { Account, MarketClock, Position } from "../providers/types";
import { createD1Client } from "../storage/d1/client";
import { type CreateDecisionTraceParams, createDecisionTrace } from "../storage/d1/queries/decisions";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { getRiskState, type RiskState } from "../storage/d1/queries/risk-state";

interface TraderState extends AgentBaseState {
  tradeHistory: Array<{
    symbol: string;
    side: "buy" | "sell";
    size: number;
    timestamp: number;
    success: boolean;
    error?: string;
  }>;
  lastTradeTime: number;
  strategyProfile: {
    minConfidenceBuy: number;
    maxPositionNotional: number;
    riskMultiplier: number;
    updatedAt: number;
    source: "default" | "learning";
  };
}

const DEFAULT_STATE: Pick<TraderState, "tradeHistory" | "lastTradeTime" | "strategyProfile"> = {
  tradeHistory: [],
  lastTradeTime: 0,
  strategyProfile: {
    minConfidenceBuy: 0.7,
    maxPositionNotional: 5000,
    riskMultiplier: 1,
    updatedAt: 0,
    source: "default",
  },
};

interface RiskValidationResult {
  approved: boolean;
  reason?: string;
}

interface RiskValidationContext {
  account?: Account;
  positions?: Position[];
  clock?: MarketClock;
  riskState?: RiskState;
  policyConfig?: PolicyConfig;
}

function isMissingDecisionTraceSchemaError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("no such table") && message.includes("decision_traces");
}

export class TraderSimple extends AgentBase<TraderState> {
  protected agentType: AgentType = "trader";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      ...this.state,
      tradeHistory: this.state.tradeHistory ?? DEFAULT_STATE.tradeHistory,
      lastTradeTime: this.state.lastTradeTime ?? DEFAULT_STATE.lastTradeTime,
      strategyProfile: this.state.strategyProfile ?? DEFAULT_STATE.strategyProfile,
    };
  }

  protected async onStart(): Promise<void> {
    await this.subscribe("analysis_ready");
    await this.subscribe("strategy_updated");
    await this.refreshStrategyProfileFromLearningAgent();
  }

  protected getCapabilities(): string[] {
    return [
      "execute_buy",
      "execute_sell",
      "execute_recommendations",
      "trade_history",
      "collaborative_decision",
      "adaptive_strategy",
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
      case "execute_buy": {
        const payload = message.payload as { symbol?: string; confidence?: number; account?: { cash?: number } };
        if (!payload.symbol || typeof payload.confidence !== "number") {
          return { success: false, error: "symbol and confidence are required" };
        }
        const account = { cash: payload.account?.cash ?? 0 };
        const success = await this.executeBuy(payload.symbol, payload.confidence, account);
        return { success };
      }
      case "execute_sell": {
        const payload = message.payload as { symbol?: string; reason?: string };
        if (!payload.symbol || !payload.reason) {
          return { success: false, error: "symbol and reason are required" };
        }
        const success = await this.executeSell(payload.symbol, payload.reason);
        return { success };
      }
      case "analysis_ready":
        await this.executeRecommendations(message.payload);
        return { ok: true };
      case "strategy_updated":
        await this.applyStrategyUpdate(message.payload);
        return { ok: true };
      case "get_trade_history":
        return { trades: this.state.tradeHistory.slice(-50) };
      case "get_strategy_profile":
        return this.state.strategyProfile;
      default:
        return { error: `Unknown topic: ${message.topic}` };
    }
  }

  protected async handleCustomFetch(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/buy") {
      return this.handleBuy(request);
    }
    if (path === "/sell") {
      return this.handleSell(request);
    }
    if (path === "/history") {
      return this.handleGetHistory();
    }
    return super.handleCustomFetch(request, url);
  }

  private async handleBuy(request: Request): Promise<Response> {
    try {
      const { symbol, confidence, account } = (await request.json()) as {
        symbol: string;
        confidence: number;
        account: { cash: number };
      };

      const result = await this.executeBuy(symbol, confidence, account);
      return new Response(JSON.stringify({ success: result }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleSell(request: Request): Promise<Response> {
    try {
      const { symbol, reason } = (await request.json()) as {
        symbol: string;
        reason: string;
      };

      const result = await this.executeSell(symbol, reason);
      return new Response(JSON.stringify({ success: result }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleGetHistory(): Promise<Response> {
    // Return last 50 trades
    const recentHistory = this.state.tradeHistory.slice(-50);
    return new Response(JSON.stringify({ trades: recentHistory }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async executeRecommendations(payload: unknown): Promise<void> {
    const data = payload as {
      recommendations?: Array<{
        symbol?: string;
        action?: string;
        confidence?: number;
      }>;
    };
    const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
    if (recommendations.length === 0) {
      return;
    }

    await this.refreshStrategyProfileFromLearningAgent();

    let accountCash = 0;
    try {
      const broker = createBrokerProviders(this.env);
      const account = await broker.trading.getAccount();
      accountCash = account.cash;
    } catch {
      return;
    }

    for (const recommendation of recommendations) {
      if (recommendation.action !== "BUY") continue;
      if (!recommendation.symbol) continue;
      const confidence = recommendation.confidence ?? 0;

      const advice = await this.getLearningAdvice(recommendation.symbol, confidence);
      if (!advice.approved) {
        await this.publishTradeOutcome({
          symbol: recommendation.symbol,
          side: "buy",
          notional: 0,
          success: false,
          confidence,
          reason: `Collaborative decision rejected: ${advice.reasons.join("; ")}`,
        });
        continue;
      }

      if (advice.adjustedConfidence < this.state.strategyProfile.minConfidenceBuy) {
        continue;
      }

      await this.executeBuy(recommendation.symbol, advice.adjustedConfidence, { cash: accountCash });
    }
  }

  private handleHealth(): Response {
    const now = Date.now();
    const lastTradeAge = now - this.state.lastTradeTime;
    const isHealthy = lastTradeAge < 3600000; // 1 hour

    return new Response(
      JSON.stringify({
        healthy: isHealthy,
        lastTradeTime: this.state.lastTradeTime,
        lastTradeAgeMs: lastTradeAge,
        tradeCount: this.state.tradeHistory.length,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  private async executeBuy(symbol: string, confidence: number, account: { cash: number }): Promise<boolean> {
    // Input validation
    if (!symbol || symbol.trim().length === 0) {
      this.recordTrade(symbol, "buy", 0, false, "Empty symbol");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol || "UNKNOWN"),
        request_id: this.buildIdempotencyKey("buy", symbol || "UNKNOWN"),
        stage: "buy_intent",
        decision_kind: "execution",
        input: { symbol, confidence, cash: account.cash },
        final_action: "rejected_empty_symbol",
        status: "blocked",
        error_message: "Empty symbol",
        symbol: symbol || null,
      });
      return false;
    }

    if (account.cash <= 0) {
      this.recordTrade(symbol, "buy", 0, false, "No cash available");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol),
        request_id: this.buildIdempotencyKey("buy", symbol),
        stage: "buy_intent",
        decision_kind: "execution",
        input: { symbol, confidence, cash: account.cash },
        final_action: "rejected_no_cash",
        status: "blocked",
        error_message: "No cash available",
        symbol,
      });
      return false;
    }

    if (confidence <= 0 || confidence > 1 || !Number.isFinite(confidence)) {
      this.recordTrade(symbol, "buy", 0, false, "Invalid confidence");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol),
        request_id: this.buildIdempotencyKey("buy", symbol),
        stage: "buy_intent",
        decision_kind: "execution",
        input: { symbol, confidence, cash: account.cash },
        final_action: "rejected_invalid_confidence",
        status: "blocked",
        error_message: "Invalid confidence",
        symbol,
      });
      return false;
    }

    // Position sizing
    const positionSize = this.estimatePositionSize(account.cash, confidence);

    if (positionSize < 100) {
      this.recordTrade(symbol, "buy", positionSize, false, "Position too small");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol),
        request_id: this.buildIdempotencyKey("buy", symbol),
        stage: "buy_sizing",
        decision_kind: "execution",
        input: { symbol, confidence, cash: account.cash, position_size: positionSize },
        final_action: "rejected_position_too_small",
        status: "blocked",
        error_message: "Position too small",
        symbol,
      });
      await this.publishTradeOutcome({
        symbol,
        side: "buy",
        notional: positionSize,
        success: false,
        confidence,
        reason: "Position too small",
      });
      return false;
    }

    if (positionSize <= 0 || positionSize > 5000 * 1.01 || !Number.isFinite(positionSize)) {
      this.recordTrade(symbol, "buy", positionSize, false, "Invalid position size");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol),
        request_id: this.buildIdempotencyKey("buy", symbol),
        stage: "buy_sizing",
        decision_kind: "execution",
        input: { symbol, confidence, cash: account.cash, position_size: positionSize },
        final_action: "rejected_invalid_position_size",
        status: "blocked",
        error_message: "Invalid position size",
        symbol,
      });
      await this.publishTradeOutcome({
        symbol,
        side: "buy",
        notional: positionSize,
        success: false,
        confidence,
        reason: "Invalid position size",
      });
      return false;
    }

    try {
      const broker = createBrokerProviders(this.env, "alpaca");
      const db = createD1Client(this.env.DB);
      const [accountSnapshot, positions, clock, riskState, policyConfig] = await Promise.all([
        broker.trading.getAccount(),
        broker.trading.getPositions(),
        broker.trading.getClock(),
        getRiskState(db),
        this.loadPolicyConfig(db),
      ]);
      const idempotency_key = this.buildIdempotencyKey("buy", symbol);

      const riskValidation = await this.validateOrderWithRiskManager(
        {
          symbol,
          notional: positionSize,
          side: "buy",
        },
        {
          account: accountSnapshot,
          positions,
          clock,
          riskState,
          policyConfig,
        }
      );

      if (!riskValidation.approved) {
        this.recordTrade(symbol, "buy", positionSize, false, riskValidation.reason ?? "Risk check rejected order");
        await this.recordDecisionTrace({
          trace_id: idempotency_key,
          request_id: idempotency_key,
          stage: "risk_validation",
          decision_kind: "policy",
          input: {
            symbol,
            side: "buy",
            notional: positionSize,
          },
          policy: {
            approved: riskValidation.approved,
            reason: riskValidation.reason ?? "Risk check rejected order",
            policy_config: policyConfig,
            risk_state: riskState,
          },
          final_action: "rejected_risk_validation",
          status: "blocked",
          error_message: riskValidation.reason ?? "Risk check rejected order",
          symbol,
          metadata: {
            idempotency_key,
            source: "harness",
          },
        });
        await this.publishTradeOutcome({
          symbol,
          side: "buy",
          notional: positionSize,
          success: false,
          confidence,
          reason: riskValidation.reason ?? "Risk check rejected order",
        });
        return false;
      }

      const execution = await executeOrder({
        env: this.env,
        db,
        broker,
        source: "harness",
        idempotency_key,
        order: {
          symbol,
          asset_class: "us_equity",
          side: "buy",
          notional: Math.round(positionSize * 100) / 100,
          order_type: "market",
          time_in_force: "day",
        },
      });

      const success = isAcceptedSubmissionState(execution.submission.state);
      await this.recordDecisionTrace({
        trace_id: idempotency_key,
        request_id: idempotency_key,
        stage: "order_submission",
        decision_kind: "execution",
        input: {
          symbol,
          side: "buy",
          confidence,
          notional: positionSize,
        },
        output: {
          submission_id: execution.submission.id,
          submission_state: execution.submission.state,
          broker_order_id: execution.broker_order_id ?? null,
          trade_id: execution.trade_id ?? null,
        },
        final_action: success ? "submitted" : "submission_not_accepted",
        status: success ? "success" : "blocked",
        symbol,
        metadata: {
          source: "harness",
          approval_id: execution.submission.approval_id ?? null,
        },
      });

      this.recordTrade(symbol, "buy", positionSize, success, undefined);

      if (success) {
        this.state.lastTradeTime = Date.now();
        await this.saveState();
      }

      await this.publishTradeOutcome({
        symbol,
        side: "buy",
        notional: positionSize,
        success,
        confidence,
        reason: success ? "Order submitted" : "Order submission failed",
      });

      return success;
    } catch (error) {
      this.recordTrade(symbol, "buy", positionSize, false, String(error));
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("buy", symbol),
        request_id: this.buildIdempotencyKey("buy", symbol),
        stage: "order_submission",
        decision_kind: "execution",
        input: {
          symbol,
          side: "buy",
          confidence,
          notional: positionSize,
        },
        final_action: "submit_failed",
        status: "error",
        error_message: String(error),
        symbol,
      });
      await this.publishTradeOutcome({
        symbol,
        side: "buy",
        notional: positionSize,
        success: false,
        confidence,
        reason: String(error),
      });
      return false;
    }
  }

  private async executeSell(symbol: string, reason: string): Promise<boolean> {
    // Input validation
    if (!symbol || symbol.trim().length === 0) {
      this.recordTrade(symbol, "sell", 0, false, "Empty symbol");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("sell", symbol || "UNKNOWN"),
        request_id: this.buildIdempotencyKey("sell", symbol || "UNKNOWN"),
        stage: "sell_intent",
        decision_kind: "execution",
        input: { symbol, reason },
        final_action: "rejected_empty_symbol",
        status: "blocked",
        error_message: "Empty symbol",
        symbol: symbol || null,
      });
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      this.recordTrade(symbol, "sell", 0, false, "No sell reason provided");
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("sell", symbol),
        request_id: this.buildIdempotencyKey("sell", symbol),
        stage: "sell_intent",
        decision_kind: "execution",
        input: { symbol, reason },
        final_action: "rejected_missing_reason",
        status: "blocked",
        error_message: "No sell reason provided",
        symbol,
      });
      return false;
    }

    try {
      const broker = createBrokerProviders(this.env, "alpaca");
      const position = await broker.trading.getPosition(symbol).catch(() => null);

      if (!position) {
        this.recordTrade(symbol, "sell", 0, false, "Position not found");
        await this.recordDecisionTrace({
          trace_id: this.buildIdempotencyKey("sell", symbol),
          request_id: this.buildIdempotencyKey("sell", symbol),
          stage: "sell_position_lookup",
          decision_kind: "execution",
          input: { symbol, reason },
          final_action: "rejected_position_not_found",
          status: "blocked",
          error_message: "Position not found",
          symbol,
        });
        await this.publishTradeOutcome({
          symbol,
          side: "sell",
          notional: 0,
          success: false,
          reason: "Position not found",
        });
        return false;
      }

      const db = createD1Client(this.env.DB);
      const idempotency_key = this.buildIdempotencyKey("sell", symbol);

      const execution = await executeOrder({
        env: this.env,
        db,
        broker,
        source: "harness",
        idempotency_key,
        order: {
          symbol: position.symbol,
          asset_class: "us_equity",
          side: "sell",
          qty: position.qty,
          order_type: "market",
          time_in_force: "day",
        },
      });

      const success = isAcceptedSubmissionState(execution.submission.state);
      await this.recordDecisionTrace({
        trace_id: idempotency_key,
        request_id: idempotency_key,
        stage: "order_submission",
        decision_kind: "execution",
        input: {
          symbol: position.symbol,
          side: "sell",
          qty: position.qty,
          reason,
        },
        output: {
          submission_id: execution.submission.id,
          submission_state: execution.submission.state,
          broker_order_id: execution.broker_order_id ?? null,
          trade_id: execution.trade_id ?? null,
        },
        final_action: success ? "submitted" : "submission_not_accepted",
        status: success ? "success" : "blocked",
        symbol: position.symbol,
        metadata: {
          source: "harness",
          approval_id: execution.submission.approval_id ?? null,
        },
      });

      this.recordTrade(position.symbol, "sell", position.market_value, success, undefined);

      if (success) {
        this.state.lastTradeTime = Date.now();
        await this.saveState();
      }

      await this.publishTradeOutcome({
        symbol: position.symbol,
        side: "sell",
        notional: position.market_value,
        success,
        pnl: position.unrealized_pl,
        reason: success ? reason : "Sell submission failed",
      });

      return success;
    } catch (error) {
      this.recordTrade(symbol, "sell", 0, false, String(error));
      await this.recordDecisionTrace({
        trace_id: this.buildIdempotencyKey("sell", symbol),
        request_id: this.buildIdempotencyKey("sell", symbol),
        stage: "order_submission",
        decision_kind: "execution",
        input: { symbol, reason },
        final_action: "submit_failed",
        status: "error",
        error_message: String(error),
        symbol,
      });
      await this.publishTradeOutcome({
        symbol,
        side: "sell",
        notional: 0,
        success: false,
        reason: String(error),
      });
      return false;
    }
  }

  private recordTrade(symbol: string, side: "buy" | "sell", size: number, success: boolean, error?: string): void {
    const trade = {
      symbol,
      side,
      size,
      timestamp: Date.now(),
      success,
      error,
    };

    this.state.tradeHistory.push(trade);

    // Keep history manageable
    if (this.state.tradeHistory.length > 100) {
      this.state.tradeHistory = this.state.tradeHistory.slice(-50);
    }
  }

  private estimatePositionSize(cash: number, confidence: number): number {
    const sizePct = Math.min(20, 10); // 10% of cash, max 20%
    const cappedByStrategy = Math.min(
      cash * (sizePct / 100) * confidence * this.state.strategyProfile.riskMultiplier,
      this.state.strategyProfile.maxPositionNotional
    );
    return Math.min(cappedByStrategy, 5000); // Hard cap for safety
  }

  private async refreshStrategyProfileFromLearningAgent(): Promise<void> {
    const learningAgent = this.getLearningAgentStub();
    if (!learningAgent) return;

    try {
      const response = await learningAgent.fetch("http://learning/strategy");
      if (!response.ok) return;
      const strategy = (await response.json()) as {
        minConfidenceBuy?: number;
        maxPositionNotional?: number;
        riskMultiplier?: number;
        updatedAt?: number;
      };

      if (
        typeof strategy.minConfidenceBuy !== "number" ||
        typeof strategy.maxPositionNotional !== "number" ||
        typeof strategy.riskMultiplier !== "number"
      ) {
        return;
      }

      this.state.strategyProfile = {
        minConfidenceBuy: strategy.minConfidenceBuy,
        maxPositionNotional: strategy.maxPositionNotional,
        riskMultiplier: strategy.riskMultiplier,
        updatedAt: strategy.updatedAt ?? Date.now(),
        source: "learning",
      };
      await this.saveState();
    } catch {
      // Keep current strategy profile
    }
  }

  private async applyStrategyUpdate(payload: unknown): Promise<void> {
    const strategy = (
      payload as {
        strategy?: {
          minConfidenceBuy?: number;
          maxPositionNotional?: number;
          riskMultiplier?: number;
          updatedAt?: number;
        };
      }
    )?.strategy;

    if (
      !strategy ||
      typeof strategy.minConfidenceBuy !== "number" ||
      typeof strategy.maxPositionNotional !== "number" ||
      typeof strategy.riskMultiplier !== "number"
    ) {
      return;
    }

    this.state.strategyProfile = {
      minConfidenceBuy: strategy.minConfidenceBuy,
      maxPositionNotional: strategy.maxPositionNotional,
      riskMultiplier: strategy.riskMultiplier,
      updatedAt: strategy.updatedAt ?? Date.now(),
      source: "learning",
    };
    await this.saveState();
  }

  private async getLearningAdvice(
    symbol: string,
    confidence: number
  ): Promise<{
    approved: boolean;
    adjustedConfidence: number;
    reasons: string[];
  }> {
    const learningAgent = this.getLearningAgentStub();
    if (!learningAgent) {
      return {
        approved: confidence >= this.state.strategyProfile.minConfidenceBuy,
        adjustedConfidence: confidence,
        reasons: ["Learning agent unavailable"],
      };
    }

    try {
      const response = await learningAgent.fetch("http://learning/advice", {
        method: "POST",
        body: JSON.stringify({ symbol, confidence }),
      });

      if (!response.ok) {
        return {
          approved: confidence >= this.state.strategyProfile.minConfidenceBuy,
          adjustedConfidence: confidence,
          reasons: [`Learning advice unavailable (${response.status})`],
        };
      }

      const payload = (await response.json()) as {
        approved?: boolean;
        adjustedConfidence?: number;
        reasons?: string[];
      };

      return {
        approved: Boolean(payload.approved),
        adjustedConfidence: typeof payload.adjustedConfidence === "number" ? payload.adjustedConfidence : confidence,
        reasons: Array.isArray(payload.reasons) ? payload.reasons : [],
      };
    } catch (error) {
      return {
        approved: confidence >= this.state.strategyProfile.minConfidenceBuy,
        adjustedConfidence: confidence,
        reasons: [String(error)],
      };
    }
  }

  private getLearningAgentStub(): DurableObjectStub | null {
    if (!this.env.LEARNING_AGENT) return null;
    const learningId = this.env.LEARNING_AGENT.idFromName("default");
    return this.env.LEARNING_AGENT.get(learningId);
  }

  private async validateOrderWithRiskManager(
    order: {
      symbol: string;
      notional: number;
      side: "buy" | "sell";
    },
    context?: RiskValidationContext
  ): Promise<RiskValidationResult> {
    if (!this.env.RISK_MANAGER) {
      return { approved: false, reason: "Risk manager namespace unavailable" };
    }

    try {
      const riskId = this.env.RISK_MANAGER.idFromName("default");
      const riskManager = this.env.RISK_MANAGER.get(riskId);
      const response = await riskManager.fetch("http://risk-manager/validate", {
        method: "POST",
        body: JSON.stringify({
          ...order,
          account: context?.account,
          positions: context?.positions,
          clock: context?.clock,
          riskState: context?.riskState,
          policy_config: context?.policyConfig,
        }),
      });

      if (!response.ok) {
        return { approved: false, reason: `Risk manager unavailable (${response.status})` };
      }

      const payload = (await response.json()) as RiskValidationResult;
      return payload;
    } catch (error) {
      return { approved: false, reason: `Risk manager error: ${String(error)}` };
    }
  }

  private async loadPolicyConfig(db: ReturnType<typeof createD1Client>): Promise<PolicyConfig> {
    const storedPolicy = await getPolicyConfig(db);
    return storedPolicy ?? getDefaultPolicyConfig(this.env);
  }

  private buildIdempotencyKey(action: "buy" | "sell", symbol: string, suffix?: string): string {
    const normalizedSymbol = symbol
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9/_:-]/g, "_");
    const bucket = suffix ?? String(Math.floor(Date.now() / 300_000));
    return `trader:${action}:${normalizedSymbol}:${bucket}`;
  }

  private async recordDecisionTrace(params: Omit<CreateDecisionTraceParams, "source">): Promise<void> {
    if (!this.env.DB || typeof this.env.DB.prepare !== "function") {
      return;
    }
    try {
      const db = createD1Client(this.env.DB);
      await createDecisionTrace(db, {
        source: "trader-simple",
        ...params,
      });
    } catch (error) {
      if (!isMissingDecisionTraceSchemaError(error)) {
        this.log("warn", "Unable to persist trader decision trace", { error: String(error) });
      }
    }
  }

  private async publishTradeOutcome(outcome: {
    symbol: string;
    side: "buy" | "sell";
    notional: number;
    success: boolean;
    confidence?: number;
    pnl?: number;
    reason?: string;
  }): Promise<void> {
    try {
      await this.publishEvent("trade_outcome", {
        ...outcome,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.log("warn", "Unable to publish trade_outcome", { error: String(error), symbol: outcome.symbol });
    }
  }

  async alarm(): Promise<void> {
    // Clean up old trade history (older than 7 days)
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    this.state.tradeHistory = this.state.tradeHistory.filter((trade) => trade.timestamp >= sevenDaysAgo);

    await this.saveState();
    await super.alarm();
  }
}
