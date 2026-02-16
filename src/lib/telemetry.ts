export type TelemetryTagValue = string | number | boolean;
export type TelemetryTags = Record<string, TelemetryTagValue | null | undefined>;

export interface TelemetryCounterSnapshot {
  total: number;
  by_dimension: Record<string, number>;
}

export interface TelemetryTimerAggregateSnapshot {
  count: number;
  total_ms: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  last_ms: number;
}

export interface TelemetryTimerSnapshot extends TelemetryTimerAggregateSnapshot {
  by_dimension: Record<string, TelemetryTimerAggregateSnapshot>;
}

export interface TelemetrySnapshot {
  scope: string;
  started_at_ms: number;
  updated_at_ms: number;
  counters: Record<string, TelemetryCounterSnapshot>;
  timers: Record<string, TelemetryTimerSnapshot>;
}

interface MutableCounterBucket {
  total: number;
  byDimension: Map<string, number>;
}

interface MutableTimerAggregate {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
}

interface MutableTimerBucket {
  overall: MutableTimerAggregate;
  byDimension: Map<string, MutableTimerAggregate>;
}

const DIMENSION_ALL = "_all";

/**
 * Create a new MutableTimerAggregate with all numeric fields initialized to zero.
 *
 * @returns A MutableTimerAggregate with `count`, `totalMs`, `minMs`, `maxMs`, and `lastMs` set to 0
 */
function createTimerAggregate(): MutableTimerAggregate {
  return {
    count: 0,
    totalMs: 0,
    minMs: 0,
    maxMs: 0,
    lastMs: 0,
  };
}

/**
 * Convert a telemetry tag map into a deterministic dimension key string.
 *
 * @param tags - Optional mapping of tag keys to values; entries with `null` or `undefined` values are ignored.
 * @returns A dimension string consisting of sorted `key=value` pairs joined by commas, or `DIMENSION_ALL` if there are no valid tags.
 */
function normalizeDimension(tags?: TelemetryTags): string {
  if (!tags) return DIMENSION_ALL;

  const entries = Object.entries(tags)
    .filter((entry): entry is [string, TelemetryTagValue] => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) return DIMENSION_ALL;

  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

/**
 * Convert a mutable timer aggregate into a snapshot suitable for serialization, with millisecond fields rounded to three decimals.
 *
 * @param aggregate - The mutable timer aggregate to convert
 * @returns A TelemetryTimerAggregateSnapshot containing `count`, `total_ms`, `avg_ms`, `min_ms`, `max_ms`, and `last_ms`; numeric millisecond fields are rounded to three decimal places and `avg_ms` is `0` when `count` is `0`.
 */
function toTimerSnapshot(aggregate: MutableTimerAggregate): TelemetryTimerAggregateSnapshot {
  const avgMs = aggregate.count > 0 ? aggregate.totalMs / aggregate.count : 0;
  return {
    count: aggregate.count,
    total_ms: Number(aggregate.totalMs.toFixed(3)),
    avg_ms: Number(avgMs.toFixed(3)),
    min_ms: Number(aggregate.minMs.toFixed(3)),
    max_ms: Number(aggregate.maxMs.toFixed(3)),
    last_ms: Number(aggregate.lastMs.toFixed(3)),
  };
}

export class TelemetryRegistry {
  private readonly scope: string;
  private readonly startedAtMs: number;
  private updatedAtMs: number;
  private readonly counters = new Map<string, MutableCounterBucket>();
  private readonly timers = new Map<string, MutableTimerBucket>();

  constructor(scope: string) {
    this.scope = scope;
    this.startedAtMs = Date.now();
    this.updatedAtMs = this.startedAtMs;
  }

  increment(counterName: string, value = 1, tags?: TelemetryTags): void {
    const safeValue = Number.isFinite(value) ? Number(value) : 0;
    if (safeValue === 0) return;

    const dimension = normalizeDimension(tags);
    const bucket = this.getCounterBucket(counterName);
    bucket.total += safeValue;
    bucket.byDimension.set(dimension, (bucket.byDimension.get(dimension) ?? 0) + safeValue);
    this.updatedAtMs = Date.now();
  }

  recordDuration(timerName: string, durationMs: number, tags?: TelemetryTags): number {
    if (!Number.isFinite(durationMs)) {
      return durationMs;
    }

    const safeDurationMs = Math.max(0, Number(durationMs));
    const dimension = normalizeDimension(tags);
    const bucket = this.getTimerBucket(timerName);
    this.applyDuration(bucket.overall, safeDurationMs);

    const byDimension = bucket.byDimension.get(dimension) ?? createTimerAggregate();
    this.applyDuration(byDimension, safeDurationMs);
    bucket.byDimension.set(dimension, byDimension);
    this.updatedAtMs = Date.now();

    return safeDurationMs;
  }

  startTimer(timerName: string, tags?: TelemetryTags): () => number {
    const startAtMs = Date.now();
    return () => this.recordDuration(timerName, Date.now() - startAtMs, tags);
  }

  snapshot(): TelemetrySnapshot {
    const counters: Record<string, TelemetryCounterSnapshot> = {};
    for (const [metric, bucket] of this.counters.entries()) {
      const byDimension: Record<string, number> = {};
      for (const [dimension, total] of bucket.byDimension.entries()) {
        byDimension[dimension] = Number(total.toFixed(3));
      }
      counters[metric] = {
        total: Number(bucket.total.toFixed(3)),
        by_dimension: byDimension,
      };
    }

    const timers: Record<string, TelemetryTimerSnapshot> = {};
    for (const [metric, bucket] of this.timers.entries()) {
      const byDimension: Record<string, TelemetryTimerAggregateSnapshot> = {};
      for (const [dimension, aggregate] of bucket.byDimension.entries()) {
        byDimension[dimension] = toTimerSnapshot(aggregate);
      }
      timers[metric] = {
        ...toTimerSnapshot(bucket.overall),
        by_dimension: byDimension,
      };
    }

    return {
      scope: this.scope,
      started_at_ms: this.startedAtMs,
      updated_at_ms: this.updatedAtMs,
      counters,
      timers,
    };
  }

  private getCounterBucket(counterName: string): MutableCounterBucket {
    const existing = this.counters.get(counterName);
    if (existing) {
      return existing;
    }

    const created: MutableCounterBucket = {
      total: 0,
      byDimension: new Map<string, number>(),
    };
    this.counters.set(counterName, created);
    return created;
  }

  private getTimerBucket(timerName: string): MutableTimerBucket {
    const existing = this.timers.get(timerName);
    if (existing) {
      return existing;
    }

    const created: MutableTimerBucket = {
      overall: createTimerAggregate(),
      byDimension: new Map<string, MutableTimerAggregate>(),
    };
    this.timers.set(timerName, created);
    return created;
  }

  private applyDuration(aggregate: MutableTimerAggregate, durationMs: number): void {
    aggregate.count += 1;
    aggregate.totalMs += durationMs;
    aggregate.lastMs = durationMs;
    if (aggregate.count === 1) {
      aggregate.minMs = durationMs;
      aggregate.maxMs = durationMs;
      return;
    }
    aggregate.minMs = Math.min(aggregate.minMs, durationMs);
    aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
  }
}

/**
 * Create a telemetry registry scoped to the given name.
 *
 * @param scope - Identifier used as the registry's scope in produced snapshots
 * @returns A TelemetryRegistry instance that collects counters and timers for the specified scope
 */
export function createTelemetry(scope: string): TelemetryRegistry {
  return new TelemetryRegistry(scope);
}
