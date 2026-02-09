export type EquityPoint = { timestamp_ms: number; equity: number };

export function periodWindowMs(period: string): number | null {
  const p = String(period || "").toUpperCase();
  if (p === "1D") return 24 * 60 * 60 * 1000;
  if (p === "1W") return 7 * 24 * 60 * 60 * 1000;
  if (p === "1M") return 30 * 24 * 60 * 60 * 1000;
  if (p === "3M") return 90 * 24 * 60 * 60 * 1000;
  if (p === "6M") return 180 * 24 * 60 * 60 * 1000;
  if (p === "1A" || p === "1Y") return 365 * 24 * 60 * 60 * 1000;
  return null;
}

export function timeframeBucketMs(timeframe: string): number {
  const tf = String(timeframe || "");
  const match = tf.match(/^(\d+)(Min|H|D)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (unit === "min") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return 0;
}

export function downsampleEquityPoints(points: EquityPoint[], bucketMs: number): EquityPoint[] {
  const sorted = [...points].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  if (bucketMs <= 0) return sorted;

  const byBucket = new Map<number, EquityPoint>();
  for (const point of sorted) {
    const bucket = Math.floor(point.timestamp_ms / bucketMs) * bucketMs;
    const existing = byBucket.get(bucket);
    if (!existing || point.timestamp_ms >= existing.timestamp_ms) {
      byBucket.set(bucket, point);
    }
  }

  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
}

export function buildPortfolioSnapshots(
  points: EquityPoint[],
  baseValue: number
): Array<{
  timestamp: number;
  equity: number;
  pl: number;
  pl_pct: number;
}> {
  const baseline = Number.isFinite(baseValue) && baseValue > 0 ? baseValue : (points[0]?.equity ?? 0);
  const denom = baseline > 0 ? baseline : 0;

  return points.map((p) => {
    const pl = p.equity - baseline;
    const pl_pct = denom > 0 ? pl / denom : 0;
    return {
      timestamp: p.timestamp_ms,
      equity: p.equity,
      pl,
      pl_pct,
    };
  });
}
