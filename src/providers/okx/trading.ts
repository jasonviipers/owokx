import { createError, ErrorCode } from "../../lib/errors";
import { nowISO } from "../../lib/utils";
import type {
  Account,
  Asset,
  BrokerProvider,
  ListOrdersParams,
  MarketClock,
  MarketDay,
  Order,
  OrderParams,
  PortfolioHistory,
  PortfolioHistoryParams,
  Position,
} from "../types";
import type { OkxClient } from "./client";
import { normalizeOkxSymbol } from "./symbols";

interface OkxBalanceDetails {
  ccy: string;
  cashBal?: string;
  availBal?: string;
  eq?: string;
}

interface OkxBalanceEntry {
  totalEq?: string;
  details?: OkxBalanceDetails[];
}

export interface OkxTradingProviderOptions {
  simulatedTrading?: boolean;
  enableDemoVirtualBalances?: boolean;
  demoVirtualCashUsd?: number;
  demoVirtualBuyingPowerUsd?: number;
}

interface OkxOrderInfo {
  instId: string;
  ordId: string;
  clOrdId?: string;
  side: "buy" | "sell";
  ordType: string;
  state: string;
  sz: string;
  fillSz: string;
  avgPx: string;
  px?: string;
  cTime: string;
  uTime: string;
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function mapOrderState(state: string): Order["status"] {
  const s = state.toLowerCase();
  if (s === "live") return "new";
  if (s === "partially_filled") return "partially_filled";
  if (s === "filled") return "filled";
  if (s === "canceled") return "canceled";
  if (s === "canceling") return "pending_cancel";
  if (s === "failed") return "rejected";
  return "new";
}

function mapTimeInForce(tif: OrderParams["time_in_force"]): string | undefined {
  if (tif === "ioc") return "IOC";
  if (tif === "fok") return "FOK";
  return "GTC";
}

function createSyntheticOrder(params: {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  timeInForce: string;
  qty: string;
  limitPrice: string | null;
  createdAt: string;
}): Order {
  return {
    id: params.id,
    client_order_id: "",
    symbol: params.symbol,
    asset_id: "",
    asset_class: "crypto",
    qty: params.qty,
    filled_qty: "0",
    filled_avg_price: null,
    order_class: "",
    order_type: params.type,
    type: params.type,
    side: params.side,
    time_in_force: params.timeInForce,
    limit_price: params.limitPrice,
    stop_price: null,
    status: "new",
    extended_hours: false,
    created_at: params.createdAt,
    updated_at: params.createdAt,
    submitted_at: params.createdAt,
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: null,
  };
}

function parseOkxOrder(raw: OkxOrderInfo): Order {
  const createdAt = new Date(Number(raw.cTime)).toISOString();
  const updatedAt = new Date(Number(raw.uTime)).toISOString();
  const symbol = raw.instId.replace("-", "/");
  const filledAt = raw.state === "filled" ? updatedAt : null;
  const canceledAt = raw.state === "canceled" ? updatedAt : null;
  const failedAt = raw.state === "failed" ? updatedAt : null;

  return {
    id: raw.ordId,
    client_order_id: raw.clOrdId || "",
    symbol,
    asset_id: "",
    asset_class: "crypto",
    qty: raw.sz,
    filled_qty: raw.fillSz,
    filled_avg_price: raw.avgPx ? raw.avgPx : null,
    order_class: "",
    order_type: raw.ordType,
    type: raw.ordType,
    side: raw.side,
    time_in_force: "gtc",
    limit_price: raw.px ?? null,
    stop_price: null,
    status: mapOrderState(raw.state),
    extended_hours: false,
    created_at: createdAt,
    updated_at: updatedAt,
    submitted_at: createdAt,
    filled_at: filledAt,
    expired_at: null,
    canceled_at: canceledAt,
    failed_at: failedAt,
  };
}

export class OkxTradingProvider implements BrokerProvider {
  constructor(
    private client: OkxClient,
    private defaultQuote: string,
    private options: OkxTradingProviderOptions = {}
  ) {}

