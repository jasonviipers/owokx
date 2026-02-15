import type { Env } from "../../env.d";
import { parseBoolean, parseNumber } from "../../lib/utils";
import { createOkxClient, type OkxClientConfig } from "./client";
import type { OkxLogLevel } from "./logger";
import { createOkxMarketDataProvider, type OkxMarketDataProvider } from "./market-data";
import { createOkxOptionsProvider, type OkxOptionsProvider } from "./options";
import { createOkxTradingProvider, type OkxTradingProvider } from "./trading";
import { createOkxWebSocketProvider, type OkxWebSocketProvider } from "./websocket";

export interface OkxProviders {
  trading: OkxTradingProvider;
  marketData: OkxMarketDataProvider;
  options: OkxOptionsProvider;
  websocket: OkxWebSocketProvider;
}

type OkxMarketRegion = "GLOBAL" | "US" | "EEA";

function parseLogLevel(value: string | undefined): OkxLogLevel {
  const normalized = value?.toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "silent"
  ) {
    return normalized;
  }
  return "info";
}

function inferOkxMarket(baseUrl: string | undefined): OkxMarketRegion {
  if (!baseUrl) {
    return "GLOBAL";
  }

  const input = baseUrl.trim().toLowerCase();
  if (!input) {
    return "GLOBAL";
  }

  let host = input;

  try {
    host = new URL(input).hostname.toLowerCase();
  } catch {
    try {
      host = new URL(`https://${input}`).hostname.toLowerCase();
    } catch {
      host = input;
    }
  }

  if (
    host === "us.okx.com" ||
    host.endsWith(".us.okx.com") ||
    host === "app.okx.com" ||
    host.endsWith(".app.okx.com")
  ) {
    return "US";
  }

  if (
    host === "eea.okx.com" ||
    host.endsWith(".eea.okx.com") ||
    host === "my.okx.com" ||
    host.endsWith(".my.okx.com")
  ) {
    return "EEA";
  }

  return "GLOBAL";
}

export function createOkxProviders(env: Env): OkxProviders {
  const baseUrl = env.OKX_BASE_URL || "https://www.okx.com";

  const config: OkxClientConfig = {
    apiKey: env.OKX_API_KEY!,
    apiSecret: env.OKX_SECRET!,
    apiPass: env.OKX_PASSPHRASE!,
    baseUrl,
    market: inferOkxMarket(baseUrl),
    simulatedTrading: parseBoolean(env.OKX_SIMULATED_TRADING, false),
    defaultQuoteCcy: env.OKX_DEFAULT_QUOTE_CCY || "USDT",
    maxRequestsPerSecond: parseNumber(env.OKX_MAX_REQUESTS_PER_SECOND, 10),
    maxRetries: parseNumber(env.OKX_MAX_RETRIES, 3),
    logLevel: parseLogLevel(env.OKX_LOG_LEVEL),
  };

  const client = createOkxClient(config);

  return {
    trading: createOkxTradingProvider(client),
    marketData: createOkxMarketDataProvider(client),
    options: createOkxOptionsProvider(client),
    websocket: createOkxWebSocketProvider(client),
  };
}

export type { OkxClient } from "./client";
export { createOkxClient } from "./client";
export type { OkxMarketDataProvider } from "./market-data";
export type { OkxOptionsProvider } from "./options";
export type { OkxTradingProvider } from "./trading";
export type { OkxWebSocketProvider } from "./websocket";
