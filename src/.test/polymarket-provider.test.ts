import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPolymarketClient } from "../providers/polymarket/client";
import { createPolymarketMarketDataProvider } from "../providers/polymarket/market-data";
import { createPolymarketSymbolMap } from "../providers/polymarket/symbols";
import { createPolymarketTradingProvider, type PolymarketOrderSigner } from "../providers/polymarket/trading";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Polymarket provider integration", () => {
  const symbolMap = createPolymarketSymbolMap('{"AAPL":"111"}');
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.pathname === "/balance-allowance") {
        return jsonResponse({ balance: "150.25", allowance: "200.00" });
      }
      if (url.pathname === "/book") {
        return jsonResponse({
          asset_id: "111",
          bids: [{ price: "0.48", size: "200" }],
          asks: [{ price: "0.52", size: "180" }],
          timestamp: "2026-02-16T10:00:00Z",
        });
      }
      if (url.pathname === "/midpoint") {
        return jsonResponse({ mid: "0.5" });
      }
      if (url.pathname === "/last-trade-price") {
        return jsonResponse({ price: "0.49" });
      }
      if (url.pathname === "/order" && request.method === "POST") {
        return jsonResponse({ success: true, orderID: "ord-123" });
      }
      if (url.pathname === "/prices-history") {
        return jsonResponse({
          history: [
            { t: 1700000000, p: 0.45 },
            { t: 1700000600, p: 0.5 },
          ],
        });
      }
      if (url.pathname === "/positions") {
        return jsonResponse([
          {
            asset: "111",
            size: 15,
            avgPrice: 0.4,
            curPrice: 0.5,
            initialValue: 6,
            currentValue: 7.5,
            cashPnl: 1.5,
            percentPnl: 0.25,
          },
        ]);
      }
      if (url.pathname === "/data/orders") {
        return jsonResponse([
          {
            id: "ord-live-1",
            asset_id: "111",
            side: "BUY",
            order_type: "GTC",
            original_size: "10",
            size_matched: "0",
            price: "0.5",
            status: "LIVE",
            created_at: "2026-02-16T11:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/data/order/ord-live-1") {
        return jsonResponse({
          order: {
            id: "ord-live-1",
            asset_id: "111",
            side: "BUY",
            order_type: "GTC",
            original_size: "10",
            size_matched: "0",
            price: "0.5",
            status: "LIVE",
            created_at: "2026-02-16T11:00:00Z",
          },
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  it("maps balance allowance into broker account fields", async () => {
    const client = createPolymarketClient({
      baseUrl: "https://clob.polymarket.com",
      chainId: 137,
      signatureType: 2,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      maxRequestsPerSecond: 100,
      credentials: {
        apiKey: "k",
        apiSecret: "c2VjcmV0MTIz",
        apiPassphrase: "p",
        address: "0xabc",
      },
    });
    const signer: PolymarketOrderSigner = {
      signOrder: vi.fn(),
    };
    const trading = createPolymarketTradingProvider({ client, symbolMap, signer });

    const account = await trading.getAccount();
    expect(account.cash).toBe(150.25);
    expect(account.buying_power).toBe(200);

    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    const firstRequest = new Request(firstCall[0], firstCall[1]);
    expect(firstRequest.headers.get("POLY_API_KEY")).toBe("k");
    expect(firstRequest.headers.get("POLY_PASSPHRASE")).toBe("p");
    expect(firstRequest.headers.get("POLY_ADDRESS")).toBe("0xabc");
  });

  it("maps positions from the data API /positions endpoint", async () => {
    const client = createPolymarketClient({
      baseUrl: "https://clob.polymarket.com",
      dataApiBaseUrl: "https://data-api.polymarket.com",
      chainId: 137,
      signatureType: 2,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      maxRequestsPerSecond: 100,
      credentials: {
        apiKey: "k",
        apiSecret: "c2VjcmV0MTIz",
        apiPassphrase: "p",
        address: "0xabc",
      },
    });
    const signer: PolymarketOrderSigner = {
      signOrder: vi.fn(),
    };
    const trading = createPolymarketTradingProvider({ client, symbolMap, signer });

    const positions = await trading.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.symbol).toBe("AAPL");
    expect(positions[0]?.qty).toBe(15);
    expect(positions[0]?.unrealized_pl).toBe(1.5);
  });

  it("creates orders via signer + /order endpoint", async () => {
    const client = createPolymarketClient({
      baseUrl: "https://clob.polymarket.com",
      chainId: 137,
      signatureType: 2,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      maxRequestsPerSecond: 100,
      credentials: {
        apiKey: "k",
        apiSecret: "c2VjcmV0MTIz",
        apiPassphrase: "p",
        address: "0xabc",
      },
    });

    const signer: PolymarketOrderSigner = {
      signOrder: vi.fn(async () => ({
        order: { salt: "1" },
        owner: "0xabc",
        orderType: "GTC",
      })),
    };
    const trading = createPolymarketTradingProvider({ client, symbolMap, signer });

    const order = await trading.createOrder({
      symbol: "AAPL",
      notional: 50,
      side: "buy",
      type: "limit",
      time_in_force: "gtc",
      limit_price: 0.5,
    });

    expect(order.id).toBe("ord-123");
    expect(order.symbol).toBe("AAPL");

    const postCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/order"));
    expect(postCall).toBeTruthy();
    const request = new Request(String(postCall?.[0]), postCall?.[1] as RequestInit);
    const body = (await request.json()) as { owner: string; orderType: string };
    expect(body.owner).toBe("0xabc");
    expect(body.orderType).toBe("GTC");
  });

  it("builds snapshots from book + midpoint endpoints", async () => {
    const client = createPolymarketClient({
      baseUrl: "https://clob.polymarket.com",
      chainId: 137,
      signatureType: 2,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      maxRequestsPerSecond: 100,
    });

    const marketData = createPolymarketMarketDataProvider(client, symbolMap);
    const snapshot = await marketData.getSnapshot("AAPL");

    expect(snapshot.symbol).toBe("AAPL");
    expect(snapshot.latest_quote.bid_price).toBe(0.48);
    expect(snapshot.latest_quote.ask_price).toBe(0.52);
    expect(snapshot.latest_trade.price).toBe(0.5);
  });

  it("supports list/get order response formats from Polymarket", async () => {
    const client = createPolymarketClient({
      baseUrl: "https://clob.polymarket.com",
      chainId: 137,
      signatureType: 2,
      requestTimeoutMs: 10_000,
      maxRetries: 0,
      maxRequestsPerSecond: 100,
      credentials: {
        apiKey: "k",
        apiSecret: "c2VjcmV0MTIz",
        apiPassphrase: "p",
        address: "0xabc",
      },
    });
    const signer: PolymarketOrderSigner = {
      signOrder: vi.fn(),
    };
    const trading = createPolymarketTradingProvider({ client, symbolMap, signer });

    const orders = await trading.listOrders();
    expect(orders[0]?.id).toBe("ord-live-1");

    const single = await trading.getOrder("ord-live-1");
    expect(single.id).toBe("ord-live-1");
  });
});
