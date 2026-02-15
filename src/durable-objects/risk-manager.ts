import type { Env } from "../env.d";
import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";
import type { PolicyResult } from "../mcp/types";
import { mergePolicyConfigWithDefaults, type PolicyConfig } from "../policy/config";
import { PolicyEngine } from "../policy/engine";
import type { Account, MarketClock, Position } from "../providers/types";
import type { RiskState } from "../storage/d1/queries/risk-state";

interface RiskManagerState extends AgentBaseState {
  dailyLoss: number;
  maxDailyLoss: number;
  killSwitchActive: boolean;
  dailyEquityStart: number | null;
}

export class RiskManager extends AgentBase<RiskManagerState> {
  protected agentType: AgentType = "risk_manager";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (this.state.dailyLoss === undefined) {
      this.state = {
        ...this.state,
        dailyLoss: 0,
        maxDailyLoss: 1000, // Default $1000
        killSwitchActive: false,
        dailyEquityStart: null,
      };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/validate") {
      const payload = (await request.json()) as ValidateOrderPayload;
      const result = this.evaluatePayload(payload);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/status") {
      return new Response(
        JSON.stringify({
          killSwitchActive: this.state.killSwitchActive,
          dailyLoss: this.state.dailyLoss,
          maxDailyLoss: this.state.maxDailyLoss,
          dailyEquityStart: this.state.dailyEquityStart,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/update-loss" && request.method === "POST") {
      const { profitLoss } = (await request.json()) as { profitLoss: number };
      await this.updateDailyLoss({ profitLoss });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return super.fetch(request);
  }

  protected async onStart(): Promise<void> {
    this.log("info", "Risk Manager started");
  }

  protected async handleMessage(message: AgentMessage): Promise<unknown> {
    switch (message.topic) {
      case "validate_order":
        return this.evaluatePayload(message.payload as ValidateOrderPayload);
      case "update_daily_loss":
        return this.updateDailyLoss(message.payload as { profitLoss: number });
      case "get_risk_status":
        return {
          dailyLoss: this.state.dailyLoss,
          killSwitchActive: this.state.killSwitchActive,
          dailyEquityStart: this.state.dailyEquityStart,
        };
      default:
        return { error: "Unknown topic" };
    }
  }

  private async updateDailyLoss(data: { profitLoss: number }): Promise<void> {
    // If profitLoss is negative, it adds to daily loss.
    // If positive, it reduces daily loss (or we might track strictly loss).
    // Usually daily loss is "Net PnL" for the day.
    // If Net PnL < -maxDailyLoss, stop.
    // Let's assume data.profitLoss is the realized PnL of a trade.

    // Simplification: We track accumulated negative PnL?
    // Or just accumulated PnL.

    // Let's assume we want to track "Drawdown from start of day".
    // For now, let's just track realized PnL accumulator.

    // NOTE: This is a placeholder. Real implementation needs a proper PnL tracker.
    this.state.dailyLoss -= data.profitLoss; // If profit positive, dailyLoss decreases (good).

    if (this.state.dailyLoss > this.state.maxDailyLoss) {
      this.state.killSwitchActive = true;
      this.log("warn", "Max daily loss exceeded. Kill switch activated.");
    }

    await this.saveState();
  }

  private evaluatePayload(payload: ValidateOrderPayload): {
    approved: boolean;
    reason?: string;
    violations?: PolicyResult["violations"];
    warnings?: PolicyResult["warnings"];
  } {
    const account = this.buildAccountFromPayload(payload.account);
    if (this.state.dailyEquityStart === null && account.equity > 0) {
      this.state.dailyEquityStart = account.equity;
    }

    const positions = Array.isArray(payload.positions) ? payload.positions : [];
    const clock = this.buildClockFromPayload(payload.clock);
    const config = mergePolicyConfigWithDefaults(payload.policy_config);
    const riskState = this.buildRiskState(config, account.equity, payload.riskState);
    const engine = new PolicyEngine(config);

    const order = {
      symbol: payload.symbol,
      asset_class: payload.asset_class ?? "us_equity",
      side: payload.side,
      notional: payload.notional,
      qty: payload.qty,
      order_type: payload.order_type ?? "market",
      time_in_force: payload.time_in_force ?? "day",
      estimated_price: payload.estimated_price,
    } as const;

    const result = engine.evaluate({ order, account, positions, clock, riskState });
    return {
      approved: result.allowed,
      reason: result.violations[0]?.message,
      violations: result.violations,
      warnings: result.warnings,
    };
  }

  private buildDefaultAccount(): Account {
    return {
      id: "risk-manager",
      account_number: "risk-manager",
      status: "ACTIVE",
      currency: "USD",
      cash: 100000,
      buying_power: 100000,
      regt_buying_power: 100000,
      daytrading_buying_power: 100000,
      equity: 100000,
      last_equity: 100000,
      long_market_value: 0,
      short_market_value: 0,
      portfolio_value: 100000,
      pattern_day_trader: false,
      trading_blocked: false,
      transfers_blocked: false,
      account_blocked: false,
      multiplier: "1",
      shorting_enabled: false,
      maintenance_margin: 0,
      initial_margin: 0,
      daytrade_count: 0,
      created_at: new Date().toISOString(),
    };
  }

  private buildAccountFromPayload(input: Partial<Account> | undefined): Account {
    const defaults = this.buildDefaultAccount();
    return {
      ...defaults,
      ...(input ?? {}),
      cash: typeof input?.cash === "number" ? input.cash : defaults.cash,
      equity: typeof input?.equity === "number" ? input.equity : defaults.equity,
      buying_power: typeof input?.buying_power === "number" ? input.buying_power : defaults.buying_power,
      last_equity: typeof input?.last_equity === "number" ? input.last_equity : defaults.last_equity,
    };
  }

  private buildDefaultClock(): MarketClock {
    const now = new Date().toISOString();
    return {
      timestamp: now,
      is_open: true,
      next_open: now,
      next_close: now,
    };
  }

  private buildClockFromPayload(input: Partial<MarketClock> | undefined): MarketClock {
    const defaults = this.buildDefaultClock();
    return {
      ...defaults,
      ...(input ?? {}),
      is_open: typeof input?.is_open === "boolean" ? input.is_open : defaults.is_open,
      timestamp: typeof input?.timestamp === "string" ? input.timestamp : defaults.timestamp,
      next_open: typeof input?.next_open === "string" ? input.next_open : defaults.next_open,
      next_close: typeof input?.next_close === "string" ? input.next_close : defaults.next_close,
    };
  }

  private buildRiskState(config: PolicyConfig, accountEquity: number, overrides?: Partial<RiskState>): RiskState {
    const now = new Date().toISOString();
    return {
      kill_switch_active: this.state.killSwitchActive,
      kill_switch_reason: this.state.killSwitchActive ? "Kill switch is active" : null,
      kill_switch_at: this.state.killSwitchActive ? now : null,
      daily_loss_usd: Math.max(0, this.state.dailyLoss),
      daily_loss_reset_at: now,
      daily_equity_start: this.state.dailyEquityStart ?? (accountEquity > 0 ? accountEquity : null),
      max_symbol_exposure_pct: config.max_symbol_exposure_pct,
      max_correlated_exposure_pct: config.max_correlated_exposure_pct,
      max_portfolio_drawdown_pct: config.max_portfolio_drawdown_pct,
      last_loss_at: null,
      cooldown_until: null,
      updated_at: now,
      ...(overrides ?? {}),
    };
  }
}

interface ValidateOrderPayload {
  symbol: string;
  side: "buy" | "sell";
  notional?: number;
  qty?: number;
  asset_class?: "us_equity" | "crypto";
  order_type?: "market" | "limit" | "stop" | "stop_limit";
  time_in_force?: "day" | "gtc" | "ioc" | "fok";
  estimated_price?: number;
  account?: Partial<Account>;
  positions?: Position[];
  clock?: Partial<MarketClock>;
  riskState?: Partial<RiskState>;
  policy_config?: Partial<PolicyConfig>;
}
