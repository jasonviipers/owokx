import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertNotifier } from "../alerts/notifier";
import type { AlertEvent } from "../alerts/rules";
import type { Env } from "../env.d";

class MockKVNamespace {
  private readonly store = new Map<string, { value: string; expiresAtMs: number | null }>();

  async get(key: string): Promise<string | null> {
    const current = this.store.get(key);
    if (!current) return null;
    if (current.expiresAtMs !== null && current.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return current.value;
  }

  async put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
    }
  ): Promise<void> {
    const expiresAtMs =
      options?.expirationTtl && Number.isFinite(options.expirationTtl)
        ? Date.now() + options.expirationTtl * 1000
        : null;
    this.store.set(key, {
      value,
      expiresAtMs,
    });
  }
}

function createId(id: string): DurableObjectId {
  return { toString: () => id } as unknown as DurableObjectId;
}

function createNamespace(fetchImpl?: (request: Request) => Promise<Response> | Response): DurableObjectNamespace {
  const impl = fetchImpl ?? (() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  return {
    idFromName: (name: string) => createId(name),
    idFromString: (id: string) => createId(id),
    get: (_id: DurableObjectId) =>
      ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          return Promise.resolve(impl(request));
        },
      }) as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function buildAlert(fingerprint: string): AlertEvent {
  return {
    id: `alert:${fingerprint}`,
    rule: "swarm_dead_letter_queue",
    severity: "warning",
    title: "DLQ warning",
    message: "Dead letter queue threshold reached",
    fingerprint,
    occurred_at: new Date().toISOString(),
    details: {},
  };
}

function createEnv(overrides: Partial<Env> = {}): Env {
  const inert = createNamespace();
  return {
    DB: {} as D1Database,
    CACHE: new MockKVNamespace() as unknown as KVNamespace,
    ARTIFACTS: {} as R2Bucket,
    SESSION: inert,
    MCP_AGENT: inert,
    OWOKX_HARNESS: inert,
    DATA_SCOUT: inert,
    ANALYST: inert,
    TRADER: inert,
    SWARM_REGISTRY: inert,
    RISK_MANAGER: inert,
    LEARNING_AGENT: inert,
    ALPACA_API_KEY: "x",
    ALPACA_API_SECRET: "y",
    OWOKX_API_TOKEN: "token",
    KILL_SWITCH_SECRET: "kill",
    ENVIRONMENT: "test",
    FEATURE_LLM_RESEARCH: "false",
    FEATURE_OPTIONS: "false",
    DEFAULT_MAX_POSITION_PCT: "0.1",
    DEFAULT_MAX_NOTIONAL_PER_TRADE: "5000",
    DEFAULT_MAX_DAILY_LOSS_PCT: "0.02",
    DEFAULT_COOLDOWN_MINUTES: "30",
    DEFAULT_MAX_OPEN_POSITIONS: "10",
    DEFAULT_APPROVAL_TTL_SECONDS: "300",
    ALERTS_ENABLED: "true",
    ALERT_CHANNELS: "webhook",
    ALERT_WEBHOOK_URL: "https://alerts.example/webhook",
    ALERT_DEDUPE_WINDOW_SECONDS: "600",
    ALERT_RATE_LIMIT_MAX_PER_WINDOW: "10",
    ALERT_RATE_LIMIT_WINDOW_SECONDS: "300",
    ...overrides,
  } as Env;
}

describe("alert notifier", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deduplicates alerts by fingerprint", async () => {
    const env = createEnv();
    const notifier = createAlertNotifier(env);
    const alert = buildAlert("dedupe-key");

    const first = await notifier.notify([alert]);
    const second = await notifier.notify([alert]);

    expect(first.sent).toBe(1);
    expect(first.deduped).toBe(0);
    expect(second.sent).toBe(0);
    expect(second.deduped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rate limits alerts per channel window", async () => {
    const env = createEnv({
      ALERT_RATE_LIMIT_MAX_PER_WINDOW: "2",
    });
    const notifier = createAlertNotifier(env);

    const summary = await notifier.notify([buildAlert("a1"), buildAlert("a2"), buildAlert("a3")]);

    expect(summary.sent).toBe(2);
    expect(summary.rate_limited).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
