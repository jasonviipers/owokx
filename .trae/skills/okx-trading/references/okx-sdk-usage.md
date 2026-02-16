# OKX SDK Usage Patterns

Source: `.trae/okx-api-llm.txt` (packed SDK docs + signatures).

## Client setup

- REST client: `new RestClient({ apiKey, apiSecret, apiPass, market, demoTrading, customSignMessageFn })`
- Websocket client: `new WebsocketClient({ market, demoTrading, accounts: [{ apiKey, apiSecret, apiPass }], customSignMessageFn })`
- Region mapping:
- `GLOBAL` -> `market: 'prod'`
- `US` -> `market: 'US'`
- `EEA` -> `market: 'EEA'`

## Auth/signing behavior

- SDK signs private REST requests and private websocket auth.
- Custom signer hook: `customSignMessageFn(message, secret) => Promise<string>`.
- Message input follows OKX API signing rule:
- `timestamp + method + path + serializedParamsOrBody`.
- Signature output must be base64(HMAC_SHA256).

## Core trading methods

- Submit order: `client.submitOrder(OrderRequest)`
- Cancel order: `client.cancelOrder({ instId, ordId? clOrdId? })`
- Order details: `client.getOrderDetails({ instId, ordId? clOrdId? })`
- Open orders: `client.getOrderList({ instType, instId?, uly?, ... })`
- History orders: `client.getOrderHistory({ instType, ... })`
- Fills: `client.getFills({ instType?, instId?, ordId?, ... })`
- Historical fills: `client.getFillsHistory({ ... })`

## Instrument and market data methods

- Instruments: `client.getInstruments({ instType, uly?, instFamily?, instId? })`
- Ticker: `client.getTicker({ instId })`
- Tickers: `client.getTickers({ instType, uly?, instFamily? })`
- Order book: `client.getOrderBook({ instId, sz? })`
- Candles: `client.getCandles({ instId, bar?, after?, before?, limit? })`
- Historic candles: `client.getHistoricCandles({ ... })`
- Trades: `client.getTrades({ instId, limit? })`
- Historic trades: `client.getHistoricTrades({ instId, after?, before?, limit?, type? })`
- Option trades: `client.getOptionTrades({ instId?, instFamily?, optType? })`

## Account methods

- Balance: `client.getBalance({ ccy? })`
- Positions: `client.getPositions({ instType?, instId?, posId? })`
- Bills (7d): `client.getBills({ ... })`
- Bills archive (3m): `client.getBillsArchive({ ... })`
- Set leverage: `client.setLeverage({ lever, mgnMode, instId?, ccy?, posSide? })`

## OrderRequest essentials by product

- Spot:
- `instId: 'BTC-USDT'`, `tdMode: 'cash'`
- Margin:
- `tdMode: 'cross' | 'isolated'`, optional `ccy`
- Futures/swap:
- `instId` swap/futures instrument, `tdMode: 'cross' | 'isolated'`, optional `posSide`, `reduceOnly`
- Options:
- `instId` option contract, one of `px` or `pxUsd` or `pxVol` depending order style

## Websocket subscriptions

- Public channels:
- `tickers`, `trades`, `books5|books|books50-l2-tpt`, `candle*`
- Private channels:
- `account`, `orders` with `instType: 'ANY'`, `positions` with `instType: 'ANY'`
- Use `Promise.all(wsClient.subscribe(argOrArgs))` and same for unsubscribe.

## Implementation notes

- SDK returns parsed `data` array directly for successful calls.
- API failures throw payload objects that include `code` and `msg`; map these explicitly.
- Many order endpoints require `instId` even when `ordId` is known; maintain orderId->instId mapping.
