export type PolymarketOrderSide = "BUY" | "SELL";
export type PolymarketOrderType = "GTC" | "FOK" | "GTD";

export interface PolymarketApiCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  address: string;
}

export interface PolymarketBookLevel {
  price?: string | number;
  size?: string | number;
}

export interface PolymarketOrderBook {
  asset_id?: string;
  token_id?: string;
  bids?: PolymarketBookLevel[];
  asks?: PolymarketBookLevel[];
  timestamp?: string;
  hash?: string;
}

export interface PolymarketMidpointResponse {
  mid?: string | number;
}

export interface PolymarketLastTradePriceResponse {
  price?: string | number;
}

export interface PolymarketBalanceAllowanceResponse {
  balance?: string;
  allowance?: string;
}

export interface PolymarketOpenOrder {
  id?: string;
  order_id?: string;
  orderID?: string;
  status?: string;
  owner?: string;
  maker_address?: string;
  market?: string;
  asset_id?: string;
  token_id?: string;
  side?: string;
  order_type?: string;
  orderType?: string;
  size_matched?: string;
  sizeMatched?: string;
  original_size?: string;
  originalSize?: string;
  price?: string;
  created_at?: string;
  expiration?: string;
}

export interface PolymarketOpenOrdersEnvelope {
  data?: PolymarketOpenOrder[];
  next_cursor?: string;
  limit?: number;
  count?: number;
}

export type PolymarketOpenOrdersResponse = PolymarketOpenOrder[] | PolymarketOpenOrdersEnvelope;

export interface PolymarketGetOrderResponse {
  order?: PolymarketOpenOrder;
  data?: PolymarketOpenOrder[];
}

export interface PolymarketCreateOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
  [key: string]: unknown;
}

export interface PolymarketTrade {
  id?: string;
  side?: string;
  size?: string | number;
  price?: string | number;
  asset_id?: string;
  token_id?: string;
  market?: string;
  timestamp?: string;
  match_time?: string;
}

export interface PolymarketTradesEnvelope {
  data?: PolymarketTrade[];
  next_cursor?: string;
  limit?: number;
  count?: number;
}

export type PolymarketTradesResponse = PolymarketTrade[] | PolymarketTradesEnvelope;

export interface PolymarketDataPosition {
  asset?: string;
  conditionId?: string;
  size?: number | string;
  avgPrice?: number | string;
  initialValue?: number | string;
  currentValue?: number | string;
  cashPnl?: number | string;
  percentPnl?: number | string;
  curPrice?: number | string;
  outcome?: string;
}

export interface PolymarketPriceHistoryPoint {
  t?: number | string;
  p?: number | string;
  timestamp?: number | string;
  price?: number | string;
}

export interface PolymarketPriceHistoryResponse {
  history?: PolymarketPriceHistoryPoint[];
  data?: PolymarketPriceHistoryPoint[];
}
