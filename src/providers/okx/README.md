# OKX Provider Broker Module

This provider implements a full OKX integration for the workspace broker architecture.

It includes:
- Credential validation (`apiKey`, `apiSecret`, `apiPass`)
- OKX-compliant signing (`timestamp + method + path + body` -> HMAC SHA256 base64)
- Spot, margin, futures/swap, and options order flows
- Market data (tickers, order books, trades, candles, instruments)
- Account functions (balances, positions, bills/transactions, fills)
- Order management (place, query, cancel, list)
- Request throttling + retry policy
- WebSocket subscriptions for market + private account streams

## Architecture

- `client.ts`
- SDK initialization, auth/signing, error mapping, rate-limited REST proxy
- `trading.ts`
- `BrokerProvider` implementation + OKX-specific advanced trading/account methods
- `market-data.ts`
- `MarketDataProvider` implementation + extra market endpoints
- `options.ts`
- `OptionsProvider` compatibility + option-specific trading/data methods
- `websocket.ts`
- Typed WS subscription manager for market/account/order/position channels
- `rate-limiter.ts`
- RPS limiting + retry with exponential backoff and jitter

## Environment

```env
# Required
OKX_API_KEY=...
OKX_SECRET=...
OKX_PASSPHRASE=...

# Optional
# Region domain must match the account where the API key was created:
# Global: https://www.okx.com
# US:     https://us.okx.com (or https://app.okx.com)
# EEA:    https://eea.okx.com (or https://my.okx.com)
OKX_BASE_URL=https://www.okx.com
OKX_SIMULATED_TRADING=false
OKX_DEFAULT_QUOTE_CCY=USDT
OKX_MAX_REQUESTS_PER_SECOND=10
OKX_MAX_RETRIES=3
OKX_LOG_LEVEL=info
```

## Initialization

```ts
import { createOkxProviders } from "./src/providers/okx";

const providers = createOkxProviders(env);
const { trading, marketData, options, websocket } = providers;
```

## Authentication and Signing

`client.ts` enforces all three credentials and injects a custom signer into both REST and WebSocket clients.

Signing payload format:
- `timestamp + method.toUpperCase() + requestPathWithQuery + body`

Signature algorithm:
- `HMAC SHA256`
- `base64` output

This matches OKX API v5 requirements and applies to private REST calls and private WS auth.

## Trading Methods

### Generic broker-compatible methods

```ts
const account = await trading.getAccount();
const positions = await trading.getPositions();
const btcPos = await trading.getPosition("BTC-USDT");

const order = await trading.createOrder({
  symbol: "BTC-USDT",
  side: "buy",
  type: "limit",
  time_in_force: "gtc",
  qty: 0.01,
  limit_price: 40000,
});

const fetched = await trading.getOrder(order.id);
await trading.cancelOrder(order.id);
```

### OKX-specific advanced trading methods

#### Spot

```ts
await trading.placeSpotOrder({
  instId: "BTC-USDT",
  side: "buy",
  ordType: "market",
  sz: "100",
  tgtCcy: "quote_ccy",
});
```

#### Margin

```ts
await trading.placeMarginOrder({
  instId: "BTC-USDT",
  side: "sell",
  ordType: "limit",
  tdMode: "cross",
  sz: "0.01",
  px: "45000",
});
```

#### Futures / Swaps

```ts
await trading.placeFuturesOrder({
  instType: "SWAP",
  instId: "BTC-USDT-SWAP",
  side: "buy",
  ordType: "market",
  tdMode: "isolated",
  posSide: "long",
  sz: "1",
  reduceOnly: false,
});
```

#### Options

```ts
await trading.placeOptionOrder({
  instId: "BTC-USD-260327-50000-C",
  side: "buy",
  ordType: "limit",
  tdMode: "isolated",
  sz: "1",
  px: "120",
});
```

## Account and Transaction Methods

```ts
const balances = await trading.getBalances();

const bills = await trading.getTransactionHistory({
  instType: "SPOT",
  limit: 100,
});

const fills = await trading.getFills({
  instType: "SWAP",
  instId: "BTC-USDT-SWAP",
  limit: "100",
});

await trading.setLeverage({
  instId: "BTC-USDT-SWAP",
  mgnMode: "isolated",
  lever: "5",
  posSide: "long",
});
```

## Market Data Methods

```ts
const bars = await marketData.getBars("BTC-USDT", "1h", { limit: 200 });
const quote = await marketData.getQuote("BTC-USDT");
const snapshot = await marketData.getSnapshot("BTC-USDT");

const ticker = await marketData.getTicker("BTC-USDT");
const tickers = await marketData.getTickers("SPOT");
const orderBook = await marketData.getOrderBook("BTC-USDT", 20);
const trades = await marketData.getTrades("BTC-USDT", 100);
const historic = await marketData.getHistoricTrades("BTC-USDT", { limit: 300 });
const instruments = await marketData.getInstruments("OPTION", { uly: "BTC-USD" });
```

## Options Provider Methods

`options.ts` supports both generic `OptionsProvider` and OKX option-specific methods.

```ts
const expirations = await options.getExpirations("BTC-USD");
const chain = await options.getChain("BTC-USD", expirations[0]);
const snap = await options.getSnapshot("BTC-USD-260327-50000-C");

const optionOrder = await options.placeOptionOrder({
  instId: "BTC-USD-260327-50000-C",
  side: "buy",
  ordType: "limit",
  tdMode: "isolated",
  sz: "1",
  px: "100",
});
```

## WebSocket Methods

```ts
await websocket.connect();

await websocket.subscribeTicker("BTC-USDT", (event) => {
  console.log("ticker", event);
});

await websocket.subscribeOrderBook("BTC-USDT", 5, (event) => {
  console.log("book", event);
});

await websocket.subscribeTrades("BTC-USDT", (event) => {
  console.log("trades", event);
});

await websocket.subscribeAccountUpdates((event) => {
  console.log("account", event);
});

await websocket.subscribeOrders((event) => {
  console.log("orders", event);
});

await websocket.subscribePositions((event) => {
  console.log("positions", event);
});
```

## Rate Limiting and Retry

- RPS throttle: configurable with `OKX_MAX_REQUESTS_PER_SECOND`
- Retry attempts: configurable with `OKX_MAX_RETRIES`
- Retryable failures:
- HTTP `429`, `500`, `502`, `503`, `504`
- OKX rate-limit/transient codes such as `50011`, `50040`
- Non-retryable failures:
- auth/signature errors
- invalid input/order parameter errors

## Error Handling

Provider methods throw `OkxClientError` with:
- internal code (`UNAUTHORIZED`, `RATE_LIMITED`, etc.)
- OKX code (`okxCode`)
- optional HTTP status

Mapped examples:
- `50113` invalid key/secret/passphrase
- `50114` invalid signature
- `50115` invalid timestamp
- `51000` parameter error
- `51008` insufficient balance
- `51009` order not found
- `50011` rate limit exceeded

## LLM Skill Integration

This repo includes a dedicated skill for future LLM sessions:
- `skills/okx-provider-broker/SKILL.md`
- `skills/okx-provider-broker/references/okx-sdk-usage.md`
- `skills/okx-provider-broker/references/okx-error-map.md`

The skill references `.trae/okx-api-llm.txt` as the canonical expanded SDK/function surface and keeps practical patterns concise for provider implementation work.
