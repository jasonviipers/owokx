import { useCallback, useEffect, useState } from "react";
import { fetchSwarmMetrics, type SwarmMetricsData } from "../lib/api";

interface UseSwarmMetricsParams {
  enabled: boolean;
  pollMs?: number;
}

export interface UseSwarmMetricsResult {
  metrics: SwarmMetricsData | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSwarmMetrics({ enabled, pollMs = 10000 }: UseSwarmMetricsParams): UseSwarmMetricsResult {
  const [metrics, setMetrics] = useState<SwarmMetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const payload = await fetchSwarmMetrics();
      if (payload.ok) {
        setMetrics(payload.data ?? null);
        setError(null);
      } else {
        setError(payload.error || "Failed to fetch swarm metrics");
      }
    } catch {
      setError("Failed to fetch swarm metrics");
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(interval);
  }, [enabled, pollMs, refresh]);

  return { metrics, error, refresh };
}
