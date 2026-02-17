import { createError, ErrorCode } from "../../lib/errors";
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
import type { PolymarketClient } from "./client";
import { PolymarketClientError } from "./errors";
import { formatPolymarketSymbol, type PolymarketSymbolMap, resolvePolymarketTokenId } from "./symbols";
import { toAccount, toCreatedOrder, toOrder } from "./transformers";
import type {
  PolymarketDataPosition,
  PolymarketOpenOrder,
  PolymarketOrderSide,
  PolymarketOrderType,
  PolymarketTrade,
} from "./types";
import { parseNumber } from "./utils";

function parseTimeInForce(orderType: OrderParams["time_in_force"]): PolymarketOrderType {
  if (orderType === "fok" || orderType === "ioc") return "FOK";
  if (orderType === "day") return "GTD";
  return "GTC";
}

function normalizeSide(side: Order["side"]): PolymarketOrderSide {
  return side === "sell" ? "SELL" : "BUY";
}

function mapStatusToOrderFilter(status: ListOrdersParams["status"]): string | undefined {
  if (status === "open") return "LIVE";
  if (status === "closed") return "MATCHED";
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof PolymarketClientError && error.code === ErrorCode.NOT_FOUND;
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
    const parsedInt = Number.parseInt(value, 10);
    if (Number.isFinite(parsedInt)) return value.trim().length > 10 ? parsedInt : parsedInt * 1000;
  }
  return 0;
}

function toArrayPayload<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (Array.isArray(data)) return data as T[];
  return [];
}

function extractOrders(payload: unknown): PolymarketOpenOrder[] {
  return toArrayPayload<PolymarketOpenOrder>(payload);
}

function extractSingleOrder(payload: unknown): PolymarketOpenOrder | null {
  if (!payload || typeof payload !== "object") return null;
  const order = (payload as Record<string, unknown>).order;
  if (order && typeof order === "object" && !Array.isArray(order)) {
    return order as PolymarketOpenOrder;
  }
  const orders = extractOrders(payload);
  return orders[0] ?? null;
}

function extractTrades(payload: unknown): PolymarketTrade[] {
  return toArrayPayload<PolymarketTrade>(payload);
}

function toPositionFromDataApi(position: PolymarketDataPosition, symbolMap: PolymarketSymbolMap): Position | null {
  const tokenId = String(position.asset ?? "").trim();
  const qty = parseNumber(position.size, 0);
  if (!tokenId || !Number.isFinite(qty) || qty <= 0) {
    return null;
  }

  const avgPrice = parseNumber(position.avgPrice, 0);
  const currentPrice = parseNumber(position.curPrice, avgPrice);
  const marketValue = parseNumber(position.currentValue, qty * currentPrice);
  const costBasis = parseNumber(position.initialValue, qty * avgPrice);
  const pnl = parseNumber(position.cashPnl, marketValue - costBasis);
  const percentPnlRaw = parseNumber(position.percentPnl, costBasis > 0 ? pnl / costBasis : 0);
  const percentPnl = Math.abs(percentPnlRaw) > 1 ? percentPnlRaw / 100 : percentPnlRaw;
  const symbol = formatPolymarketSymbol(tokenId, symbolMap, tokenId);

  return {
    asset_id: tokenId,
    symbol,
    exchange: "POLYMARKET",
    asset_class: "crypto",
    avg_entry_price: avgPrice > 0 ? avgPrice : currentPrice,
    qty,
    side: "long",
    market_value: marketValue,
    cost_basis: costBasis > 0 ? costBasis : qty * (avgPrice > 0 ? avgPrice : currentPrice),
    unrealized_pl: pnl,
    unrealized_plpc: percentPnl,
    unrealized_intraday_pl: 0,
    unrealized_intraday_plpc: 0,
    current_price: currentPrice,
    lastday_price: currentPrice,
    change_today: 0,
  };
}

export interface PolymarketSignOrderRequest {
  tokenId: string;
  side: PolymarketOrderSide;
  orderType: PolymarketOrderType;
  price: number;
  size: number;
  chainId: number;
  signatureType: number;
  clientOrderId?: string;
}

export interface PolymarketSignedOrderPayload {
  order: Record<string, unknown>;
  owner?: string;
  orderType?: PolymarketOrderType;
}

export interface PolymarketOrderSigner {
  signOrder(request: PolymarketSignOrderRequest): Promise<PolymarketSignedOrderPayload>;
}

export interface HttpPolymarketOrderSignerConfig {
  url: string;
  timeoutMs?: number;
  bearerToken?: string;
}

export class HttpPolymarketOrderSigner implements PolymarketOrderSigner {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly bearerToken?: string;

