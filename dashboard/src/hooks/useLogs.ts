import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAgentLogs } from "../lib/api";
import type { LogEntry } from "../types";

interface UseLogsParams {
  enabled: boolean;
  eventType?: string;
  severity?: string;
  timeRangeMs: number | null;
  pollMs?: number;
}

export interface UseLogsResult {
  logs: LogEntry[];
  ready: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function getLogTimestampMs(log: LogEntry): number {
  if (typeof log.timestamp_ms === "number" && Number.isFinite(log.timestamp_ms)) return log.timestamp_ms;
  const parsed = Date.parse(log.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function useLogs({
  enabled,
  eventType,
  severity,
  timeRangeMs,
  pollMs = 10000,
}: UseLogsParams): UseLogsResult {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;

    try {
      const windowStart = timeRangeMs !== null ? Date.now() - timeRangeMs : null;
      const since =
        windowStart === null
          ? sinceRef.current ?? undefined
          : sinceRef.current
            ? Math.max(windowStart, sinceRef.current)
            : windowStart;

      const fetchedLogs = await fetchAgentLogs({
        limit: timeRangeMs === null ? 250 : 120,
        event_type: eventType && eventType !== "all" ? eventType : undefined,
        severity: severity && severity !== "all" ? severity : undefined,
        since,
      });
      const sorted = [...fetchedLogs].sort((a, b) => getLogTimestampMs(b) - getLogTimestampMs(a));
      setLogs(sorted);
      setReady(true);
      setError(null);

      if (sorted.length > 0) {
        const newest = getLogTimestampMs(sorted[0]!);
        sinceRef.current = Number.isFinite(newest) ? newest + 1 : sinceRef.current;
      }
    } catch {
      setError("Failed to fetch activity logs");
      // Leave previous payload in place so consumers can fallback gracefully.
    }
  }, [enabled, eventType, severity, timeRangeMs]);

  useEffect(() => {
    if (!enabled) return;
    sinceRef.current = null;
    setLogs([]);
    setReady(false);
    void refresh();
  }, [enabled, eventType, severity, timeRangeMs, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(interval);
  }, [enabled, pollMs, refresh]);

  return { logs, ready, error, refresh };
}
