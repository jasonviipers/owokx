# Polymarket Provider

This provider adapts the Polymarket CLOB API to the shared broker interfaces in `src/providers/types.ts`.
It uses Polymarket Data API `/positions` for position snapshots and falls back to CLOB `/data/trades` when needed.

## Required Environment

- `BROKER_PROVIDER=polymarket`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET` (base64 secret from Polymarket API key creation)
- `POLYMARKET_API_PASSPHRASE`
- `POLYMARKET_ADDRESS`
- optional `POLYMARKET_API_URL` (CLOB base URL override)
- optional `POLYMARKET_DATA_API_URL` (Data API base URL override, default `https://data-api.polymarket.com`)

## Order Signing

`createOrder()` requires a signer implementation. The default integration uses an external signer service:

- `POLYMARKET_ORDER_SIGNER_URL`
- optional `POLYMARKET_ORDER_SIGNER_BEARER_TOKEN`

Expected signer request payload:

```json
{
  "tokenId": "12345678901234567890",
  "side": "BUY",
  "orderType": "GTC",
  "price": 0.63,
  "size": 25,
  "chainId": 137,
  "signatureType": 2,
  "clientOrderId": "abc123"
}
```

Expected signer response payload:

```json
{
  "order": { "..." : "..." },
  "owner": "0x...",
  "orderType": "GTC"
}
```

## Symbol Mapping

Set `POLYMARKET_SYMBOL_MAP_JSON` to route strategy symbols to token IDs:

```json
{ "AAPL": "12345678901234567890", "NVDA": "98765432109876543210" }
```

You can also use direct symbol format `POLY:<token_id>` in order requests.