  async getAccount(): Promise<Account> {
    const res = await this.client.request<OkxBalanceEntry>("GET", "/api/v5/account/balance");
    const root = res.data[0];
    const details = root?.details ?? [];

    const quote = this.defaultQuote.toUpperCase();
    const quoteRow = details.find((d) => d.ccy.toUpperCase() === quote);

    const availBal = parseNumber(quoteRow?.availBal);
    const cashBal = parseNumber(quoteRow?.cashBal);
    const quoteEq = parseNumber(quoteRow?.eq);
    let cash = Math.max(availBal, cashBal, quoteEq);

    const isDemoVirtualEnabled =
      this.options.simulatedTrading === true && (this.options.enableDemoVirtualBalances ?? true) === true;
    if (isDemoVirtualEnabled && cash <= 0) {
      const defaultSeed = 100_000;
      const configuredSeed = this.options.demoVirtualCashUsd;
      const seed = Number.isFinite(configuredSeed) ? Math.max(0, configuredSeed as number) : defaultSeed;
      cash = seed;
    }

    let buyingPower = cash;
    if (isDemoVirtualEnabled && buyingPower <= 0) {
      const configuredBuyingPower = this.options.demoVirtualBuyingPowerUsd;
      const fallbackBuyingPower = this.options.demoVirtualCashUsd;
      const seed = Number.isFinite(configuredBuyingPower)
        ? Math.max(0, configuredBuyingPower as number)
        : Number.isFinite(fallbackBuyingPower)
          ? Math.max(0, fallbackBuyingPower as number)
          : 100_000;
      buyingPower = seed;
    }

    const exchangeEquity = parseNumber(root?.totalEq);
    const equity = Math.max(exchangeEquity, cash);

    return {
      id: "okx",
      account_number: "okx",
      status: "ACTIVE",
      currency: quote,
      cash,
      buying_power: buyingPower,
      regt_buying_power: buyingPower,
      daytrading_buying_power: buyingPower,
      equity,
      last_equity: equity,
      long_market_value: Math.max(0, equity - cash),
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
      created_at: nowISO(),
    };
  }

  async getPositions(): Promise<Position[]> {
    const balance = await this.client.request<OkxBalanceEntry>("GET", "/api/v5/account/balance");
    const root = balance.data[0];
    const details = root?.details ?? [];

    const quote = this.defaultQuote.toUpperCase();
    const positions = details
      .filter((d) => d.ccy.toUpperCase() !== quote)
      .map((d) => ({
        ccy: d.ccy.toUpperCase(),
        qty: parseNumber(d.cashBal ?? d.eq),
      }))
      .filter((p) => p.qty > 0);

    if (positions.length === 0) return [];

    // Fetch all SPOT tickers at once instead of individual calls
    interface OkxTickerData {
      instId: string;
      last: string;
    }

    const tickersResponse = await this.client.request<OkxTickerData>(
      "GET",
      "/api/v5/market/tickers",
      { instType: "SPOT" },
      undefined,
      { auth: false }
    );

    // Create a map of instId -> price for quick lookup
    const priceMap = new Map<string, number>();
    for (const ticker of tickersResponse.data) {
      priceMap.set(ticker.instId, parseNumber(ticker.last));
    }

    return positions.map((p) => {
      const symbolInfo = normalizeOkxSymbol(p.ccy, quote);
      const price = priceMap.get(symbolInfo.instId) ?? 0;
      const marketValue = p.qty * price;
      const symbol = `${p.ccy}/${quote}`;
      return {
        asset_id: "",
        symbol,
        exchange: "OKX",
        asset_class: "crypto",
        avg_entry_price: 0,
        qty: p.qty,
        side: "long",
        market_value: marketValue,
        cost_basis: marketValue,
        unrealized_pl: 0,
        unrealized_plpc: 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: price,
        lastday_price: price,
        change_today: 0,
      };
    });
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const norm = normalizeOkxSymbol(symbol, this.defaultQuote);
    const positions = await this.getPositions();
    return positions.find((p) => normalizeOkxSymbol(p.symbol, this.defaultQuote).instId === norm.instId) ?? null;
  }

  async closePosition(symbol: string, qty?: number, percentage?: number): Promise<Order> {
    const pos = await this.getPosition(symbol);
    if (!pos) {
      throw createError(ErrorCode.NOT_FOUND, `Position not found: ${symbol}`);
    }

    let sellQty = pos.qty;
    if (qty !== undefined) {
      sellQty = Math.min(pos.qty, qty);
    } else if (percentage !== undefined) {
      sellQty = Math.max(0, Math.min(pos.qty, pos.qty * (percentage / 100)));
    }

    if (sellQty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Sell quantity must be > 0");
    }

    return this.createOrder({
      symbol: pos.symbol,
      qty: sellQty,
      side: "sell",
      type: "market",
      time_in_force: "gtc",
    });
  }

