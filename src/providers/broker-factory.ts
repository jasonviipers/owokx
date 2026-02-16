import type { Env } from "../env.d";
import { createError, ErrorCode } from "../lib/errors";
import { parseBoolean } from "../lib/utils";
import { createAlpacaProviders } from "./alpaca";
import { wrapBrokerProvidersWithFallback } from "./fallback";
import { createOkxProviders } from "./okx";
import { createPolymarketProviders } from "./polymarket";
import type { BrokerProvider, MarketDataProvider, OptionsProvider } from "./types";

export type BrokerId = "alpaca" | "okx" | "polymarket";

export interface BrokerProviders {
  broker: BrokerId;
  trading: BrokerProvider;
  marketData: MarketDataProvider;
  options: OptionsProvider;
}

function parseBrokerId(input: string | null | undefined): BrokerId | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "alpaca" || normalized === "okx" || normalized === "polymarket") {
    return normalized;
  }
  return null;
}

export function resolveBroker(env: Env, preferred?: string | null): BrokerId {
  return parseBrokerId(preferred) ?? parseBrokerId(env.BROKER_PROVIDER) ?? "alpaca";
}

function createProvidersForBroker(env: Env, broker: BrokerId): BrokerProviders {
  if (broker === "polymarket") {
    if (
      !env.POLYMARKET_API_KEY ||
      !env.POLYMARKET_API_SECRET ||
      !env.POLYMARKET_API_PASSPHRASE ||
      !env.POLYMARKET_ADDRESS
    ) {
      throw createError(
        ErrorCode.UNAUTHORIZED,
        "Polymarket credentials are not configured (POLYMARKET_API_KEY/POLYMARKET_API_SECRET/POLYMARKET_API_PASSPHRASE/POLYMARKET_ADDRESS)"
      );
    }
    const polymarket = createPolymarketProviders(env);
    return {
      broker,
      trading: polymarket.trading,
      marketData: polymarket.marketData,
      options: polymarket.options,
    };
  }

  if (broker === "okx") {
    if (!env.OKX_API_KEY || !env.OKX_SECRET || !env.OKX_PASSPHRASE) {
      throw createError(
        ErrorCode.UNAUTHORIZED,
        "OKX credentials are not configured (OKX_API_KEY/OKX_SECRET/OKX_PASSPHRASE)"
      );
    }
    const okx = createOkxProviders(env);
    return {
      broker,
      trading: okx.trading,
      marketData: okx.marketData,
      options: okx.options,
    };
  }

  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
    throw createError(
      ErrorCode.UNAUTHORIZED,
      "Alpaca credentials are not configured (ALPACA_API_KEY/ALPACA_API_SECRET)"
    );
  }
  const alpaca = createAlpacaProviders(env);
  return {
    broker,
    trading: alpaca.trading,
    marketData: alpaca.marketData,
    options: alpaca.options,
  };
}

function resolveFallbackBroker(env: Env, primary: BrokerId): BrokerId | null {
  const fallback = parseBrokerId(env.BROKER_FALLBACK_PROVIDER);
  if (!fallback || fallback === primary) return null;
  return fallback;
}

export function createBrokerProviders(env: Env, preferred?: string | null): BrokerProviders {
  const broker = resolveBroker(env, preferred);
  const primary = createProvidersForBroker(env, broker);

  const fallbackBroker = resolveFallbackBroker(env, broker);
  if (!fallbackBroker) {
    return primary;
  }

  const fallbackProviders = createProvidersForBroker(env, fallbackBroker);
  return wrapBrokerProvidersWithFallback(primary, fallbackProviders, {
    allowTradingFallback: parseBoolean(env.BROKER_FALLBACK_ALLOW_TRADING, false),
  });
}
