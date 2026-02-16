import type { WsChannelSubUnSubRequestArg, WsPublicKlineChannel } from "okx-api";
import type { OkxClient } from "./client";
import { handleOkxError } from "./client";

export interface WebSocketEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

export interface WebSocketSubscription {
  key: string;
  arg: WsChannelSubUnSubRequestArg;
  callback?: (data: unknown) => void;
}

export interface OkxWebSocketProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  subscribeTicker(symbol: string, callback: (data: unknown) => void): Promise<void>;
  unsubscribeTicker(symbol: string): Promise<void>;

  subscribeOrderBook(symbol: string, depth?: number, callback?: (data: unknown) => void): Promise<void>;
  unsubscribeOrderBook(symbol: string): Promise<void>;

  subscribeTrades(symbol: string, callback: (data: unknown) => void): Promise<void>;
  unsubscribeTrades(symbol: string): Promise<void>;

  subscribeCandles(symbol: string, timeframe: string, callback: (data: unknown) => void): Promise<void>;
  unsubscribeCandles(symbol: string, timeframe: string): Promise<void>;

  subscribeAccountUpdates(callback: (data: unknown) => void): Promise<void>;
  unsubscribeAccountUpdates(): Promise<void>;

  subscribeOrders(callback: (data: unknown) => void): Promise<void>;
  unsubscribeOrders(): Promise<void>;

  subscribePositions(callback: (data: unknown) => void): Promise<void>;
  unsubscribePositions(): Promise<void>;

  on(event: string, callback: (data: WebSocketEvent) => void): void;
  off(event: string, callback: (data: WebSocketEvent) => void): void;
}

function getSubscriptionKey(arg: WsChannelSubUnSubRequestArg): string {
  const base = arg.channel;
  if ("instId" in arg && arg.instId) {
    return `${base}|instId:${arg.instId}`;
  }
  if ("instFamily" in arg && arg.instFamily) {
    return `${base}|instFamily:${arg.instFamily}`;
  }
  return `${base}|global`;
}

function mapCandleChannel(timeframe: string): WsPublicKlineChannel {
  if (timeframe.startsWith("candle")) {
    return timeframe as WsPublicKlineChannel;
  }

  switch (timeframe) {
    case "1m":
      return "candle1m";
    case "3m":
      return "candle3m";
    case "5m":
      return "candle5m";
    case "15m":
      return "candle15m";
    case "30m":
      return "candle30m";
    case "1h":
      return "candle1H";
    case "2h":
      return "candle2H";
    case "4h":
      return "candle4H";
    case "6h":
      return "candle6H";
    case "12h":
      return "candle12H";
    case "1d":
      return "candle1D";
    case "1w":
      return "candle1W";
    case "1M":
      return "candle1M";
    default:
      return "candle1m";
  }
}

function mapBooksChannel(depth: number): "books" | "books5" | "books50-l2-tpt" {
  if (depth <= 5) {
    return "books5";
  }

  if (depth <= 50) {
    return "books50-l2-tpt";
  }

  return "books";
}