  async createOrder(params: OrderParams): Promise<Order> {
    const symbolInfo = normalizeOkxSymbol(params.symbol, this.defaultQuote);

    const ordType = params.type === "market" ? "market" : params.type === "limit" ? "limit" : null;
    if (!ordType) {
      throw createError(ErrorCode.NOT_SUPPORTED, `OKX does not support order type: ${params.type}`);
    }

    const body: Record<string, unknown> = {
      instId: symbolInfo.instId,
      tdMode: "cash",
      side: params.side,
      ordType,
    };

    if (params.client_order_id) body.clOrdId = params.client_order_id;

    if (ordType === "limit") {
      if (params.limit_price === undefined) {
        throw createError(ErrorCode.INVALID_INPUT, "limit_price is required for limit orders");
      }
      body.px = String(params.limit_price);
    }

    const tif = mapTimeInForce(params.time_in_force);
    if (tif) body.tif = tif;

    if (params.qty !== undefined) {
      body.sz = String(params.qty);
    } else if (params.notional !== undefined) {
      if (params.side !== "buy") {
        throw createError(ErrorCode.INVALID_INPUT, "notional is only supported for buy orders on OKX");
      }
      if (ordType !== "market") {
        throw createError(ErrorCode.INVALID_INPUT, "notional is only supported for market orders on OKX");
      }
      body.sz = String(params.notional);
      body.tgtCcy = "quote_ccy";
    } else {
      throw createError(ErrorCode.INVALID_INPUT, "Either qty or notional is required");
    }

    const placed = await this.client.request<{ ordId: string; clOrdId?: string; sCode: string; sMsg: string }>(
      "POST",
      "/api/v5/trade/order",
      undefined,
      body
    );
    const result = placed.data[0];

    if (!result || result.sCode !== "0") {
      throw createError(ErrorCode.PROVIDER_ERROR, `OKX order rejected: ${result?.sMsg ?? "unknown"}`, {
        sCode: result?.sCode,
      });
    }

    const createdAt = nowISO();
    return createSyntheticOrder({
      id: result.ordId,
      symbol: symbolInfo.normalizedSymbol,
      side: params.side,
      type: ordType,
      timeInForce: params.time_in_force,
      qty: params.qty !== undefined ? String(params.qty) : String(params.notional),
      limitPrice: params.limit_price !== undefined ? String(params.limit_price) : null,
      createdAt,
    });
  }

  async getOrder(orderId: string): Promise<Order> {
    const res = await this.client.request<OkxOrderInfo>("GET", "/api/v5/trade/order", { ordId: orderId });
    const raw = res.data[0];
    if (!raw) throw createError(ErrorCode.NOT_FOUND, `Order not found: ${orderId}`);
    return parseOkxOrder(raw);
  }

  async listOrders(params?: ListOrdersParams): Promise<Order[]> {
    const status = params?.status ?? "open";

    if (status === "open") {
      const res = await this.client.request<OkxOrderInfo>("GET", "/api/v5/trade/orders-pending", { instType: "SPOT" });
      return (res.data || []).map(parseOkxOrder);
    }

    if (status === "closed") {
      const res = await this.client.request<OkxOrderInfo>("GET", "/api/v5/trade/orders-history", { instType: "SPOT" });
      return (res.data || []).map(parseOkxOrder);
    }

    const [open, closed] = await Promise.all([
      this.listOrders({ ...params, status: "open" }),
      this.listOrders({ ...params, status: "closed" }),
    ]);
    return [...open, ...closed];
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    const symbolInfo = normalizeOkxSymbol(order.symbol, this.defaultQuote);

    const res = await this.client.request<{ sCode: string; sMsg: string }>(
      "POST",
      "/api/v5/trade/cancel-order",
      undefined,
      {
        instId: symbolInfo.instId,
        ordId: orderId,
      }
    );

    const result = res.data[0];
    if (result && result.sCode !== "0") {
      throw createError(ErrorCode.PROVIDER_ERROR, `OKX cancel rejected: ${result.sMsg}`, { sCode: result.sCode });
    }
  }

  async cancelAllOrders(): Promise<void> {
    const open = await this.listOrders({ status: "open" });
    for (const order of open) {
      await this.cancelOrder(order.id);
    }
  }

  async getClock(): Promise<MarketClock> {
    const now = new Date();
    return {
      timestamp: now.toISOString(),
      is_open: true,
      next_open: now.toISOString(),
      next_close: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async getCalendar(_start: string, _end: string): Promise<MarketDay[]> {
    return [];
  }

  async getAsset(symbol: string): Promise<Asset | null> {
    const upper = symbol.toUpperCase();
    if (upper.includes("/") || upper.includes("-") || /^[A-Z0-9]{2,10}(USD|USDT|USDC)$/.test(upper)) {
      const info = normalizeOkxSymbol(symbol, this.defaultQuote);
      return {
        id: info.instId,
        class: "crypto",
        exchange: "OKX",
        symbol: info.normalizedSymbol,
        name: info.instId,
        status: "active",
        tradable: true,
        marginable: false,
        shortable: false,
        fractionable: true,
      };
    }
    return null;
  }

  async getPortfolioHistory(_params?: PortfolioHistoryParams): Promise<PortfolioHistory> {
    const account = await this.getAccount();
    const ts = Math.floor(Date.now() / 1000);
    return {
      timestamp: [ts],
      equity: [account.equity],
      profit_loss: [0],
      profit_loss_pct: [0],
      base_value: account.equity,
      timeframe: "1D",
    };
  }
}

export function createOkxTradingProvider(
  client: OkxClient,
  defaultQuote: string,
  options?: OkxTradingProviderOptions
): OkxTradingProvider {
  return new OkxTradingProvider(client, defaultQuote, options);
}
