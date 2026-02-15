import type {
  AccountPosition,
  Candle,
  Instrument,
  OrderBook,
  OrderDetails,
  OrderHistoryRequest,
  OrderRequest,
  OrderResult,
  OptionTrades,
  PositionSide,
  Ticker,
} from "okx-api";
import type { OptionContract, OptionSnapshot, OptionsChain, OptionsProvider, Order } from "../types";
import type { OkxClient } from "./client";
import { handleOkxError } from "./client";

function toIsoTimestamp(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (/^\d+$/.test(value)) {
    return new Date(Number.parseInt(value, 10)).toISOString();
  }

  return value;
}

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

function normalizeExpiry(value: string): string {
  if (/^\d+$/.test(value)) {
    const [date] = new Date(Number.parseInt(value, 10)).toISOString().split("T");
    return date ?? value;
  }
  if (value.includes("T")) {
    const [date] = value.split("T");
    return date ?? value;
  }
  return value;
}

function mapOptionContract(instrument: Instrument): OptionContract {
  return {
    symbol: instrument.instId,
    underlying: instrument.uly || instrument.instFamily || instrument.instId,
    expiration: normalizeExpiry(instrument.expTime),
    strike: parseNumber(instrument.stk, 0),
    type: instrument.optType === "P" ? "put" : "call",
    open_interest: 0,
    volume: 0,
  };
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
  if (ordType === "fok") {
    return "fok";
  }
  if (ordType === "ioc" || ordType === "market") {
    return "ioc";
  }
  return "gtc";
}

function parseOptionOrder(raw: Partial<OrderDetails> & { ordId: string; instId: string }): Order {
  return {
    id: raw.ordId,
    client_order_id: raw.clOrdId ?? "",
    symbol: raw.instId,
    asset_id: raw.instId,
    asset_class: "crypto",
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
    canceled_at: raw.state === "canceled" ? toIsoTimestamp(raw.uTime) : null,
    failed_at: null,
  };
}

function parseOptionOrderResult(result: OrderResult, request: OrderRequest): Order {
  return {
    id: result.ordId,
    client_order_id: result.clOrdId ?? request.clOrdId ?? "",
    symbol: request.instId,
    asset_id: request.instId,
    asset_class: "crypto",
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
    status: result.sCode === "0" ? "accepted" : "rejected",
    extended_hours: false,
    created_at: toIsoTimestamp(result.ts),
    updated_at: toIsoTimestamp(result.ts),
    submitted_at: toIsoTimestamp(result.ts),
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: result.sCode === "0" ? null : toIsoTimestamp(result.ts),
  };
}

export interface OptionOrderParams {
  instId: string;
  side: "buy" | "sell";
  ordType?: "market" | "limit" | "post_only" | "fok" | "ioc";
  sz: string | number;
  px?: string | number;
  pxUsd?: string;
  pxVol?: string;
  tdMode?: "cross" | "isolated";
  posSide?: PositionSide;
  reduceOnly?: boolean;
  ccy?: string;
  clOrdId?: string;
  tag?: string;
}

export interface OptionOrderListParams {
  uly?: string;
  instId?: string;
  ordType?: string;
  state?: string;
  after?: string;
  before?: string;
  limit?: number;
  includeHistory?: boolean;
}

export interface OkxOptionsProvider extends OptionsProvider {
  getOptionsChain(underlying: string, expiry?: string): Promise<Instrument[]>;
  getOptionDetails(instId: string): Promise<Instrument | null>;
  getOptionTicker(instId: string): Promise<Ticker | null>;
  getOptionOrderBook(instId: string, depth?: number): Promise<OrderBook | null>;
  getOptionTrades(params: { instId?: string; instFamily?: string; optType?: "C" | "P" }): Promise<OptionTrades[]>;
  getOptionCandles(instId: string, timeframe: string, limit?: number): Promise<Candle[]>;
  getOptionPositions(instId?: string): Promise<AccountPosition[]>;

  placeOptionOrder(params: OptionOrderParams): Promise<Order>;
  cancelOptionOrder(params: { instId: string; ordId?: string; clOrdId?: string }): Promise<void>;
  getOptionOrder(params: { instId: string; ordId?: string; clOrdId?: string }): Promise<Order>;
  listOptionOrders(params?: OptionOrderListParams): Promise<Order[]>;
}

