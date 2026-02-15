import type { Env } from "../../env.d";
import { parseBoolean } from "../../lib/utils";
import { createOkxClient, type OkxClientConfig } from "./client";
import { createOkxMarketDataProvider, type OkxMarketDataProvider } from "./market-data";
import { createOkxTradingProvider, type OkxTradingProvider } from "./trading";

export interface OkxProviders {
  trading: OkxTradingProvider;
  marketData: OkxMarketDataProvider;
}

export function createOkxProviders(env: Env): OkxProviders {
  const maxRequestsPerSecond = Number(env.OKX_MAX_REQUESTS_PER_SECOND ?? "5");
  const maxRetries = Number(env.OKX_MAX_RETRIES ?? "2");
  const simulatedTrading = parseBoolean(env.OKX_SIMULATED_TRADING, false);
  const enableDemoVirtualBalances = parseBoolean(env.OKX_DEMO_VIRTUAL_BALANCES, true);
  const demoVirtualCashUsd = Number(env.OKX_DEMO_VIRTUAL_CASH_USD ?? "100000");
  const demoVirtualBuyingPowerUsd = Number(env.OKX_DEMO_VIRTUAL_BUYING_POWER_USD ?? `${demoVirtualCashUsd}`);

  // DEBUG: Log OKX configuration (remove after troubleshooting)
  // console.log("🔍 OKX Config Debug:", {
  //   hasApiKey: !!env.OKX_API_KEY,
  //   apiKeyPrefix: env.OKX_API_KEY?.substring(0, 8) + "...",
  //   hasSecret: !!env.OKX_SECRET,
  //   secretLength: env.OKX_SECRET?.length,
  //   hasPassphrase: !!env.OKX_PASSPHRASE,
  //   passphraseLength: env.OKX_PASSPHRASE?.length,
  //   rawSimulatedTradingVar: env.OKX_SIMULATED_TRADING,
  //   parsedSimulatedTrading: parseBoolean(env.OKX_SIMULATED_TRADING, false),
  //   baseUrl: env.OKX_BASE_URL ?? "https://eea.okx.com",
  // });

  const config: OkxClientConfig = {
    apiKey: env.OKX_API_KEY!,
    secret: env.OKX_SECRET!,
    passphrase: env.OKX_PASSPHRASE!,
    baseUrl: env.OKX_BASE_URL ?? "https://eea.okx.com",
    simulatedTrading,
    maxRequestsPerSecond: Number.isFinite(maxRequestsPerSecond) ? maxRequestsPerSecond : 5,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
    logger: {
      log(level, message, meta) {
        const line = { provider: "okx", level, message, ...(meta || {}) };
        if (level === "error") console.error(JSON.stringify(line));
        else if (level === "warn") console.warn(JSON.stringify(line));
        else console.log(JSON.stringify(line));
      },
    },
  };

  const client = createOkxClient(config);
  const quote = env.OKX_DEFAULT_QUOTE_CCY ?? "USDT";

  return {
    trading: createOkxTradingProvider(client, quote, {
      simulatedTrading,
      enableDemoVirtualBalances,
      demoVirtualCashUsd: Number.isFinite(demoVirtualCashUsd) ? demoVirtualCashUsd : 100000,
      demoVirtualBuyingPowerUsd: Number.isFinite(demoVirtualBuyingPowerUsd)
        ? demoVirtualBuyingPowerUsd
        : demoVirtualCashUsd,
    }),
    marketData: createOkxMarketDataProvider(client, quote),
  };
}

export { createOkxClient, OkxClient } from "./client";
