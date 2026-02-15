import type { Env } from "../env.d";
import { createError, ErrorCode } from "../lib/errors";
import { createAlpacaProviders } from "./alpaca";
import { createOkxProviders } from "./okx";
import type { BrokerProvider, MarketDataProvider, OptionsProvider } from "./types";

export type BrokerId = "alpaca" | "okx";

export interface BrokerProviders {
  broker: BrokerId;
  trading: BrokerProvider;
  marketData: MarketDataProvider;
  options: OptionsProvider;
}

export function resolveBroker(env: Env, preferred?: string | null): BrokerId {
  const raw = String(preferred ?? env.BROKER_PROVIDER ?? "alpaca")
    .trim()
    .toLowerCase();
  if (raw === "okx") return "okx";
  return "alpaca";
}

export function createBrokerProviders(env: Env, preferred?: string | null): BrokerProviders {
  const broker = resolveBroker(env, preferred);

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
