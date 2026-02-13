import type { Env } from "../env.d";
import { AgentBase, type AgentBaseState } from "../lib/agents/base";
import type { AgentMessage, AgentType } from "../lib/agents/protocol";

interface RiskManagerState extends AgentBaseState {
  dailyLoss: number;
  maxDailyLoss: number;
  killSwitchActive: boolean;
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
      };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/validate") {
      const order = (await request.json()) as {
        symbol: string;
        notional: number;
        side: "buy" | "sell";
      };
      const result = this.validateOrder({
        symbol: order.symbol,
        size: order.notional,
        side: order.side,
        price: 1,
      });
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
        return this.validateOrder(message.payload as any);
      case "update_daily_loss":
        return this.updateDailyLoss(message.payload as { profitLoss: number });
      case "get_risk_status":
        return {
          dailyLoss: this.state.dailyLoss,
          killSwitchActive: this.state.killSwitchActive,
        };
      default:
        return { error: "Unknown topic" };
    }
  }

  private validateOrder(order: { symbol: string; size: number; side: "buy" | "sell"; price: number }): {
    approved: boolean;
    reason?: string;
  } {
    if (this.state.killSwitchActive) {
      return { approved: false, reason: "Kill switch is active" };
    }

    if (this.state.dailyLoss >= this.state.maxDailyLoss) {
      return {
        approved: false,
        reason: `Max daily loss exceeded ($${this.state.dailyLoss.toFixed(2)} / $${this.state.maxDailyLoss})`,
      };
    }

    if (order.side === "buy" && order.size > 5000) {
      return {
        approved: false,
        reason: `Order notional ($${order.size.toFixed(2)}) exceeds per-trade limit ($5000)`,
      };
    }

    return { approved: true };
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

  calculateRiskState(equity: number, positions: { unrealized_pl: number }[]): { approved: boolean; reason?: string } {
    const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
    const currentDrawdown = this.state.dailyLoss - unrealizedPnL; // Assuming dailyLoss is realized losses (positive number)

    if (this.state.killSwitchActive) {
      return { approved: false, reason: "Kill switch active" };
    }

    // Use equity to calculate % drawdown if needed
    if (equity > 0) {
      const drawdownPct = (currentDrawdown / equity) * 100;
      if (drawdownPct > 10) {
        // Example 10% max drawdown
        return { approved: false, reason: `Drawdown (${drawdownPct.toFixed(1)}%) exceeds limit` };
      }
    }

    // Check open exposure or other risk metrics here
    if (currentDrawdown > this.state.maxDailyLoss) {
      return { approved: false, reason: `Drawdown ($${currentDrawdown.toFixed(2)}) exceeds max daily loss` };
    }

    return { approved: true };
  }
}