export function createOkxWebSocketProvider(client: OkxClient): OkxWebSocketProvider {
  const wsClient = client.ws;
  const eventListeners = new Map<string, Set<(data: WebSocketEvent) => void>>();
  const subscriptions = new Map<string, WebSocketSubscription>();

  const emit = (type: string, data: unknown) => {
    const listeners = eventListeners.get(type);
    if (!listeners || listeners.size === 0) {
      return;
    }

    const event: WebSocketEvent = {
      type,
      data,
      timestamp: Date.now(),
    };

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        client.logger.error("Error in websocket event listener", error, { type });
      }
    }
  };

  wsClient.on("open", (event) => {
    emit("open", event);
  });

  wsClient.on("close", (event) => {
    emit("close", event);
  });

  wsClient.on("response", (event) => {
    emit("response", event);
  });

  wsClient.on("authenticated", (event) => {
    emit("authenticated", event);
  });

  wsClient.on("reconnect", (event) => {
    emit("reconnect", event);
  });

  wsClient.on("reconnected", (event) => {
    emit("reconnected", event);
  });

  wsClient.on("exception", (event) => {
    emit("exception", event);
  });

  wsClient.on("update", (event) => {
    emit("update", event);

    const arg = (event as { arg?: WsChannelSubUnSubRequestArg }).arg;
    if (!arg) {
      return;
    }

    const subscriptionKey = getSubscriptionKey(arg);
    const subscription = subscriptions.get(subscriptionKey);
    if (subscription?.callback) {
      try {
        subscription.callback(event);
      } catch (error) {
        client.logger.error("Error in websocket subscription callback", error, { subscriptionKey });
      }
    }
  });

  const subscribe = async (arg: WsChannelSubUnSubRequestArg, callback?: (data: unknown) => void): Promise<void> => {
    const key = getSubscriptionKey(arg);
    await Promise.all(wsClient.subscribe(arg));
    subscriptions.set(key, {
      key,
      arg,
      callback,
    });
  };

  const unsubscribe = async (arg: WsChannelSubUnSubRequestArg): Promise<void> => {
    const key = getSubscriptionKey(arg);
    await Promise.all(wsClient.unsubscribe(arg));
    subscriptions.delete(key);
  };

  return {
    async connect(): Promise<void> {
      try {
        await Promise.all(wsClient.connectAll());
      } catch (error) {
        client.logger.error("Failed to connect websocket client", error);
        throw handleOkxError(error);
      }
    },

    async disconnect(): Promise<void> {
      try {
        wsClient.closeAll();
        subscriptions.clear();
      } catch (error) {
        client.logger.error("Failed to disconnect websocket client", error);
        throw handleOkxError(error);
      }
    },

    isConnected(): boolean {
      const store = wsClient.getWsStore();
      const keys = store.getKeys();
      return keys.some((key) => wsClient.isConnected(key));
    },

    async subscribeTicker(symbol: string, callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: "tickers", instId: symbol }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe ticker", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async unsubscribeTicker(symbol: string): Promise<void> {
      try {
        await unsubscribe({ channel: "tickers", instId: symbol });
      } catch (error) {
        client.logger.error("Failed to unsubscribe ticker", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async subscribeOrderBook(symbol: string, depth: number = 5, callback?: (data: unknown) => void): Promise<void> {
      try {
        const channel = mapBooksChannel(depth);
        await subscribe({ channel, instId: symbol }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe order book", error, { symbol, depth });
        throw handleOkxError(error);
      }
    },

    async unsubscribeOrderBook(symbol: string): Promise<void> {
      try {
        await Promise.all([
          unsubscribe({ channel: "books5", instId: symbol }),
          unsubscribe({ channel: "books50-l2-tpt", instId: symbol }),
          unsubscribe({ channel: "books", instId: symbol }),
        ]);
      } catch (error) {
        client.logger.error("Failed to unsubscribe order book", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async subscribeTrades(symbol: string, callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: "trades", instId: symbol }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe trades", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async unsubscribeTrades(symbol: string): Promise<void> {
      try {
        await unsubscribe({ channel: "trades", instId: symbol });
      } catch (error) {
        client.logger.error("Failed to unsubscribe trades", error, { symbol });
        throw handleOkxError(error);
      }
    },

    async subscribeCandles(symbol: string, timeframe: string, callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: mapCandleChannel(timeframe), instId: symbol }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe candles", error, { symbol, timeframe });
        throw handleOkxError(error);
      }
    },

    async unsubscribeCandles(symbol: string, timeframe: string): Promise<void> {
      try {
        await unsubscribe({ channel: mapCandleChannel(timeframe), instId: symbol });
      } catch (error) {
        client.logger.error("Failed to unsubscribe candles", error, { symbol, timeframe });
        throw handleOkxError(error);
      }
    },

    async subscribeAccountUpdates(callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: "account" }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe account updates", error);
        throw handleOkxError(error);
      }
    },

    async unsubscribeAccountUpdates(): Promise<void> {
      try {
        await unsubscribe({ channel: "account" });
      } catch (error) {
        client.logger.error("Failed to unsubscribe account updates", error);
        throw handleOkxError(error);
      }
    },

    async subscribeOrders(callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: "orders", instType: "ANY" }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe order updates", error);
        throw handleOkxError(error);
      }
    },

    async unsubscribeOrders(): Promise<void> {
      try {
        await unsubscribe({ channel: "orders", instType: "ANY" });
      } catch (error) {
        client.logger.error("Failed to unsubscribe order updates", error);
        throw handleOkxError(error);
      }
    },

    async subscribePositions(callback: (data: unknown) => void): Promise<void> {
      try {
        await subscribe({ channel: "positions", instType: "ANY" }, callback);
      } catch (error) {
        client.logger.error("Failed to subscribe position updates", error);
        throw handleOkxError(error);
      }
    },

    async unsubscribePositions(): Promise<void> {
      try {
        await unsubscribe({ channel: "positions", instType: "ANY" });
      } catch (error) {
        client.logger.error("Failed to unsubscribe position updates", error);
        throw handleOkxError(error);
      }
    },

    on(event: string, callback: (data: WebSocketEvent) => void): void {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, new Set());
      }
      eventListeners.get(event)?.add(callback);
    },

    off(event: string, callback: (data: WebSocketEvent) => void): void {
      const listeners = eventListeners.get(event);
      if (!listeners) {
        return;
      }

      listeners.delete(callback);
      if (listeners.size === 0) {
        eventListeners.delete(event);
      }
    },
  };
}
