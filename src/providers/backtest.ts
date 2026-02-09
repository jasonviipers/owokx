import { createError, ErrorCode } from "../lib/errors";
import type {
  Account,
  Asset,
  Bar,
  BarsParams,
  BrokerProvider,
  ListOrdersParams,
  MarketClock,
  MarketDataProvider,
  MarketDay,
  Order,
  OrderParams,
  PortfolioHistory,
  PortfolioHistoryParams,
  Position,
  Quote,
  Snapshot,
} from "./types";
import { generateId } from "../lib/utils";

export interface BacktestMarketDataConfig {
  now_ms: number;
  spread_bps?: number;
}

export class BacktestMarketDataProvider implements MarketDataProvider {
  private readonly barsBySymbol: Map<string, Bar[]>;
  private nowMs: number;
  private readonly spreadBps: number;

  constructor(
    barsBySymbol: Record<string, Bar[]>,
    config: BacktestMarketDataConfig
  ) {
    this.barsBySymbol = new Map(
      Object.entries(barsBySymbol).map(([symbol, bars]) => [symbol.toUpperCase(), [...bars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))])
    );
    this.nowMs = config.now_ms;
    this.spreadBps = config.spread_bps ?? 10;
  }

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  getNow(): number {
    return this.nowMs;
  }

  async getBars(symbol: string, _timeframe: string, params?: BarsParams): Promise<Bar[]> {
    const bars = this.getBarsOrThrow(symbol);
    const startMs = params?.start ? Date.parse(params.start) : -Infinity;
    const endMs = params?.end ? Date.parse(params.end) : Infinity;
    const filtered = bars.filter((b) => {
      const t = Date.parse(b.t);
      return t >= startMs && t <= endMs;
    });
    if (params?.limit && params.limit > 0) {
      return filtered.slice(-params.limit);
    }
    return filtered;
  }

  async getLatestBar(symbol: string): Promise<Bar> {
    const bars = this.getBarsOrThrow(symbol);
    return this.getLatestBarAtNow(bars, symbol);
  }

  async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
    const out: Record<string, Bar> = {};
    for (const s of symbols) {
      out[s.toUpperCase()] = await this.getLatestBar(s);
    }
    return out;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const bar = await this.getLatestBar(symbol);
    const mid = bar.c;
    const halfSpread = (mid * (this.spreadBps / 10_000)) / 2;
    const bid = Math.max(0.00000001, mid - halfSpread);
    const ask = Math.max(bid, mid + halfSpread);
    return {
      symbol: symbol.toUpperCase(),
      bid_price: bid,
      bid_size: 1,
      ask_price: ask,
      ask_size: 1,
      timestamp: bar.t,
    };
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const out: Record<string, Quote> = {};
    for (const s of symbols) {
      out[s.toUpperCase()] = await this.getQuote(s);
    }
    return out;
  }

  async getSnapshot(symbol: string): Promise<Snapshot> {
    const upper = symbol.toUpperCase();
    const bars = this.getBarsOrThrow(upper);
    const latest = this.getLatestBarAtNow(bars, upper);
    const prev = this.getPrevBar(bars, latest);
    const quote = await this.getQuote(upper);
    return {
      symbol: upper,
      latest_trade: { price: latest.c, size: 1, timestamp: latest.t },
      latest_quote: quote,
      minute_bar: latest,
      daily_bar: latest,
      prev_daily_bar: prev ?? latest,
    };
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const out: Record<string, Snapshot> = {};
    for (const s of symbols) {
      out[s.toUpperCase()] = await this.getSnapshot(s);
    }
    return out;
  }

  async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
    return this.getSnapshot(symbol);
  }

  private getBarsOrThrow(symbol: string): Bar[] {
    const upper = symbol.toUpperCase();
    const bars = this.barsBySymbol.get(upper);
    if (!bars || bars.length === 0) {
      throw createError(ErrorCode.NOT_FOUND, `No bars for symbol: ${upper}`);
    }
    return bars;
  }

  private getLatestBarAtNow(bars: Bar[], symbol: string): Bar {
    const idx = this.findLatestIndexAtOrBefore(bars, this.nowMs);
    if (idx < 0) {
      throw createError(ErrorCode.NOT_FOUND, `No bar at or before now for symbol: ${symbol.toUpperCase()}`);
    }
    return bars[idx]!;
  }

  private findLatestIndexAtOrBefore(bars: Bar[], nowMs: number): number {
    let lo = 0;
    let hi = bars.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const t = Date.parse(bars[mid]!.t);
      if (t <= nowMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  private getPrevBar(bars: Bar[], bar: Bar): Bar | null {
    const idx = bars.findIndex((b) => b.t === bar.t);
    if (idx <= 0) return null;
    return bars[idx - 1] ?? null;
  }
}

export interface BacktestBrokerConfig {
  now_ms: number;
  quote_ccy?: string;
  initial_cash: number;
  initial_equity?: number;
  marketData: BacktestMarketDataProvider;
}

export class BacktestBrokerProvider implements BrokerProvider {
  private readonly quoteCcy: string;
  private readonly marketData: BacktestMarketDataProvider;
  private readonly accountId: string;
  private readonly accountNumber: string;
  private cash: number;
  private lastEquity: number;
  private nowMs: number;
  private readonly positions: Map<string, Position>;
  private readonly orders: Map<string, Order>;
  private readonly orderIds: string[];
  private readonly equityTimeline: Array<{ t_ms: number; equity: number; cash: number }>;

  constructor(config: BacktestBrokerConfig) {
    this.quoteCcy = config.quote_ccy ?? "USD";
    this.marketData = config.marketData;
    this.accountId = generateId();
    this.accountNumber = "BACKTEST";
    this.cash = config.initial_cash;
    this.lastEquity = config.initial_equity ?? config.initial_cash;
    this.nowMs = config.now_ms;
    this.positions = new Map();
    this.orders = new Map();
    this.orderIds = [];
    this.equityTimeline = [];
    this.recordEquityPoint();
  }

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
    this.marketData.setNow(nowMs);
    this.recordEquityPoint();
  }

  async getAccount(): Promise<Account> {
    const equity = await this.computeEquity();
    const account: Account = {
      id: this.accountId,
      account_number: this.accountNumber,
      status: "ACTIVE",
      currency: this.quoteCcy,
      cash: this.cash,
      buying_power: this.cash,
      regt_buying_power: this.cash,
      daytrading_buying_power: this.cash,
      equity,
      last_equity: this.lastEquity,
      long_market_value: Math.max(0, equity - this.cash),
      short_market_value: 0,
      portfolio_value: equity,
      pattern_day_trader: false,
      trading_blocked: false,
      transfers_blocked: false,
      account_blocked: false,
      multiplier: "1",
      shorting_enabled: false,
      maintenance_margin: 0,
      initial_margin: 0,
      daytrade_count: 0,
      created_at: new Date(this.nowMs).toISOString(),
    };
    this.lastEquity = equity;
    return account;
  }

  async getPositions(): Promise<Position[]> {
    return Array.from(this.positions.values()).map((p) => ({ ...p }));
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const pos = this.positions.get(symbol.toUpperCase());
    return pos ? { ...pos } : null;
  }

  async closePosition(symbol: string, qty?: number, percentage?: number): Promise<Order> {
    const pos = await this.getPosition(symbol);
    if (!pos) {
      throw createError(ErrorCode.NOT_FOUND, `Position not found: ${symbol.toUpperCase()}`);
    }
    let closeQty = pos.qty;
    if (typeof qty === "number") closeQty = qty;
    if (typeof percentage === "number") closeQty = pos.qty * percentage;
    if (closeQty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Close quantity must be positive");
    }
    return this.createOrder({
      symbol: pos.symbol,
      qty: closeQty,
      side: pos.side === "long" ? "sell" : "buy",
      type: "market",
      time_in_force: "day",
    });
  }

  async createOrder(params: OrderParams): Promise<Order> {
    const symbol = params.symbol.toUpperCase();
    if (!params.qty && !params.notional) {
      throw createError(ErrorCode.INVALID_INPUT, "Either qty or notional required");
    }
    if (params.qty !== undefined && params.qty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "qty must be positive");
    }
    if (params.notional !== undefined && params.notional <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "notional must be positive");
    }
    if (params.type !== "market") {
      throw createError(ErrorCode.NOT_SUPPORTED, "Backtest broker supports market orders only");
    }

    const quote = await this.marketData.getQuote(symbol);
    const fillPrice = params.side === "buy" ? quote.ask_price : quote.bid_price;
    const qty = params.qty ?? (params.notional ? params.notional / fillPrice : 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Unable to determine order qty");
    }

    if (params.side === "buy") {
      const cost = qty * fillPrice;
      if (cost > this.cash + 1e-9) {
        throw createError(ErrorCode.INSUFFICIENT_BUYING_POWER, "Insufficient buying power", { cost, cash: this.cash });
      }
      this.cash -= cost;
      this.applyFillToPosition(symbol, "long", qty, fillPrice);
    } else {
      const pos = this.positions.get(symbol);
      if (!pos || pos.qty <= 0) {
        throw createError(ErrorCode.NOT_FOUND, `Position not found: ${symbol}`);
      }
      if (qty > pos.qty + 1e-9) {
        throw createError(ErrorCode.INVALID_INPUT, "Sell qty exceeds position qty", { qty, position_qty: pos.qty });
      }
      this.cash += qty * fillPrice;
      this.applyFillToPosition(symbol, "long", -qty, fillPrice);
    }

    const orderId = generateId();
    const nowIso = new Date(this.nowMs).toISOString();
    const order: Order = {
      id: orderId,
      client_order_id: params.client_order_id ?? orderId.slice(0, 32),
      symbol,
      asset_id: symbol,
      asset_class: symbol.includes("/") ? "crypto" : "us_equity",
      qty: String(qty),
      filled_qty: String(qty),
      filled_avg_price: String(fillPrice),
      order_class: "simple",
      order_type: params.type,
      type: params.type,
      side: params.side,
      time_in_force: params.time_in_force,
      limit_price: params.limit_price ? String(params.limit_price) : null,
      stop_price: params.stop_price ? String(params.stop_price) : null,
      status: "filled",
      extended_hours: params.extended_hours ?? false,
      created_at: nowIso,
      updated_at: nowIso,
      submitted_at: nowIso,
      filled_at: nowIso,
      expired_at: null,
      canceled_at: null,
      failed_at: null,
    };
    this.orders.set(orderId, order);
    this.orderIds.push(orderId);
    this.recordEquityPoint();
    return order;
  }

  async getOrder(orderId: string): Promise<Order> {
    const o = this.orders.get(orderId);
    if (!o) {
      throw createError(ErrorCode.NOT_FOUND, `Order not found: ${orderId}`);
    }
    return { ...o };
  }

  async listOrders(params?: ListOrdersParams): Promise<Order[]> {
    const all = this.orderIds.map((id) => this.orders.get(id)!).filter(Boolean);
    const symbols = params?.symbols?.map((s) => s.toUpperCase());
    const filtered = symbols && symbols.length > 0 ? all.filter((o) => symbols.includes(o.symbol)) : all;
    const limit = params?.limit && params.limit > 0 ? params.limit : undefined;
    const sorted = (params?.direction ?? "desc") === "asc" ? filtered : [...filtered].reverse();
    return limit ? sorted.slice(0, limit).map((o) => ({ ...o })) : sorted.map((o) => ({ ...o }));
  }

  async cancelOrder(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (!o) {
      throw createError(ErrorCode.NOT_FOUND, `Order not found: ${orderId}`);
    }
    if (o.status === "filled") {
      throw createError(ErrorCode.CONFLICT, "Cannot cancel filled order");
    }
    const nowIso = new Date(this.nowMs).toISOString();
    this.orders.set(orderId, { ...o, status: "canceled", canceled_at: nowIso, updated_at: nowIso });
  }

  async cancelAllOrders(): Promise<void> {
    for (const id of this.orderIds) {
      const o = this.orders.get(id);
      if (!o) continue;
      if (o.status === "filled") continue;
      const nowIso = new Date(this.nowMs).toISOString();
      this.orders.set(id, { ...o, status: "canceled", canceled_at: nowIso, updated_at: nowIso });
    }
  }

  async getClock(): Promise<MarketClock> {
    const iso = new Date(this.nowMs).toISOString();
    return {
      timestamp: iso,
      is_open: true,
      next_open: iso,
      next_close: iso,
    };
  }

  async getCalendar(start: string, end: string): Promise<MarketDay[]> {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      throw createError(ErrorCode.INVALID_INPUT, "Invalid calendar range");
    }
    const days: MarketDay[] = [];
    const d = new Date(startMs);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= endMs) {
      const dateStr = d.toISOString().slice(0, 10);
      days.push({
        date: dateStr,
        open: `${dateStr}T13:30:00Z`,
        close: `${dateStr}T20:00:00Z`,
        settlement_date: dateStr,
      });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return days;
  }

  async getAsset(symbol: string): Promise<Asset | null> {
    const upper = symbol.toUpperCase();
    return {
      id: upper,
      class: upper.includes("/") ? "crypto" : "us_equity",
      exchange: upper.includes("/") ? "CRYPTO" : "NASDAQ",
      symbol: upper,
      name: upper,
      status: "active",
      tradable: true,
      marginable: false,
      shortable: false,
      fractionable: true,
    };
  }

  async getPortfolioHistory(params?: PortfolioHistoryParams): Promise<PortfolioHistory> {
    const startMs = params?.start ? Date.parse(params.start) : -Infinity;
    const endMs = params?.end ? Date.parse(params.end) : Infinity;
    const points = this.equityTimeline.filter((p) => p.t_ms >= startMs && p.t_ms <= endMs);
    const timeline = points.length > 0 ? points : this.equityTimeline;
    const base = timeline[0]?.equity ?? this.lastEquity;
    const timestamp = timeline.map((p) => Math.floor(p.t_ms / 1000));
    const equity = timeline.map((p) => p.equity);
    const profit_loss = timeline.map((p) => p.equity - base);
    const profit_loss_pct = timeline.map((p) => (base > 0 ? (p.equity - base) / base : 0));
    return {
      timestamp,
      equity,
      profit_loss,
      profit_loss_pct,
      base_value: base,
      timeframe: params?.timeframe ?? "1D",
    };
  }

  private async computeEquity(): Promise<number> {
    let equity = this.cash;
    for (const pos of this.positions.values()) {
      const quote = await this.marketData.getQuote(pos.symbol);
      const mid = (quote.bid_price + quote.ask_price) / 2;
      equity += pos.qty * mid;
    }
    return equity;
  }

  private applyFillToPosition(symbol: string, side: "long", signedQtyDelta: number, fillPrice: number): void {
    if (side !== "long") {
      throw createError(ErrorCode.NOT_SUPPORTED, "Backtest broker supports long positions only");
    }
    const existing = this.positions.get(symbol);
    const upper = symbol.toUpperCase();

    if (!existing) {
      if (signedQtyDelta <= 0) return;
      const qty = signedQtyDelta;
      const marketValue = qty * fillPrice;
      const pos: Position = {
        asset_id: upper,
        symbol: upper,
        exchange: upper.includes("/") ? "CRYPTO" : "NASDAQ",
        asset_class: upper.includes("/") ? "crypto" : "us_equity",
        avg_entry_price: fillPrice,
        qty,
        side: "long",
        market_value: marketValue,
        cost_basis: marketValue,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: fillPrice,
        lastday_price: fillPrice,
        change_today: 0,
      };
      this.positions.set(upper, pos);
      return;
    }

    const newQty = existing.qty + signedQtyDelta;
    if (newQty <= 1e-12) {
      this.positions.delete(upper);
      return;
    }

    const buyDelta = Math.max(0, signedQtyDelta);
    const newCostBasis = existing.cost_basis + buyDelta * fillPrice;
    const newAvg = newCostBasis / newQty;
    const marketValue = newQty * fillPrice;
    const unrealized = marketValue - newCostBasis;
    this.positions.set(upper, {
      ...existing,
      qty: newQty,
      avg_entry_price: newAvg,
      cost_basis: newCostBasis,
      market_value: marketValue,
      current_price: fillPrice,
      unrealized_pl: unrealized,
      unrealized_plpc: newCostBasis > 0 ? unrealized / newCostBasis : 0,
    });
  }

  private recordEquityPoint(): void {
    const latest = this.equityTimeline[this.equityTimeline.length - 1];
    if (latest && latest.t_ms === this.nowMs) return;
    const equityEstimate = this.cash + Array.from(this.positions.values()).reduce((sum, p) => sum + p.market_value, 0);
    this.equityTimeline.push({ t_ms: this.nowMs, equity: equityEstimate, cash: this.cash });
  }
}

