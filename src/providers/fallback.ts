import { ErrorCode } from "../lib/errors";
import type { BrokerProviders } from "./broker-factory";
import type { BrokerProvider, MarketDataProvider, OptionsProvider, Order } from "./types";

export interface BrokerFallbackConfig {
  allowTradingFallback: boolean;
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function shouldFallback(error: unknown): boolean {
  const code = getErrorCode(error);
  if (!code) {
    const message = String(error instanceof Error ? error.message : (error ?? ""));
    const name = error instanceof Error ? error.name : "";
    if (/\b(timeout|network|fetch failed)\b/i.test(message)) return true;
    if (error instanceof TypeError && /\b(fetch|network)\b/i.test(message)) return true;
    return /\b(fetcherror|aborterror)\b/i.test(name);
  }

  return code === ErrorCode.RATE_LIMITED || code === ErrorCode.PROVIDER_ERROR || code === ErrorCode.NOT_SUPPORTED;
}

async function withFallback<T>(
  method: string,
  primaryBroker: string,
  fallbackBroker: string,
  allowFallback: boolean,
  primaryCall: () => Promise<T>,
  fallbackCall: () => Promise<T>
): Promise<T> {
  try {
    return await primaryCall();
  } catch (primaryError) {
    if (!allowFallback || !shouldFallback(primaryError)) {
      throw primaryError;
    }

    console.warn("[broker-fallback] primary call failed, invoking fallback", {
      method,
      primary: primaryBroker,
      fallback: fallbackBroker,
      error: String(primaryError),
      errorCode: getErrorCode(primaryError),
    });
    try {
      return await fallbackCall();
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError],
        `[broker-fallback] both primary and fallback failed for ${method}`
      );
    }
  }
}

function annotateOrderBrokerProvider(order: Order, brokerProvider: string): Order {
  return { ...order, broker_provider: brokerProvider };
}

function createTradingWithFallback(
  primaryBroker: string,
  fallbackBroker: string,
  primary: BrokerProvider,
  fallback: BrokerProvider,
  config: BrokerFallbackConfig
): BrokerProvider {
  return {
    getAccount: () =>
      withFallback(
        "trading.getAccount",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getAccount(),
        () => fallback.getAccount()
      ),
    getPositions: () =>
      withFallback(
        "trading.getPositions",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getPositions(),
        () => fallback.getPositions()
      ),
    getPosition: (symbol) =>
      withFallback(
        "trading.getPosition",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getPosition(symbol),
        () => fallback.getPosition(symbol)
      ),
    // WARNING: mutating operations are unsafe to fallback unless both brokers share identical order state.
    closePosition: (symbol, qty, percentage) =>
      withFallback(
        "trading.closePosition",
        primaryBroker,
        fallbackBroker,
        config.allowTradingFallback,
        async () => annotateOrderBrokerProvider(await primary.closePosition(symbol, qty, percentage), primaryBroker),
        async () => annotateOrderBrokerProvider(await fallback.closePosition(symbol, qty, percentage), fallbackBroker)
      ),
    createOrder: (params) =>
      withFallback(
        "trading.createOrder",
        primaryBroker,
        fallbackBroker,
        config.allowTradingFallback,
        async () => annotateOrderBrokerProvider(await primary.createOrder(params), primaryBroker),
        async () => annotateOrderBrokerProvider(await fallback.createOrder(params), fallbackBroker)
      ),
    getOrder: (orderId) =>
      withFallback(
        "trading.getOrder",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getOrder(orderId),
        () => fallback.getOrder(orderId)
      ),
    listOrders: (params) =>
      withFallback(
        "trading.listOrders",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.listOrders(params),
        () => fallback.listOrders(params)
      ),
    // WARNING: mutating operations are unsafe to fallback unless both brokers share identical order state.
    cancelOrder: (orderId) =>
      withFallback(
        "trading.cancelOrder",
        primaryBroker,
        fallbackBroker,
        config.allowTradingFallback,
        () => primary.cancelOrder(orderId),
        () => fallback.cancelOrder(orderId)
      ),
    cancelAllOrders: () =>
      withFallback(
        "trading.cancelAllOrders",
        primaryBroker,
        fallbackBroker,
        config.allowTradingFallback,
        () => primary.cancelAllOrders(),
        () => fallback.cancelAllOrders()
      ),
    getClock: () =>
      withFallback(
        "trading.getClock",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getClock(),
        () => fallback.getClock()
      ),
    getCalendar: (start, end) =>
      withFallback(
        "trading.getCalendar",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getCalendar(start, end),
        () => fallback.getCalendar(start, end)
      ),
    getAsset: (symbol) =>
      withFallback(
        "trading.getAsset",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getAsset(symbol),
        () => fallback.getAsset(symbol)
      ),
    getPortfolioHistory: (params) =>
      withFallback(
        "trading.getPortfolioHistory",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getPortfolioHistory(params),
        () => fallback.getPortfolioHistory(params)
      ),
  };
}

