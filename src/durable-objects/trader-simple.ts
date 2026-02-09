/**
 * Trader - Simplified Durable Object for Order Execution
 * 
 * Follows the same pattern as OwokxHarness for consistency.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { executeOrder } from "../execution/execute-order";
import { createBrokerProviders } from "../providers/broker-factory";
import { createD1Client } from "../storage/d1/client";

interface TraderState {
  tradeHistory: Array<{
    symbol: string;
    side: "buy" | "sell";
    size: number;
    timestamp: number;
    success: boolean;
    error?: string;
  }>;
  lastTradeTime: number;
}

const DEFAULT_STATE: TraderState = {
  tradeHistory: [],
  lastTradeTime: 0,
};

export class TraderSimple extends DurableObject<Env> {
  private state: TraderState = { ...DEFAULT_STATE };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<TraderState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/buy") {
      return this.handleBuy(request);
    } else if (path === "/sell") {
      return this.handleSell(request);
    } else if (path === "/history") {
      return this.handleGetHistory();
    } else if (path === "/health") {
      return this.handleHealth();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleBuy(request: Request): Promise<Response> {
    try {
      const { symbol, confidence, account } = await request.json() as {
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
      const { symbol, reason } = await request.json() as {
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

  private async handleHealth(): Promise<Response> {
    const now = Date.now();
    const lastTradeAge = now - this.state.lastTradeTime;
    const isHealthy = lastTradeAge < 3600000; // 1 hour
    
    return new Response(JSON.stringify({
      healthy: isHealthy,
      lastTradeTime: this.state.lastTradeTime,
      lastTradeAgeMs: lastTradeAge,
      tradeCount: this.state.tradeHistory.length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async executeBuy(
    symbol: string,
    confidence: number,
    account: { cash: number }
  ): Promise<boolean> {
    // Input validation
    if (!symbol || symbol.trim().length === 0) {
      this.recordTrade(symbol, "buy", 0, false, "Empty symbol");
      return false;
    }

    if (account.cash <= 0) {
      this.recordTrade(symbol, "buy", 0, false, "No cash available");
      return false;
    }

    if (confidence <= 0 || confidence > 1 || !Number.isFinite(confidence)) {
      this.recordTrade(symbol, "buy", 0, false, "Invalid confidence");
      return false;
    }

    // Position sizing
    const sizePct = Math.min(20, 10); // 10% of cash, max 20%
    const positionSize = Math.min(account.cash * (sizePct / 100) * confidence, 5000); // Max $5000

    if (positionSize < 100) {
      this.recordTrade(symbol, "buy", positionSize, false, "Position too small");
      return false;
    }

    if (positionSize <= 0 || positionSize > 5000 * 1.01 || !Number.isFinite(positionSize)) {
      this.recordTrade(symbol, "buy", positionSize, false, "Invalid position size");
      return false;
    }

    try {
      const broker = createBrokerProviders(this.env, "alpaca");
      const db = createD1Client(this.env.DB);
      const idempotency_key = `trader:buy:${symbol}:${Date.now()}`;

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

      const success = execution.submission.state === "SUBMITTED" || execution.submission.state === "SUBMITTING";
      
      this.recordTrade(
        symbol,
        "buy",
        positionSize,
        success,
        undefined
      );

      if (success) {
        this.state.lastTradeTime = Date.now();
        await this.ctx.storage.put("state", this.state);
      }

      return success;
    } catch (error) {
      this.recordTrade(symbol, "buy", positionSize, false, String(error));
      return false;
    }
  }

  private async executeSell(
    symbol: string,
    reason: string
  ): Promise<boolean> {
    // Input validation
    if (!symbol || symbol.trim().length === 0) {
      this.recordTrade(symbol, "sell", 0, false, "Empty symbol");
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      this.recordTrade(symbol, "sell", 0, false, "No sell reason provided");
      return false;
    }

    try {
      const broker = createBrokerProviders(this.env, "alpaca");
      const position = await broker.trading.getPosition(symbol).catch(() => null);
      
      if (!position) {
        this.recordTrade(symbol, "sell", 0, false, "Position not found");
        return false;
      }

      const db = createD1Client(this.env.DB);
      const idempotency_key = `trader:sell:${symbol}:${Date.now()}`;

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

      const success = execution.submission.state === "SUBMITTED" || execution.submission.state === "SUBMITTING";
      
      this.recordTrade(
        position.symbol,
        "sell",
        position.market_value,
        success,
        undefined
      );

      if (success) {
        this.state.lastTradeTime = Date.now();
        await this.ctx.storage.put("state", this.state);
      }

      return success;
    } catch (error) {
      this.recordTrade(symbol, "sell", 0, false, String(error));
      return false;
    }
  }

  private recordTrade(
    symbol: string,
    side: "buy" | "sell",
    size: number,
    success: boolean,
    error?: string
  ): void {
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

  async alarm(): Promise<void> {
    // Clean up old trade history (older than 7 days)
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    this.state.tradeHistory = this.state.tradeHistory.filter(
      trade => trade.timestamp >= sevenDaysAgo
    );
    
    await this.ctx.storage.put("state", this.state);
    
    // Reschedule for 1 day from now
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}