  constructor(config: HttpPolymarketOrderSignerConfig) {
    this.url = config.url.trim();
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 10_000;
    this.bearerToken = config.bearerToken?.trim() || undefined;
  }

  async signOrder(request: PolymarketSignOrderRequest): Promise<PolymarketSignedOrderPayload> {
    if (!this.url) {
      throw createError(ErrorCode.NOT_SUPPORTED, "Polymarket order signer URL is not configured");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const rawBody = await response.text();

      if (!response.ok) {
        let payload: unknown = rawBody;
        if (rawBody.trim().length > 0) {
          try {
            payload = JSON.parse(rawBody);
          } catch {
            payload = rawBody;
          }
        }
        throw createError(ErrorCode.PROVIDER_ERROR, "Polymarket signer request failed", {
          status: response.status,
          payload,
        });
      }

      let payload: PolymarketSignedOrderPayload;
      try {
        payload = rawBody.trim().length === 0 ? ({} as PolymarketSignedOrderPayload) : JSON.parse(rawBody);
      } catch (error) {
        throw createError(ErrorCode.PROVIDER_ERROR, "Polymarket signer returned invalid JSON", {
          status: response.status,
          body: rawBody,
          error: String(error),
        });
      }

      if (!payload.order || typeof payload.order !== "object") {
        throw createError(ErrorCode.PROVIDER_ERROR, "Polymarket signer returned an invalid payload");
      }

      return payload;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw createError(ErrorCode.PROVIDER_ERROR, "Polymarket signer request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

export interface PolymarketTradingProvider extends BrokerProvider {}

export interface PolymarketTradingProviderConfig {
  client: PolymarketClient;
  symbolMap: PolymarketSymbolMap;
  signer?: PolymarketOrderSigner;
}

export function createPolymarketTradingProvider(config: PolymarketTradingProviderConfig): PolymarketTradingProvider {
  const { client, symbolMap, signer } = config;

  const resolveTokenId = (symbol: string): string => resolvePolymarketTokenId(symbol, symbolMap);

  const estimateTradeSize = async (params: OrderParams, tokenId: string): Promise<{ size: number; price: number }> => {
    const midpoint = await client.getMidpoint(tokenId).catch((error) => {
      console.warn("[polymarket_trading] midpoint lookup failed while estimating trade size", {
        tokenId,
        error: String(error),
      });
      return { mid: undefined };
    });
    const lastTrade = await client.getLastTradePrice(tokenId).catch((error) => {
      console.warn("[polymarket_trading] last-trade lookup failed while estimating trade size", {
        tokenId,
        error: String(error),
      });
      return { price: undefined };
    });
    const marketPrice = parseNumber(midpoint.mid, parseNumber(lastTrade.price, 0));
    const limitPrice = params.limit_price ?? marketPrice;
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Unable to determine a valid reference price for order sizing");
    }

    const qty = params.qty ?? (params.notional !== undefined ? params.notional / limitPrice : undefined);
    if (!qty || !Number.isFinite(qty) || qty <= 0) {
      throw createError(ErrorCode.INVALID_INPUT, "Either qty or notional must be provided and greater than 0");
    }

    return {
      size: qty,
      price: limitPrice,
    };
  };

  const formatTradeToSignedFill = (
    trade: PolymarketTrade
  ): { tokenId: string; signedQty: number; price: number; timestampMs: number } | null => {
    const tokenId = String(trade.asset_id ?? trade.token_id ?? "").trim();
    if (!tokenId) return null;

    const side = String(trade.side ?? "").toUpperCase();
    const size = parseNumber(trade.size, 0);
    const price = parseNumber(trade.price, 0);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    return {
      tokenId,
      signedQty: side === "SELL" ? -size : size,
      price,
      timestampMs: parseTimestampMs(trade.match_time ?? trade.timestamp),
    };
  };

  const loadPositionsFromDataApi = async (address: string): Promise<Position[]> => {
    const byToken = new Map<string, Position>();
    const pageSize = 500;

    for (let page = 0, offset = 0; page < 20; page++, offset += pageSize) {
      const entries = await client.getDataPositions(address, {
        limit: pageSize,
        offset,
        sizeThreshold: 0,
      });
      if (!Array.isArray(entries) || entries.length === 0) break;

      for (const entry of entries) {
        const position = toPositionFromDataApi(entry, symbolMap);
        if (!position) continue;
        byToken.set(position.asset_id, position);
      }

      if (entries.length < pageSize) break;
    }

    return Array.from(byToken.values());
  };

  const loadPositionsFromTrades = async (address: string): Promise<Position[]> => {
    const pageSize = 500;
    const trades: PolymarketTrade[] = [];

    for (let page = 0, offset = 0; page < 20; page++, offset += pageSize) {
      const tradesPayload = await client.listTrades({
        maker: address,
        limit: pageSize,
        offset,
      });
      const pageTrades = extractTrades(tradesPayload);
      if (pageTrades.length === 0) break;
      trades.push(...pageTrades);
      if (pageTrades.length < pageSize) break;
    }

    const fills = trades
      .map((trade) => formatTradeToSignedFill(trade))
      .filter((trade): trade is { tokenId: string; signedQty: number; price: number; timestampMs: number } =>
        Boolean(trade)
      )
      .sort((left, right) => left.timestampMs - right.timestampMs);

    const byToken = new Map<
      string,
      {
        signedQty: number;
        signedNotional: number;
        lastPrice: number;
      }
    >();

    for (const fill of fills) {
      const current = byToken.get(fill.tokenId) ?? { signedQty: 0, signedNotional: 0, lastPrice: fill.price };
      const nextSignedQty = current.signedQty + fill.signedQty;
      const nextSignedNotional = current.signedNotional + fill.signedQty * fill.price;

      if (Math.abs(nextSignedQty) < 1e-12) {
        byToken.delete(fill.tokenId);
        continue;
      }

      byToken.set(fill.tokenId, {
        signedQty: nextSignedQty,
        signedNotional: nextSignedNotional,
        lastPrice: fill.price,
      });
    }

    const positions: Position[] = [];
    for (const [tokenId, aggregate] of byToken.entries()) {
      const qty = Math.abs(aggregate.signedQty);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const symbol = formatPolymarketSymbol(tokenId, symbolMap, tokenId);
      const costBasis = Math.abs(aggregate.signedNotional);
      const marketValue = qty * aggregate.lastPrice;
      const isLong = aggregate.signedQty >= 0;
      const unrealizedPl = isLong ? marketValue - costBasis : costBasis - marketValue;
      const unrealizedPlpc = costBasis > 0 ? unrealizedPl / costBasis : 0;
      const avgEntry = qty > 0 ? Math.abs(aggregate.signedNotional / aggregate.signedQty) : aggregate.lastPrice;

      positions.push({
        asset_id: tokenId,
        symbol,
        exchange: "POLYMARKET",
        asset_class: "crypto",
        avg_entry_price: Number.isFinite(avgEntry) ? avgEntry : aggregate.lastPrice,
        qty,
        side: isLong ? "long" : "short",
        market_value: marketValue,
        cost_basis: costBasis,
        unrealized_pl: unrealizedPl,
        unrealized_plpc: Number.isFinite(unrealizedPlpc) ? unrealizedPlpc : 0,
        unrealized_intraday_pl: 0,
        unrealized_intraday_plpc: 0,
        current_price: aggregate.lastPrice,
        lastday_price: aggregate.lastPrice,
        change_today: 0,
      });
    }

    return positions;
  };

  return {
    async getAccount(): Promise<Account> {
      const balance = await client.getBalanceAllowance();
      return toAccount(balance);
    },

    async getPositions(): Promise<Position[]> {
      const address = client.getAddress();
      if (!address) return [];

      try {
        try {
          const dataApiPositions = await loadPositionsFromDataApi(address);
          if (dataApiPositions.length > 0) {
            return dataApiPositions;
          }
        } catch (error) {
          console.warn("[polymarket_trading] data-api positions unavailable, falling back to CLOB trades", {
            error: String(error),
          });
        }

        return await loadPositionsFromTrades(address);
      } catch (error) {
        if (isNotFoundError(error)) return [];
        throw error;
      }
    },

    async getPosition(symbol: string): Promise<Position | null> {
      const tokenId = resolveTokenId(symbol);
      const positions = await this.getPositions();
      return positions.find((position) => position.asset_id === tokenId || position.symbol === symbol) ?? null;
    },

    async closePosition(symbol: string, qty?: number, percentage?: number): Promise<Order> {
      const position = await this.getPosition(symbol);
      if (!position) {
        throw createError(ErrorCode.NOT_FOUND, `Position not found for ${symbol}`);
      }

      const closeQty = qty ?? (percentage !== undefined ? position.qty * (percentage / 100) : position.qty);
      if (!Number.isFinite(closeQty) || closeQty <= 0) {
        throw createError(ErrorCode.INVALID_INPUT, "closePosition requires a positive qty/percentage");
      }

      return this.createOrder({
        symbol: position.symbol,
        qty: closeQty,
        side: position.side === "short" ? "buy" : "sell",
        type: "market",
        time_in_force: "ioc",
      });
    },

    async createOrder(params: OrderParams): Promise<Order> {
      if (params.type !== "market" && params.type !== "limit") {
        throw createError(ErrorCode.NOT_SUPPORTED, `Polymarket provider does not support '${params.type}' orders`);
      }

      if (!signer) {
        throw createError(
          ErrorCode.NOT_SUPPORTED,
          "Polymarket order signer is not configured (set POLYMARKET_ORDER_SIGNER_URL)"
        );
      }

      const tokenId = resolveTokenId(params.symbol);
      const { size, price } = await estimateTradeSize(params, tokenId);
      const orderType = parseTimeInForce(params.time_in_force);
      const side = normalizeSide(params.side);
      const clientOrderId = params.client_order_id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const signed = await signer.signOrder({
        tokenId,
        side,
        orderType,
        price,
        size,
        chainId: client.getChainId(),
        signatureType: client.getSignatureType(),
        clientOrderId,
      });

      const owner = signed.owner ?? client.getAddress();
      if (!owner) {
        throw createError(
          ErrorCode.UNAUTHORIZED,
          "Polymarket owner address is missing. Configure POLYMARKET_ADDRESS or return owner from signer."
        );
      }

      const response = await client.postOrder({
        order: signed.order,
        owner,
        orderType: signed.orderType ?? orderType,
      });

      if (response.success === false) {
        throw createError(ErrorCode.PROVIDER_ERROR, response.errorMsg ?? "Polymarket order was rejected", response);
      }

      return toCreatedOrder(response, {
        symbol: params.symbol,
        tokenId,
        side: params.side,
        qty: size,
        price,
        orderType: signed.orderType ?? orderType,
        clientOrderId,
      });
    },

    async getOrder(orderId: string): Promise<Order> {
      const payload = await client.getOrder(orderId);
      const first = extractSingleOrder(payload);
      if (!first) {
        throw createError(ErrorCode.NOT_FOUND, `Order not found: ${orderId}`);
      }
      return toOrder(first, symbolMap);
    },

    async listOrders(params?: ListOrdersParams): Promise<Order[]> {
      const payload = await client.listOrders({
        status: mapStatusToOrderFilter(params?.status),
        limit: params?.limit,
      });
      let orders = extractOrders(payload).map((entry) => toOrder(entry, symbolMap));

      if (params?.symbols && params.symbols.length > 0) {
        const acceptedSymbols = new Set(params.symbols.map((symbol) => symbol.toUpperCase()));
        orders = orders.filter((order) => acceptedSymbols.has(order.symbol.toUpperCase()));
      }

      if (params?.direction === "asc") {
        orders = orders.sort((left, right) => left.created_at.localeCompare(right.created_at));
      } else {
        orders = orders.sort((left, right) => right.created_at.localeCompare(left.created_at));
      }

      if (params?.limit && params.limit > 0 && orders.length > params.limit) {
        orders = orders.slice(0, params.limit);
      }

      return orders;
    },

    async cancelOrder(orderId: string): Promise<void> {
      await client.cancelOrder(orderId);
    },

    async cancelAllOrders(): Promise<void> {
      await client.cancelAllOrders();
    },

    async getClock(): Promise<MarketClock> {
      const now = new Date();
      const nextOpen = new Date(now.getTime() + 60 * 60 * 1000);
      const nextClose = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
      return {
        timestamp: now.toISOString(),
        is_open: true,
        next_open: nextOpen.toISOString(),
        next_close: nextClose.toISOString(),
      };
    },

    async getCalendar(_start: string, _end: string): Promise<MarketDay[]> {
      return [];
    },

    async getAsset(symbol: string): Promise<Asset | null> {
      const tokenId = resolveTokenId(symbol);
      try {
        await client.getBook(tokenId);
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }

      return {
        id: tokenId,
        class: "crypto",
        exchange: "POLYMARKET",
        symbol: formatPolymarketSymbol(tokenId, symbolMap, symbol),
        name: formatPolymarketSymbol(tokenId, symbolMap, symbol),
        status: "active",
        tradable: true,
        marginable: false,
        shortable: true,
        fractionable: true,
      };
    },

    async getPortfolioHistory(_params?: PortfolioHistoryParams): Promise<PortfolioHistory> {
      const account = await this.getAccount();
      const nowSeconds = Math.floor(Date.now() / 1000);
      return {
        timestamp: [nowSeconds],
        equity: [account.equity],
        profit_loss: [0],
        profit_loss_pct: [0],
        base_value: account.equity,
        timeframe: "1D",
      };
    },
  };
}