function createMarketDataWithFallback(
  primaryBroker: string,
  fallbackBroker: string,
  primary: MarketDataProvider,
  fallback: MarketDataProvider
): MarketDataProvider {
  return {
    getBars: (symbol, timeframe, params) =>
      withFallback(
        "marketData.getBars",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getBars(symbol, timeframe, params),
        () => fallback.getBars(symbol, timeframe, params)
      ),
    getLatestBar: (symbol) =>
      withFallback(
        "marketData.getLatestBar",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getLatestBar(symbol),
        () => fallback.getLatestBar(symbol)
      ),
    getLatestBars: (symbols) =>
      withFallback(
        "marketData.getLatestBars",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getLatestBars(symbols),
        () => fallback.getLatestBars(symbols)
      ),
    getQuote: (symbol) =>
      withFallback(
        "marketData.getQuote",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getQuote(symbol),
        () => fallback.getQuote(symbol)
      ),
    getQuotes: (symbols) =>
      withFallback(
        "marketData.getQuotes",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getQuotes(symbols),
        () => fallback.getQuotes(symbols)
      ),
    getSnapshot: (symbol) =>
      withFallback(
        "marketData.getSnapshot",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getSnapshot(symbol),
        () => fallback.getSnapshot(symbol)
      ),
    getSnapshots: (symbols) =>
      withFallback(
        "marketData.getSnapshots",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getSnapshots(symbols),
        () => fallback.getSnapshots(symbols)
      ),
    getCryptoSnapshot: (symbol) =>
      withFallback(
        "marketData.getCryptoSnapshot",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getCryptoSnapshot(symbol),
        () => fallback.getCryptoSnapshot(symbol)
      ),
  };
}

function createOptionsWithFallback(
  primaryBroker: string,
  fallbackBroker: string,
  primary: OptionsProvider,
  fallback: OptionsProvider
): OptionsProvider {
  return {
    isConfigured: () => primary.isConfigured() || fallback.isConfigured(),
    getExpirations: (underlying) =>
      withFallback(
        "options.getExpirations",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getExpirations(underlying),
        () => fallback.getExpirations(underlying)
      ),
    getChain: (underlying, expiration) =>
      withFallback(
        "options.getChain",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getChain(underlying, expiration),
        () => fallback.getChain(underlying, expiration)
      ),
    getSnapshot: (contractSymbol) =>
      withFallback(
        "options.getSnapshot",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getSnapshot(contractSymbol),
        () => fallback.getSnapshot(contractSymbol)
      ),
    getSnapshots: (contractSymbols) =>
      withFallback(
        "options.getSnapshots",
        primaryBroker,
        fallbackBroker,
        true,
        () => primary.getSnapshots(contractSymbols),
        () => fallback.getSnapshots(contractSymbols)
      ),
  };
}

export function wrapBrokerProvidersWithFallback(
  primary: BrokerProviders,
  fallback: BrokerProviders,
  config: BrokerFallbackConfig
): BrokerProviders {
  return {
    broker: primary.broker,
    trading: createTradingWithFallback(primary.broker, fallback.broker, primary.trading, fallback.trading, config),
    marketData: createMarketDataWithFallback(primary.broker, fallback.broker, primary.marketData, fallback.marketData),
    options: createOptionsWithFallback(primary.broker, fallback.broker, primary.options, fallback.options),
  };
}
