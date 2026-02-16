import type {
  AccountBalance,
  AccountBill,
  AccountLeverageResult,
  AccountPosition,
  FillsHistoryRequest,
  Instrument,
  InstrumentType,
  OrderDetails,
  OrderFill,
  OrderHistoryRequest,
  OrderRequest,
  OrderResult,
  PositionSide,
} from "okx-api";
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
import type { OkxClient } from "./client";
import { handleOkxError } from "./client";
import { normalizeOkxSymbol } from "./symbols";

const SUPPORTED_INST_TYPES: InstrumentType[] = ["SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION"];

type OkxOrderType = OrderRequest["ordType"];

type OkxTradeMode = OrderRequest["tdMode"];

function parseNumber(value: string | number | undefined, fallback: number = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toIsoTimestamp(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return value;
}

function mapOrderState(state: string | undefined): Order["status"] {
  switch (state) {
    case "canceled":
    case "mmp_canceled":
      return "canceled";
    case "live":
      return "accepted";
    case "partially_filled":
      return "partially_filled";
    case "filled":
      return "filled";
    default:
      return "new";
  }
}

function mapTimeInForce(ordType: string | undefined): string {
  if (!ordType) {
    return "gtc";
  }

  if (ordType === "fok") {
    return "fok";
  }

  if (ordType === "ioc" || ordType === "market") {
    return "ioc";
  }

  return "gtc";
}

function inferAssetClass(instType: string | undefined): Order["asset_class"] {
  if (!instType) {
    return "crypto";
  }

  return "crypto";
}

function parseOrder(raw: Partial<OrderDetails> & { ordId: string; instId: string }): Order {
  return {
    id: raw.ordId,
    client_order_id: raw.clOrdId ?? "",
    symbol: raw.instId,
    asset_id: raw.instId,
    asset_class: inferAssetClass(raw.instType),
    qty: raw.sz ?? "0",
    filled_qty: raw.accFillSz ?? raw.fillSz ?? "0",
    filled_avg_price: raw.avgPx || null,
    order_class: "simple",
    order_type: raw.ordType ?? "limit",
    type: raw.ordType ?? "limit",
    side: (raw.side as Order["side"]) ?? "buy",
    time_in_force: mapTimeInForce(raw.ordType),
    limit_price: raw.px || null,
    stop_price: null,
    status: mapOrderState(raw.state),
    extended_hours: false,
    created_at: toIsoTimestamp(raw.cTime),
    updated_at: toIsoTimestamp(raw.uTime),
    submitted_at: toIsoTimestamp(raw.cTime),
    filled_at: raw.state === "filled" ? toIsoTimestamp(raw.uTime) : null,
    expired_at: null,
    canceled_at: raw.state === "canceled" || raw.state === "mmp_canceled" ? toIsoTimestamp(raw.uTime) : null,
    failed_at: null,
  };
}

function parseOrderResult(result: OrderResult, request: OrderRequest): Order {
  const accepted = result.sCode === "0" || result.sCode === "";

  return {
    id: result.ordId,
    client_order_id: result.clOrdId ?? request.clOrdId ?? "",
    symbol: request.instId,
    asset_id: request.instId,
    asset_class: inferAssetClass(undefined),
    qty: String(request.sz),
    filled_qty: "0",
    filled_avg_price: null,
    order_class: "simple",
    order_type: request.ordType,
    type: request.ordType,
    side: request.side,
    time_in_force: mapTimeInForce(request.ordType),
    limit_price: request.px ?? null,
    stop_price: null,
    status: accepted ? "accepted" : "rejected",
    extended_hours: false,
    created_at: toIsoTimestamp(result.ts),
    updated_at: toIsoTimestamp(result.ts),
    submitted_at: toIsoTimestamp(result.ts),
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: accepted ? null : toIsoTimestamp(result.ts),
  };
}

function parsePosition(raw: AccountPosition): Position {
  const rawPos = parseNumber(raw.pos, 0);
  const qty = Math.abs(rawPos);
  const avgEntry = parseNumber(raw.avgPx, 0);
  const markPrice = parseNumber(raw.markPx, parseNumber(raw.last, avgEntry));

  const side: Position["side"] = raw.posSide === "short" || rawPos < 0 ? "short" : "long";

  return {
    asset_id: raw.instId,
    symbol: raw.instId,
    exchange: "OKX",
    asset_class: "crypto",
    avg_entry_price: avgEntry,
    qty,
    side,
    market_value: qty * markPrice,
    cost_basis: qty * avgEntry,
    unrealized_pl: parseNumber(raw.upl, 0),
    unrealized_plpc: parseNumber(raw.uplRatio, 0),
    unrealized_intraday_pl: parseNumber(raw.upl, 0),
    unrealized_intraday_plpc: parseNumber(raw.uplRatio, 0),
    current_price: markPrice,
    lastday_price: parseNumber(raw.last, markPrice),
    change_today: 0,
  };
}

const DEMO_VIRTUAL_CASH = 25_000;
const DEMO_VIRTUAL_BUYING_POWER = 40_000;

function parseAccount(raw: AccountBalance, defaultQuoteCcy: string, simulatedTrading: boolean = false): Account {
  const details = Array.isArray(raw.details) ? raw.details : [];
  const preferredCcy = details.find((detail) => detail.ccy === defaultQuoteCcy) ?? details[0];

  const reportedCash = parseNumber(preferredCcy?.cashBal, 0);
  const reportedEquity = parseNumber(raw.totalEq, 0);
  const reportedBuyingPower = parseNumber(raw.adjEq, reportedEquity);

  const isDemoWithEmptyQuoteBalance = simulatedTrading && reportedCash <= 0;
  const equity = isDemoWithEmptyQuoteBalance ? Math.max(reportedEquity, DEMO_VIRTUAL_CASH) : reportedEquity;
  const cash = isDemoWithEmptyQuoteBalance ? equity : reportedCash;
  const buyingPower = isDemoWithEmptyQuoteBalance
    ? Math.max(reportedBuyingPower, equity, DEMO_VIRTUAL_BUYING_POWER)
    : reportedBuyingPower;

  return {
    id: "okx-account",
    account_number: "okx-account",
    status: "ACTIVE",
    currency: preferredCcy?.ccy ?? defaultQuoteCcy,
    cash,
    buying_power: buyingPower,
    regt_buying_power: buyingPower,
    daytrading_buying_power: buyingPower,
    equity,
    last_equity: equity,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: equity,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: true,
    maintenance_margin: parseNumber(raw.mmr, 0),
    initial_margin: parseNumber(raw.imr, 0),
    daytrade_count: 0,
    created_at: toIsoTimestamp(raw.uTime),
  };
}

function mapBrokerOrderToOkxType(params: OrderParams): OkxOrderType {
  if (params.type === "market") {
    return "market";
  }

  if (params.time_in_force === "fok") {
    return "fok";
  }

  if (params.time_in_force === "ioc") {
    return "ioc";
  }

  return "limit";
}

function mapOrderParamsToOkxOrderRequest(params: OrderParams, defaultQuoteCcy: string): OrderRequest {
  const hasQty = params.qty !== undefined;
  const hasNotional = params.notional !== undefined;

  if (!hasQty && !hasNotional) {
    throw createError(ErrorCode.INVALID_INPUT, "Either qty or notional must be provided for createOrder()");
  }

  const request: OrderRequest = {
    instId: normalizeOkxSymbol(params.symbol, defaultQuoteCcy).instId,
    tdMode: "cash",
    side: params.side,
    ordType: mapBrokerOrderToOkxType(params),
    sz: String(params.qty ?? params.notional ?? 0),
    clOrdId: params.client_order_id,
  };

  if (params.limit_price !== undefined) {
    request.px = String(params.limit_price);
  }

  if (params.notional !== undefined && params.qty === undefined) {
    request.tgtCcy = "quote_ccy";
  }

  return request;
}

function mapInstTypeForAsset(instType: InstrumentType): Asset["class"] {
  if (instType === "SPOT" || instType === "MARGIN") {
    return "crypto";
  }
  return "crypto";
}

export interface OkxOrderByIdParams {
  instId: string;
  ordId?: string;
  clOrdId?: string;
}

export interface OkxPlaceOrderParams {
  instId: string;
  side: "buy" | "sell";
  ordType?: OkxOrderType;
  tdMode?: OkxTradeMode;
  sz: string | number;
  px?: string | number;
  ccy?: string;
  clOrdId?: string;
  tag?: string;
  posSide?: PositionSide;
  reduceOnly?: boolean;
  tgtCcy?: "base_ccy" | "quote_ccy";
  instType?: InstrumentType;
}

export interface OkxTransactionHistoryParams {
  ccy?: string;
  instType?: InstrumentType;
  type?: string;
  subType?: string;
  after?: string;
  before?: string;
  begin?: string;
  end?: string;
  limit?: number;
  archive?: boolean;
}

export interface OkxFillsParams extends FillsHistoryRequest {
  archive?: boolean;
}

export interface OkxTradingProvider extends BrokerProvider {
  placeOrder(params: OkxPlaceOrderParams): Promise<Order>;
  placeSpotOrder(params: Omit<OkxPlaceOrderParams, "instType" | "tdMode"> & { tdMode?: "cash" }): Promise<Order>;
  placeMarginOrder(
    params: Omit<OkxPlaceOrderParams, "instType" | "tdMode"> & { tdMode?: "cross" | "isolated" }
  ): Promise<Order>;
  placeFuturesOrder(
    params: Omit<OkxPlaceOrderParams, "instType" | "tdMode"> & {
      instType?: "SWAP" | "FUTURES";
      tdMode?: "cross" | "isolated";
    }
  ): Promise<Order>;
  placeOptionOrder(
    params: Omit<OkxPlaceOrderParams, "instType"> & {
      instType?: "OPTION";
      tdMode?: "cross" | "isolated";
    }
  ): Promise<Order>;

  getOrderById(params: OkxOrderByIdParams): Promise<Order>;
  cancelOrderById(params: OkxOrderByIdParams): Promise<void>;

  listOrdersByInstrumentType(instType: InstrumentType, params?: ListOrdersParams): Promise<Order[]>;

  getBalances(ccy?: string): Promise<AccountBalance[]>;
  getTransactionHistory(params?: OkxTransactionHistoryParams): Promise<AccountBill[]>;
  getFills(params?: OkxFillsParams): Promise<OrderFill[]>;
  setLeverage(params: {
    lever: string;
    mgnMode: "cross" | "isolated";
    instId?: string;
    ccy?: string;
    posSide?: PositionSide;
  }): Promise<AccountLeverageResult[]>;
}

export function createOkxTradingProvider(client: OkxClient): OkxTradingProvider {
  const orderInstrumentCache = new Map<string, string>();
  const defaultQuoteCcy = client.config.defaultQuoteCcy ?? "USDT";
  const toInstId = (symbol: string): string => normalizeOkxSymbol(symbol, defaultQuoteCcy).instId;

  const rememberOrderInstrument = (orderId: string | undefined, instId: string | undefined) => {
    if (orderId && instId) {
      orderInstrumentCache.set(orderId, instId);
    }
  };

  const resolveOrderIdentifier = (orderId: string): { ordId?: string; clOrdId?: string } => {
    if (orderId.startsWith("cl:")) {
      return {
        clOrdId: orderId.slice(3),
      };
    }

    if (orderId.includes("|")) {
      const [kind, id] = orderId.split("|");
      if (kind === "cl" && id) {
        return { clOrdId: id };
      }
    }

    return { ordId: orderId };
  };

  const resolveInstrumentForOrder = async (orderId: string): Promise<string> => {
    const cached = orderInstrumentCache.get(orderId);
    if (cached) {
      return cached;
    }

    const orderIdentifier = resolveOrderIdentifier(orderId);

    const openOrderSearch = await Promise.all(
      SUPPORTED_INST_TYPES.map(async (instType) => {
        try {
          const orders = await client.rest.getOrderList({ instType, limit: "100" } as OrderHistoryRequest);
          const found = orders.find((order) =>
            orderIdentifier.ordId ? order.ordId === orderIdentifier.ordId : order.clOrdId === orderIdentifier.clOrdId
          );
          return found?.instId;
        } catch (error) {
          client.logger.debug("Order search in open orders failed", {
            instType,
            orderId,
            error: String(error),
          });
          return undefined;
        }
      })
    );

    const fromOpen = openOrderSearch.find((instId): instId is string => Boolean(instId));
    if (fromOpen) {
      rememberOrderInstrument(orderId, fromOpen);
      return fromOpen;
    }

    const historicSearch = await Promise.all(
      SUPPORTED_INST_TYPES.map(async (instType) => {
        try {
          const orders = await client.rest.getOrderHistory({ instType, limit: "100" } as OrderHistoryRequest);
          const found = orders.find((order) =>
            orderIdentifier.ordId ? order.ordId === orderIdentifier.ordId : order.clOrdId === orderIdentifier.clOrdId
          );
          return found?.instId;
        } catch (error) {
          client.logger.debug("Order search in history failed", {
            instType,
            orderId,
            error: String(error),
          });
          return undefined;
        }
      })
    );

    const fromHistory = historicSearch.find((instId): instId is string => Boolean(instId));
    if (fromHistory) {
      rememberOrderInstrument(orderId, fromHistory);
      return fromHistory;
    }

    throw createError(ErrorCode.NOT_FOUND, `Unable to resolve instrument for order ${orderId}`);
  };

  const placeOrderRequest = async (request: OrderRequest): Promise<Order> => {
    const response = await client.rest.submitOrder(request);
    const firstResult = response[0];

    if (!firstResult) {
      throw createError(ErrorCode.PROVIDER_ERROR, "OKX did not return order submission data");
    }

    rememberOrderInstrument(firstResult.ordId, request.instId);

    if (firstResult.sCode !== "0" && firstResult.sCode !== "") {
      handleOkxError({
        code: firstResult.sCode,
        msg: firstResult.sMsg || "Order submission failed",
      });
    }

    try {
      const details = await client.rest.getOrderDetails({ instId: request.instId, ordId: firstResult.ordId });
      const orderDetails = details[0];
      if (orderDetails) {
        rememberOrderInstrument(orderDetails.ordId, orderDetails.instId);
        return parseOrder(orderDetails);
      }
    } catch (error) {
      client.logger.debug("Order details fetch after placement failed, using fallback payload", {
        instId: request.instId,
        orderId: firstResult.ordId,
        error: String(error),
      });
    }

    return parseOrderResult(firstResult, request);
  };

  return {
    async getAccount(): Promise<Account> {
      try {
        const balances = await client.rest.getBalance();
        const first = balances[0];

        if (!first) {
          throw createError(ErrorCode.PROVIDER_ERROR, "No account balance data returned by OKX");
        }

        return parseAccount(first, client.config.defaultQuoteCcy ?? "USDT", Boolean(client.config.simulatedTrading));
      } catch (error) {
        client.logger.error("Failed to fetch account", error);
        throw handleOkxError(error);
      }
    },

    async getPositions(): Promise<Position[]> {
      try {
        const positions = await client.rest.getPositions();
        return positions.map(parsePosition);
      } catch (error) {
        client.logger.error("Failed to fetch positions", error);
        throw handleOkxError(error);
      }
    },

    async getPosition(symbol: string): Promise<Position | null> {
      try {
        const instId = toInstId(symbol);
        const positions = await client.rest.getPositions({ instId });
        const first = positions[0];
        return first ? parsePosition(first) : null;
      } catch (error) {
        client.logger.error("Failed to fetch position", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async closePosition(symbol: string, qty?: number, percentage?: number): Promise<Order> {
      try {
        const instId = toInstId(symbol);
        const rawPositions = await client.rest.getPositions({ instId });
        const rawPosition = rawPositions[0];

        if (!rawPosition) {
          throw createError(ErrorCode.NOT_FOUND, `No position found for ${symbol}`);
        }

        const currentSize = Math.abs(parseNumber(rawPosition.pos, 0));
        const closeSize = qty ?? (percentage !== undefined ? currentSize * (percentage / 100) : currentSize);

        if (closeSize <= 0) {
          throw createError(ErrorCode.INVALID_INPUT, `Cannot close position with size ${closeSize}`);
        }

        const side: "buy" | "sell" =
          rawPosition.posSide === "short" || parseNumber(rawPosition.pos, 0) < 0 ? "buy" : "sell";
        const tdMode: OkxTradeMode =
          rawPosition.instType === "SPOT" ? "cash" : rawPosition.mgnMode === "isolated" ? "isolated" : "cross";

        return await placeOrderRequest({
          instId,
          tdMode,
          side,
          ordType: "market",
          sz: String(closeSize),
          posSide: rawPosition.posSide === "net" ? undefined : rawPosition.posSide,
          reduceOnly: rawPosition.instType !== "SPOT",
        });
      } catch (error) {
        client.logger.error("Failed to close position", error, { symbol, qty, percentage });
        throw handleOkxError(error);
      }
    },

    async createOrder(params: OrderParams): Promise<Order> {
      try {
        const request = mapOrderParamsToOkxOrderRequest(params, defaultQuoteCcy);
        return await placeOrderRequest(request);
      } catch (error) {
        client.logger.error("Failed to create order", error, {
          symbol: params.symbol,
          side: params.side,
          type: params.type,
        });
        throw handleOkxError(error);
      }
    },

    async placeOrder(params: OkxPlaceOrderParams): Promise<Order> {
      try {
        const request: OrderRequest = {
          instId: toInstId(params.instId),
          side: params.side,
          ordType: params.ordType ?? "market",
          tdMode: params.tdMode ?? (params.instType === "SPOT" ? "cash" : "cross"),
          sz: String(params.sz),
          ccy: params.ccy,
          clOrdId: params.clOrdId,
          tag: params.tag,
          posSide: params.posSide,
          reduceOnly: params.reduceOnly,
          tgtCcy: params.tgtCcy,
        };

        if (params.px !== undefined) {
          request.px = String(params.px);
        }

        return await placeOrderRequest(request);
      } catch (error) {
        client.logger.error("Failed to place advanced order", error, {
          instId: params.instId,
          side: params.side,
          ordType: params.ordType,
          instType: params.instType,
        });
        throw handleOkxError(error);
      }
    },

    async placeSpotOrder(params): Promise<Order> {
      return this.placeOrder({
        ...params,
        instType: "SPOT",
        tdMode: params.tdMode ?? "cash",
      });
    },

    async placeMarginOrder(params): Promise<Order> {
      return this.placeOrder({
        ...params,
        instType: "MARGIN",
        tdMode: params.tdMode ?? "cross",
      });
    },

    async placeFuturesOrder(params): Promise<Order> {
      return this.placeOrder({
        ...params,
        instType: params.instType ?? "SWAP",
        tdMode: params.tdMode ?? "cross",
      });
    },

    async placeOptionOrder(params): Promise<Order> {
      return this.placeOrder({
        ...params,
        instType: "OPTION",
        tdMode: params.tdMode ?? "isolated",
      });
    },

    async getOrder(orderId: string): Promise<Order> {
      try {
        const instId = await resolveInstrumentForOrder(orderId);
        return await this.getOrderById({
          instId,
          ...resolveOrderIdentifier(orderId),
        });
      } catch (error) {
        client.logger.error("Failed to fetch order", error, { orderId });
        throw handleOkxError(error);
      }
    },

    async getOrderById(params: OkxOrderByIdParams): Promise<Order> {
      try {
        if (!params.ordId && !params.clOrdId) {
          throw createError(ErrorCode.INVALID_INPUT, "getOrderById requires ordId or clOrdId");
        }

        const details = await client.rest.getOrderDetails({
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });

        const first = details[0];
        if (!first) {
          throw createError(ErrorCode.NOT_FOUND, `Order not found for instrument ${params.instId}`);
        }

        rememberOrderInstrument(first.ordId, first.instId);
        return parseOrder(first);
      } catch (error) {
        client.logger.error("Failed to fetch order by id", error, {
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });
        throw handleOkxError(error);
      }
    },

    async listOrders(params?: ListOrdersParams): Promise<Order[]> {
      try {
        const includeOpen = params?.status !== "closed";
        const includeClosed = params?.status !== "open";
        const limit = String(params?.limit ?? 100);

        const dedup = new Map<string, Order>();

        for (const instType of SUPPORTED_INST_TYPES) {
          if (includeOpen) {
            const openOrders = await client.rest.getOrderList({
              instType,
              limit,
              after: params?.after,
              before: params?.until,
            } as OrderHistoryRequest);

            for (const order of openOrders) {
              rememberOrderInstrument(order.ordId, order.instId);
              dedup.set(order.ordId, parseOrder(order));
            }
          }

          if (includeClosed) {
            const historyOrders = await client.rest.getOrderHistory({
              instType,
              limit,
              after: params?.after,
              before: params?.until,
            } as OrderHistoryRequest);

            for (const order of historyOrders) {
              rememberOrderInstrument(order.ordId, order.instId);
              dedup.set(order.ordId, parseOrder(order));
            }
          }
        }

        let orders = Array.from(dedup.values());

        if (params?.symbols && params.symbols.length > 0) {
          const symbols = new Set(params.symbols.map((symbol) => symbol.toUpperCase()));
          orders = orders.filter((order) => symbols.has(order.symbol.toUpperCase()));
        }

        if (params?.direction === "asc") {
          orders.sort((a, b) => a.created_at.localeCompare(b.created_at));
        } else {
          orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
        }

        if (params?.limit) {
          orders = orders.slice(0, params.limit);
        }

        return orders;
      } catch (error) {
        client.logger.error("Failed to list orders", error, { params: params as unknown as Record<string, unknown> });
        throw handleOkxError(error);
      }
    },

    async listOrdersByInstrumentType(instType: InstrumentType, params?: ListOrdersParams): Promise<Order[]> {
      try {
        const includeOpen = params?.status !== "closed";
        const includeClosed = params?.status !== "open";
        const limit = String(params?.limit ?? 100);
        const orders: Order[] = [];

        if (includeOpen) {
          const openOrders = await client.rest.getOrderList({
            instType,
            limit,
            after: params?.after,
            before: params?.until,
          } as OrderHistoryRequest);

          for (const order of openOrders) {
            rememberOrderInstrument(order.ordId, order.instId);
            orders.push(parseOrder(order));
          }
        }

        if (includeClosed) {
          const historyOrders = await client.rest.getOrderHistory({
            instType,
            limit,
            after: params?.after,
            before: params?.until,
          } as OrderHistoryRequest);

          for (const order of historyOrders) {
            rememberOrderInstrument(order.ordId, order.instId);
            orders.push(parseOrder(order));
          }
        }

        return orders;
      } catch (error) {
        client.logger.error("Failed to list orders by instrument type", error, { instType });
        throw handleOkxError(error);
      }
    },

    async cancelOrder(orderId: string): Promise<void> {
      try {
        const instId = await resolveInstrumentForOrder(orderId);
        await this.cancelOrderById({
          instId,
          ...resolveOrderIdentifier(orderId),
        });
      } catch (error) {
        client.logger.error("Failed to cancel order", error, { orderId });
        throw handleOkxError(error);
      }
    },

    async cancelOrderById(params: OkxOrderByIdParams): Promise<void> {
      try {
        if (!params.ordId && !params.clOrdId) {
          throw createError(ErrorCode.INVALID_INPUT, "cancelOrderById requires ordId or clOrdId");
        }

        await client.rest.cancelOrder({
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });

        if (params.ordId) {
          orderInstrumentCache.delete(params.ordId);
        }
      } catch (error) {
        client.logger.error("Failed to cancel order by id", error, {
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });
        throw handleOkxError(error);
      }
    },

    async cancelAllOrders(): Promise<void> {
      try {
        const openOrders = await this.listOrders({ status: "open", limit: 200 });
        await Promise.all(
          openOrders.map(async (order) => {
            try {
              await this.cancelOrderById({ instId: order.symbol, ordId: order.id });
            } catch (error) {
              client.logger.warn("Failed to cancel order during cancelAllOrders", {
                orderId: order.id,
                symbol: order.symbol,
                error: String(error),
              });
            }
          })
        );
      } catch (error) {
        client.logger.error("Failed to cancel all orders", error);
        throw handleOkxError(error);
      }
    },

    async getClock(): Promise<MarketClock> {
      return {
        timestamp: new Date().toISOString(),
        is_open: true,
        next_open: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        next_close: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    },

    async getCalendar(_start: string, _end: string): Promise<MarketDay[]> {
      return [];
    },

    async getAsset(symbol: string): Promise<Asset | null> {
      try {
        const instId = toInstId(symbol);
        for (const instType of SUPPORTED_INST_TYPES) {
          const instruments = await client.rest.getInstruments({ instType, instId });
          const matched: Instrument | undefined = instruments.find((instrument) => instrument.instId === instId);

          if (matched) {
            return {
              id: matched.instId,
              class: mapInstTypeForAsset(matched.instType),
              exchange: "OKX",
              symbol: matched.instId,
              name: matched.instId,
              status: matched.state === "live" ? "active" : "inactive",
              tradable: matched.state === "live",
              marginable: matched.instType === "MARGIN" || matched.instType === "SPOT",
              shortable: matched.instType !== "SPOT",
              fractionable: parseNumber(matched.minSz, 1) < 1,
            };
          }
        }

        return null;
      } catch (error) {
        client.logger.error("Failed to get asset", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async getPortfolioHistory(_params?: PortfolioHistoryParams): Promise<PortfolioHistory> {
      try {
        const account = await this.getAccount();
        const now = Date.now();

        return {
          timestamp: [Math.floor(now / 1000)],
          equity: [account.equity],
          profit_loss: [0],
          profit_loss_pct: [0],
          base_value: account.equity,
          timeframe: "1D",
        };
      } catch (error) {
        client.logger.error("Failed to build portfolio history", error);
        throw handleOkxError(error);
      }
    },

    async getBalances(ccy?: string): Promise<AccountBalance[]> {
      try {
        return client.rest.getBalance(ccy ? { ccy } : undefined);
      } catch (error) {
        client.logger.error("Failed to get balances", error, { ccy });
        throw handleOkxError(error);
      }
    },

    async getTransactionHistory(params?: OkxTransactionHistoryParams): Promise<AccountBill[]> {
      try {
        const query = {
          ccy: params?.ccy,
          instType: params?.instType,
          type: params?.type,
          subType: params?.subType,
          after: params?.after,
          before: params?.before,
          begin: params?.begin,
          end: params?.end,
          limit: params?.limit ? String(params.limit) : undefined,
        };

        if (params?.archive) {
          return client.rest.getBillsArchive(query);
        }

        return client.rest.getBills(query);
      } catch (error) {
        client.logger.error("Failed to get transaction history", error, {
          archive: params?.archive,
          ccy: params?.ccy,
          instType: params?.instType,
        });
        throw handleOkxError(error);
      }
    },

    async getFills(params?: OkxFillsParams): Promise<OrderFill[]> {
      try {
        const query = {
          ...params,
          limit: params?.limit ? String(params.limit) : undefined,
        };

        if (params?.archive) {
          return client.rest.getFillsHistory(query);
        }

        return client.rest.getFills(query);
      } catch (error) {
        client.logger.error("Failed to get fills", error, {
          archive: params?.archive,
          instType: params?.instType,
        });
        throw handleOkxError(error);
      }
    },

    async setLeverage(params: {
      lever: string;
      mgnMode: "cross" | "isolated";
      instId?: string;
      ccy?: string;
      posSide?: PositionSide;
    }): Promise<AccountLeverageResult[]> {
      try {
        const leveragePosSide = params.posSide === "long" || params.posSide === "short" ? params.posSide : undefined;

        return client.rest.setLeverage({
          lever: params.lever,
          mgnMode: params.mgnMode,
          instId: params.instId,
          ccy: params.ccy,
          posSide: leveragePosSide,
        });
      } catch (error) {
        client.logger.error("Failed to set leverage", error, {
          mgnMode: params.mgnMode,
          instId: params.instId,
          ccy: params.ccy,
        });
        throw handleOkxError(error);
      }
    },
  };
}