export function createOkxOptionsProvider(client: OkxClient): OkxOptionsProvider {
  const orderInstrumentCache = new Map<string, string>();

  const rememberOrder = (ordId: string | undefined, instId: string | undefined) => {
    if (ordId && instId) {
      orderInstrumentCache.set(ordId, instId);
    }
  };

  return {
    isConfigured(): boolean {
      return Boolean(client.config.apiKey && client.config.apiSecret && client.config.apiPass);
    },

    async getOptionsChain(underlying: string, expiry?: string): Promise<Instrument[]> {
      try {
        const instruments = await client.rest.getInstruments({
          instType: "OPTION",
          uly: underlying,
        });

        if (!expiry) {
          return instruments;
        }

        return instruments.filter((instrument) => instrument.expTime.startsWith(expiry));
      } catch (error) {
        client.logger.error("Failed to fetch options chain", error, { underlying, expiry });
        throw handleOkxError(error);
      }
    },

    async getExpirations(underlying: string): Promise<string[]> {
      const chain = await this.getOptionsChain(underlying);
      const expirations = new Set(chain.map((instrument) => normalizeExpiry(instrument.expTime)));
      return Array.from(expirations).sort();
    },

    async getChain(underlying: string, expiration: string): Promise<OptionsChain> {
      const instruments = await this.getOptionsChain(underlying, expiration);
      const calls: OptionContract[] = [];
      const puts: OptionContract[] = [];

      for (const instrument of instruments) {
        const contract = mapOptionContract(instrument);
        if (contract.type === "call") {
          calls.push(contract);
        } else {
          puts.push(contract);
        }
      }

      calls.sort((a, b) => a.strike - b.strike);
      puts.sort((a, b) => a.strike - b.strike);

      return {
        symbol: underlying.toUpperCase(),
        expiration,
        calls,
        puts,
      };
    },

    async getSnapshot(contractSymbol: string): Promise<OptionSnapshot> {
      const ticker = await this.getOptionTicker(contractSymbol);

      if (!ticker) {
        return {
          symbol: contractSymbol,
          latest_quote: {
            bid_price: 0,
            bid_size: 0,
            ask_price: 0,
            ask_size: 0,
          },
        };
      }

      return {
        symbol: contractSymbol,
        latest_quote: {
          bid_price: parseNumber(ticker.bidPx, 0),
          bid_size: parseNumber(ticker.bidSz, 0),
          ask_price: parseNumber(ticker.askPx, 0),
          ask_size: parseNumber(ticker.askSz, 0),
        },
      };
    },

    async getSnapshots(contractSymbols: string[]): Promise<Record<string, OptionSnapshot>> {
      const snapshots = await Promise.all(
        contractSymbols.map(async (symbol) => {
          try {
            const snapshot = await this.getSnapshot(symbol);
            return [symbol, snapshot] as const;
          } catch (error) {
            client.logger.warn("Skipping option snapshot for symbol", {
              symbol,
              error: String(error),
            });
            return null;
          }
        })
      );

      return snapshots.reduce<Record<string, OptionSnapshot>>((acc, entry) => {
        if (entry) {
          acc[entry[0]] = entry[1];
        }
        return acc;
      }, {});
    },

    async getOptionDetails(instId: string): Promise<Instrument | null> {
      try {
        const instruments = await client.rest.getInstruments({
          instType: "OPTION",
          instId,
        });

        return instruments[0] ?? null;
      } catch (error) {
        client.logger.error("Failed to fetch option details", error, { instId });
        throw handleOkxError(error);
      }
    },

    async getOptionTicker(instId: string): Promise<Ticker | null> {
      try {
        const tickers = await client.rest.getTicker({ instId });
        return tickers[0] ?? null;
      } catch (error) {
        client.logger.error("Failed to fetch option ticker", error, { instId });
        throw handleOkxError(error);
      }
    },

    async getOptionOrderBook(instId: string, depth: number = 20): Promise<OrderBook | null> {
      try {
        const books = await client.rest.getOrderBook({
          instId,
          sz: String(depth),
        });

        return books[0] ?? null;
      } catch (error) {
        client.logger.error("Failed to fetch option order book", error, { instId, depth });
        throw handleOkxError(error);
      }
    },

    async getOptionTrades(params: {
      instId?: string;
      instFamily?: string;
      optType?: "C" | "P";
    }): Promise<OptionTrades[]> {
      try {
        return client.rest.getOptionTrades({
          instId: params.instId,
          instFamily: params.instFamily,
          optType: params.optType,
        });
      } catch (error) {
        client.logger.error("Failed to fetch option trades", error, {
          instId: params.instId,
          instFamily: params.instFamily,
          optType: params.optType,
        });
        throw handleOkxError(error);
      }
    },

    async getOptionCandles(instId: string, timeframe: string, limit: number = 100): Promise<Candle[]> {
      try {
        return client.rest.getCandles({
          instId,
          bar: timeframe,
          limit: String(limit),
        });
      } catch (error) {
        client.logger.error("Failed to fetch option candles", error, { instId, timeframe, limit });
        throw handleOkxError(error);
      }
    },

    async getOptionPositions(instId?: string): Promise<AccountPosition[]> {
      try {
        return client.rest.getPositions({
          instType: "OPTION",
          instId,
        });
      } catch (error) {
        client.logger.error("Failed to fetch option positions", error, { instId });
        throw handleOkxError(error);
      }
    },

    async placeOptionOrder(params: OptionOrderParams): Promise<Order> {
      try {
        const request: OrderRequest = {
          instId: params.instId,
          side: params.side,
          ordType: params.ordType ?? "limit",
          tdMode: params.tdMode ?? "isolated",
          sz: String(params.sz),
          px: params.px !== undefined ? String(params.px) : undefined,
          pxUsd: params.pxUsd,
          pxVol: params.pxVol,
          posSide: params.posSide,
          reduceOnly: params.reduceOnly,
          ccy: params.ccy,
          clOrdId: params.clOrdId,
          tag: params.tag,
        };

        const result = await client.rest.submitOrder(request);
        const first = result[0];
        if (!first) {
          throw new Error("No option order response payload");
        }

        rememberOrder(first.ordId, params.instId);

        if (first.sCode !== "0" && first.sCode !== "") {
          handleOkxError({
            code: first.sCode,
            msg: first.sMsg || "Option order rejected",
          });
        }

        try {
          const details = await client.rest.getOrderDetails({
            instId: params.instId,
            ordId: first.ordId,
          });
          const detail = details[0];
          if (detail) {
            return parseOptionOrder(detail);
          }
        } catch (error) {
          client.logger.debug("Failed to hydrate option order after submission", {
            instId: params.instId,
            orderId: first.ordId,
            error: String(error),
          });
        }

        return parseOptionOrderResult(first, request);
      } catch (error) {
        client.logger.error("Failed to place option order", error, {
          instId: params.instId,
          side: params.side,
          ordType: params.ordType,
        });
        throw handleOkxError(error);
      }
    },

    async cancelOptionOrder(params: { instId: string; ordId?: string; clOrdId?: string }): Promise<void> {
      try {
        if (!params.ordId && !params.clOrdId) {
          throw new Error("ordId or clOrdId is required to cancel option order");
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
        client.logger.error("Failed to cancel option order", error, {
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });
        throw handleOkxError(error);
      }
    },

    async getOptionOrder(params: { instId: string; ordId?: string; clOrdId?: string }): Promise<Order> {
      try {
        if (!params.ordId && !params.clOrdId) {
          throw new Error("ordId or clOrdId is required to query option order");
        }

        const details = await client.rest.getOrderDetails({
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });

        const first = details[0];
        if (!first) {
          throw new Error(`Option order not found for ${params.instId}`);
        }

        rememberOrder(first.ordId, first.instId);
        return parseOptionOrder(first);
      } catch (error) {
        client.logger.error("Failed to fetch option order", error, {
          instId: params.instId,
          ordId: params.ordId,
          clOrdId: params.clOrdId,
        });
        throw handleOkxError(error);
      }
    },

    async listOptionOrders(params?: OptionOrderListParams): Promise<Order[]> {
      try {
        const limit = String(params?.limit ?? 100);
        const orders: Order[] = [];

        const openOrders = await client.rest.getOrderList({
          instType: "OPTION",
          uly: params?.uly,
          instId: params?.instId,
          ordType: params?.ordType as OrderRequest["ordType"] | undefined,
          state: params?.state,
          after: params?.after,
          before: params?.before,
          limit,
        } as OrderHistoryRequest);

        for (const order of openOrders) {
          rememberOrder(order.ordId, order.instId);
          orders.push(parseOptionOrder(order));
        }

        if (params?.includeHistory) {
          const historyOrders = await client.rest.getOrderHistory({
            instType: "OPTION",
            uly: params.uly,
            instId: params.instId,
            ordType: params.ordType as OrderRequest["ordType"] | undefined,
            state: params.state,
            after: params.after,
            before: params.before,
            limit,
          } as OrderHistoryRequest);

          for (const order of historyOrders) {
            rememberOrder(order.ordId, order.instId);
            orders.push(parseOptionOrder(order));
          }
        }

        return orders;
      } catch (error) {
        client.logger.error("Failed to list option orders", error, {
          instId: params?.instId,
          uly: params?.uly,
        });
        throw handleOkxError(error);
      }
    },
  };
}
