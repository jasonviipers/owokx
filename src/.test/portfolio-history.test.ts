import { describe, expect, it } from "vitest";
import {
  buildPortfolioSnapshots,
  downsampleEquityPoints,
  periodWindowMs,
  timeframeBucketMs,
} from "../lib/portfolio-history";

describe("portfolio-history", () => {
  it("parses standard period windows", () => {
    expect(periodWindowMs("1D")).toBe(24 * 60 * 60 * 1000);
    expect(periodWindowMs("1W")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(periodWindowMs("1M")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(periodWindowMs("unknown")).toBeNull();
  });

  it("parses timeframe buckets", () => {
    expect(timeframeBucketMs("15Min")).toBe(15 * 60 * 1000);
    expect(timeframeBucketMs("1D")).toBe(24 * 60 * 60 * 1000);
    expect(timeframeBucketMs("bad")).toBe(0);
  });

  it("downsamples points by timeframe bucket", () => {
    const base = 1_700_000_000_000;
    const points = [
      { timestamp_ms: base + 1_000, equity: 100 },
      { timestamp_ms: base + 2_000, equity: 101 },
      { timestamp_ms: base + 60_000 + 1_000, equity: 102 },
    ];

    const out = downsampleEquityPoints(points, 60_000);
    expect(out).toHaveLength(2);
    expect(out[0]?.equity).toBe(101);
    expect(out[1]?.equity).toBe(102);
  });

  it("builds snapshots with pl and pl_pct", () => {
    const points = [
      { timestamp_ms: 1000, equity: 100 },
      { timestamp_ms: 2000, equity: 110 },
    ];
    const snapshots = buildPortfolioSnapshots(points, 100);
    expect(snapshots[0]).toMatchObject({ timestamp: 1000, equity: 100, pl: 0, pl_pct: 0 });
    expect(snapshots[1]).toMatchObject({ timestamp: 2000, equity: 110, pl: 10, pl_pct: 0.1 });
  });
});
