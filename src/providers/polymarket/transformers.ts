import type { Account, Bar, Order, Quote, Snapshot } from "../types";
import { formatPolymarketSymbol, type PolymarketSymbolMap } from "./symbols";
import type {
  PolymarketBalanceAllowanceResponse,
  PolymarketBookLevel,
  PolymarketCreateOrderResponse,
  PolymarketOpenOrder,
  PolymarketOrderBook,
  PolymarketOrderType,
} from "./types";

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseIsoTimestamp(value: unknown, fallbackMs = Date.now()): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number.parseInt(value, 10);
    if (Number.isFinite(asNumber) && String(asNumber) === value.trim()) {
      const ms = value.trim().length > 10 ? asNumber : asNumber * 1000;
      return new Date(ms).toISOString();
    }
    const parsedMs = Date.parse(value);
    if (Number.isFinite(parsedMs)) {
      return new Date(parsedMs).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function topLevel(levels: PolymarketBookLevel[] | undefined): PolymarketBookLevel | null {
  if (!levels || levels.length === 0) return null;
  return levels[0] ?? null;
}

function resolveOrderStatus(rawStatus: string | undefined): Order["status"] {
  const normalized = (rawStatus ?? "").trim().toLowerCase();
  if (normalized.includes("cancel")) return "canceled";
  if (normalized.includes("reject")) return "rejected";
  if (normalized.includes("match") || normalized.includes("fill")) return "filled";
  if (normalized.includes("partial")) return "partially_filled";
  if (normalized.includes("live")) return "accepted";
  if (normalized.includes("pending")) return "pending_new";
  return "new";
}

function resolveTimeInForce(orderType: string | undefined): Order["time_in_force"] {
  const normalized = (orderType ?? "").trim().toUpperCase();
  if (normalized === "FOK") return "fok";
  if (normalized === "GTD") return "day";
  return "gtc";
}

function resolveOrderType(orderType: string | undefined): Order["type"] {
  const normalized = (orderType ?? "").trim().toUpperCase();
  if (normalized === "FOK") return "market";
  return "limit";
}

function resolveOrderSide(rawSide: string | undefined): Order["side"] {
  return String(rawSide ?? "").toUpperCase() === "SELL" ? "sell" : "buy";
}

export function toAccount(balance: PolymarketBalanceAllowanceResponse, nowMs = Date.now()): Account {
  const cash = parseNumber(balance.balance, 0);
  const allowance = parseNumber(balance.allowance, cash);

  return {
    id: "polymarket-account",
    account_number: "polymarket-account",
    status: "ACTIVE",
    currency: "USDC",
    cash,
    buying_power: allowance,
    regt_buying_power: allowance,
    daytrading_buying_power: allowance,
    equity: cash,
    last_equity: cash,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: cash,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: true,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: new Date(nowMs).toISOString(),
  };
}

export function toQuote(symbol: string, book: PolymarketOrderBook): Quote {
  const topBid = topLevel(book.bids);
  const topAsk = topLevel(book.asks);
  const bid = parseNumber(topBid?.price, 0);
  const ask = parseNumber(topAsk?.price, bid);

  return {
    symbol,
    bid_price: bid,
    bid_size: parseNumber(topBid?.size, 0),
    ask_price: ask,
    ask_size: parseNumber(topAsk?.size, 0),
    timestamp: parseIsoTimestamp(book.timestamp, Date.now()),
  };
}

export function toSyntheticBar(timestampIso: string, price: number): Bar {
  return {
    t: timestampIso,
    o: price,
    h: price,
    l: price,
    c: price,
    v: 0,
    n: 0,
    vw: price,
  };
}

export function toSnapshot(symbol: string, quote: Quote, referencePrice: number): Snapshot {
  const timestampIso = quote.timestamp;
  const bar = toSyntheticBar(timestampIso, referencePrice);

  return {
    symbol,
    latest_trade: {
      price: referencePrice,
      size: Math.max(1, quote.bid_size || quote.ask_size || 1),
      timestamp: timestampIso,
    },
    latest_quote: quote,
    minute_bar: bar,
    daily_bar: bar,
    prev_daily_bar: bar,
  };
}

export function toOrder(raw: PolymarketOpenOrder, symbolMap: PolymarketSymbolMap, nowMs = Date.now()): Order {
  const tokenId = raw.asset_id ?? raw.token_id ?? raw.market ?? "";
  const symbol = formatPolymarketSymbol(tokenId, symbolMap, tokenId);
  const qty = parseNumber(raw.original_size ?? raw.originalSize, 0);
  const filledQty = parseNumber(raw.size_matched ?? raw.sizeMatched, 0);
  const createdAt = parseIsoTimestamp(raw.created_at, nowMs);
  const orderType = raw.order_type ?? raw.orderType;

  return {
    id: raw.id ?? raw.order_id ?? raw.orderID ?? "",
    client_order_id: raw.id ?? raw.order_id ?? raw.orderID ?? "",
    symbol,
    asset_id: tokenId,
    asset_class: "crypto",
    qty: String(qty),
    filled_qty: String(filledQty),
    filled_avg_price: raw.price ?? null,
    order_class: "simple",
    order_type: resolveOrderType(orderType),
    type: resolveOrderType(orderType),
    side: resolveOrderSide(raw.side),
    time_in_force: resolveTimeInForce(orderType),
    limit_price: raw.price ?? null,
    stop_price: null,
    status: resolveOrderStatus(raw.status),
    extended_hours: false,
    created_at: createdAt,
    updated_at: createdAt,
    submitted_at: createdAt,
    filled_at: resolveOrderStatus(raw.status) === "filled" ? createdAt : null,
    expired_at: null,
    canceled_at: resolveOrderStatus(raw.status) === "canceled" ? createdAt : null,
    failed_at: resolveOrderStatus(raw.status) === "rejected" ? createdAt : null,
  };
}

export function toCreatedOrder(
  response: PolymarketCreateOrderResponse,
  input: {
    symbol: string;
    tokenId: string;
    side: Order["side"];
    qty: number;
    price: number;
    orderType: PolymarketOrderType;
    clientOrderId: string;
  },
  nowMs = Date.now()
): Order {
  const nowIso = new Date(nowMs).toISOString();
  const normalizedType = input.orderType === "FOK" ? "market" : "limit";
  const status = response.success === false ? "rejected" : "accepted";

  return {
    id: String(response.orderID ?? input.clientOrderId),
    client_order_id: input.clientOrderId,
    symbol: input.symbol,
    asset_id: input.tokenId,
    asset_class: "crypto",
    qty: String(input.qty),
    filled_qty: "0",
    filled_avg_price: null,
    order_class: "simple",
    order_type: normalizedType,
    type: normalizedType,
    side: input.side,
    time_in_force: input.orderType === "FOK" ? "fok" : "gtc",
    limit_price: String(input.price),
    stop_price: null,
    status,
    extended_hours: false,
    created_at: nowIso,
    updated_at: nowIso,
    submitted_at: nowIso,
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: status === "rejected" ? nowIso : null,
  };
}
