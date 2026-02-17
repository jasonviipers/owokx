import type { Env } from "../../env.d";
import { createNullOptionsProvider, type NullOptionsProvider } from "../null-options";
import { createPolymarketClient, type PolymarketClient } from "./client";
import { createPolymarketMarketDataProvider, type PolymarketMarketDataProvider } from "./market-data";
import { createPolymarketSymbolMap } from "./symbols";
import {
  createPolymarketTradingProvider,
  HttpPolymarketOrderSigner,
  type PolymarketOrderSigner,
  type PolymarketTradingProvider,
} from "./trading";

export interface PolymarketProviders {
  trading: PolymarketTradingProvider;
  marketData: PolymarketMarketDataProvider;
  options: NullOptionsProvider;
  client: PolymarketClient;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function buildPolymarketSigner(env: Env): PolymarketOrderSigner | undefined {
  const signerUrl = env.POLYMARKET_ORDER_SIGNER_URL?.trim();
  if (!signerUrl) return undefined;

  return new HttpPolymarketOrderSigner({
    url: signerUrl,
    timeoutMs: parsePositiveInteger(env.POLYMARKET_ORDER_SIGNER_TIMEOUT_MS, 10_000),
    bearerToken: env.POLYMARKET_ORDER_SIGNER_BEARER_TOKEN,
  });
}

export function createPolymarketProviders(env: Env): PolymarketProviders {
  const symbolMap = createPolymarketSymbolMap(env.POLYMARKET_SYMBOL_MAP_JSON);
  const signer = buildPolymarketSigner(env);

  const client = createPolymarketClient({
    baseUrl: env.POLYMARKET_API_URL || "https://clob.polymarket.com",
    dataApiBaseUrl: env.POLYMARKET_DATA_API_URL || "https://data-api.polymarket.com",
    chainId: parsePositiveInteger(env.POLYMARKET_CHAIN_ID, 137),
    signatureType: parsePositiveInteger(env.POLYMARKET_SIGNATURE_TYPE, 2),
    requestTimeoutMs: parsePositiveInteger(env.POLYMARKET_REQUEST_TIMEOUT_MS, 10_000),
    maxRetries: parseNonNegativeInteger(env.POLYMARKET_MAX_RETRIES, 2),
    maxRequestsPerSecond: parseNonNegativeNumber(env.POLYMARKET_MAX_REQUESTS_PER_SECOND, 10),
    credentials:
      env.POLYMARKET_API_KEY && env.POLYMARKET_API_SECRET && env.POLYMARKET_API_PASSPHRASE && env.POLYMARKET_ADDRESS
        ? {
            apiKey: env.POLYMARKET_API_KEY,
            apiSecret: env.POLYMARKET_API_SECRET,
            apiPassphrase: env.POLYMARKET_API_PASSPHRASE,
            address: env.POLYMARKET_ADDRESS,
          }
        : undefined,
  });

  return {
    trading: createPolymarketTradingProvider({
      client,
      symbolMap,
      signer,
    }),
    marketData: createPolymarketMarketDataProvider(client, symbolMap),
    options: createNullOptionsProvider(),
    client,
  };
}

export type { PolymarketClient } from "./client";
export { createPolymarketClient } from "./client";
export type { PolymarketMarketDataProvider } from "./market-data";
export type { PolymarketTradingProvider } from "./trading";
export { HttpPolymarketOrderSigner } from "./trading";
