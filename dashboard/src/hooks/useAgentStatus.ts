import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { fetchAgentStatus } from "../lib/api";
import type { Status } from "../types";

interface UseAgentStatusParams {
  enabled: boolean;
  pollMs?: number;
}

export interface UseAgentStatusResult {
  status: Status | null;
  error: string | null;
  refresh: () => Promise<void>;
  setStatus: Dispatch<SetStateAction<Status | null>>;
}

export function useAgentStatus({ enabled, pollMs = 5000 }: UseAgentStatusParams): UseAgentStatusResult {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchAgentStatus();
      if (payload.ok) {
        setStatus(payload.data ?? null);
        setError(null);
      } else {
        setStatus(payload.data ?? null);
        setError(payload.error || "Failed to fetch status");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.trim();
      setError(normalized.length > 0 ? normalized : "Connection failed - is the agent running?");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(interval);
  }, [enabled, pollMs, refresh]);

  return { status, error, refresh, setStatus };
}
