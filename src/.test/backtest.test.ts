import { describe, expect, it } from "vitest";
import { BacktestBrokerProvider, BacktestMarketDataProvider } from "../providers/backtest";

describe("Backtest providers", () => {
  it("fills market buy/sell and updates cash/positions", async () => {
    const bars = [
      { t: "2025-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1, n: 1, vw: 100 },
      { t: "2025-01-02T00:00:00Z", o: 110, h: 111, l: 109, c: 110, v: 1, n: 1, vw: 110 },
    ];
    const t0 = Date.parse(bars[0]!.t);
    const t1 = Date.parse(bars[1]!.t);

    const marketData = new BacktestMarketDataProvider({ AAPL: bars }, { now_ms: t0, spread_bps: 0 });
    const broker = new BacktestBrokerProvider({ now_ms: t0, initial_cash: 10_000, marketData });

    const before = await broker.getAccount();
    expect(before.cash).toBeCloseTo(10_000, 6);
    expect(before.equity).toBeCloseTo(10_000, 6);

    await broker.createOrder({ symbol: "AAPL", notional: 1000, side: "buy", type: "market", time_in_force: "day" });
    const afterBuy = await broker.getAccount();
    const pos = await broker.getPosition("AAPL");
    expect(pos).not.toBeNull();
    expect(pos!.qty).toBeCloseTo(10, 6);
    expect(afterBuy.cash).toBeCloseTo(9000, 6);

    broker.setNow(t1);
    const afterMove = await broker.getAccount();
    expect(afterMove.equity).toBeGreaterThan(afterBuy.equity);

    await broker.createOrder({ symbol: "AAPL", qty: 5, side: "sell", type: "market", time_in_force: "day" });
    const afterSell = await broker.getAccount();
    const posAfterSell = await broker.getPosition("AAPL");
    expect(posAfterSell).not.toBeNull();
    expect(posAfterSell!.qty).toBeCloseTo(5, 6);
    expect(afterSell.cash).toBeCloseTo(9000 + 5 * 110, 6);
  });

  it("produces portfolio history timeline", async () => {
    const bars = [
      { t: "2025-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1, n: 1, vw: 100 },
      { t: "2025-01-02T00:00:00Z", o: 90, h: 91, l: 89, c: 90, v: 1, n: 1, vw: 90 },
      { t: "2025-01-03T00:00:00Z", o: 95, h: 96, l: 94, c: 95, v: 1, n: 1, vw: 95 },
    ];
    const times = bars.map((b) => Date.parse(b.t));

    const marketData = new BacktestMarketDataProvider({ AAPL: bars }, { now_ms: times[0]!, spread_bps: 0 });
    const broker = new BacktestBrokerProvider({ now_ms: times[0]!, initial_cash: 10_000, marketData });

    await broker.createOrder({ symbol: "AAPL", notional: 1000, side: "buy", type: "market", time_in_force: "day" });
    broker.setNow(times[1]!);
    broker.setNow(times[2]!);

    const history = await broker.getPortfolioHistory({ timeframe: "1D" });
    expect(history.timestamp.length).toBeGreaterThanOrEqual(2);
    expect(history.equity.length).toBe(history.timestamp.length);
    expect(history.profit_loss_pct.length).toBe(history.timestamp.length);
  });
});
