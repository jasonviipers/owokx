import type { Config, LogEntry, PortfolioSnapshot, Status } from "../types";

const API_BASE = "/api";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;

export interface SetupStatusData {
  configured?: boolean;
  api_origin?: string;
  auth?: {
    token_env_var?: string;
  };
  commands?: {
    enable?: {
      curl?: string;
    };
  };
}

export interface SwarmMetricsData {
  agents?: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    stale: number;
  };
  queue?: {
    queued: number;
    deadLettered: number;
    routingState: Record<string, number>;
  };
}

interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
}

interface RequestPolicy {
  timeoutMs?: number;
  retries?: number;
}

function getRequestHeaders(options: RequestInit): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  policy: RequestPolicy = {}
): Promise<{ response: Response; payload: T }> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = policy.retries ?? DEFAULT_RETRIES;
  const headers = getRequestHeaders(options);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(`Request timed out after ${timeoutMs}ms`), timeoutMs);

    try {
      const response = await fetch(path, {
        ...options,
        headers,
        credentials: "include",
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as T;
      if (!response.ok) {
        throw new Error(
          typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Request failed (${response.status})`
        );
      }

      return { response, payload };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await wait(150 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchSetupStatus(): Promise<ApiEnvelope<SetupStatusData>> {
  const { payload } = await requestJson<ApiEnvelope<SetupStatusData>>(`${API_BASE}/setup/status`, { method: "GET" });
  return payload;
}

export async function fetchAgentStatus(): Promise<ApiEnvelope<Status | null>> {
  const { payload } = await requestJson<ApiEnvelope<Status | null>>(`${API_BASE}/status`, { method: "GET" });
  return payload;
}

export interface LogsQuery {
  limit?: number;
  event_type?: string;
  severity?: string;
  since?: number;
}

export async function fetchAgentLogs(query: LogsQuery): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  if (query.event_type) params.set("event_type", query.event_type);
  if (query.severity) params.set("severity", query.severity);
  if (typeof query.since === "number" && Number.isFinite(query.since)) params.set("since", String(query.since));

  const { payload } = await requestJson<{ logs?: LogEntry[] }>(`${API_BASE}/logs?${params.toString()}`, { method: "GET" });
  return Array.isArray(payload.logs) ? payload.logs : [];
}

export async function fetchPortfolioHistory(period: "1D" | "1W" | "1M"): Promise<PortfolioSnapshot[]> {
  const timeframe = period === "1D" ? "15Min" : "1D";
  const intraday = period === "1D" ? "&intraday_reporting=extended_hours" : "";
  const path = `${API_BASE}/history?period=${period}&timeframe=${timeframe}${intraday}`;
  const { payload } = await requestJson<ApiEnvelope<{ snapshots?: PortfolioSnapshot[] }>>(path, { method: "GET" });
  return Array.isArray(payload.data?.snapshots) ? payload.data.snapshots : [];
}

export async function updateAgentConfig(config: Config): Promise<ApiEnvelope<Config>> {
  const { payload } = await requestJson<ApiEnvelope<Config>>(`${API_BASE}/config`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  return payload;
}

export async function resetAgent(): Promise<ApiEnvelope<unknown>> {
  const { payload } = await requestJson<ApiEnvelope<unknown>>(`${API_BASE}/reset`, {
    method: "POST",
  });
  return payload;
}

export async function setAgentEnabled(enabled: boolean): Promise<ApiEnvelope<unknown>> {
  const endpoint = enabled ? "enable" : "disable";
  const { payload } = await requestJson<ApiEnvelope<unknown>>(`${API_BASE}/${endpoint}`, {
    method: "POST",
  });
  return payload;
}

export async function fetchSwarmMetrics(): Promise<ApiEnvelope<SwarmMetricsData>> {
  const { payload } = await requestJson<ApiEnvelope<SwarmMetricsData>>(`${API_BASE}/swarm/metrics`, {
    method: "GET",
  });
  return payload;
}

export async function saveSessionToken(token: string): Promise<void> {
  await requestJson<{ ok?: boolean; error?: string }>("/auth/session", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function clearSessionToken(): Promise<void> {
  await requestJson<{ ok?: boolean; error?: string }>("/auth/session", {
    method: "DELETE",
  });
}

export interface SetupKeysPayload {
  alpaca_key: string;
  alpaca_secret: string;
  openai_key?: string;
  paper_mode: boolean;
  starting_equity: number;
}

export async function saveSetupKeys(payload: SetupKeysPayload): Promise<ApiEnvelope<unknown>> {
  const { payload: responsePayload } = await requestJson<ApiEnvelope<unknown>>(`${API_BASE}/setup/keys`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return responsePayload;
}
