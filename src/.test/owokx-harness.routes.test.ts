import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

vi.mock("../providers/llm/factory", () => ({
  createLLMProvider: vi.fn(() => null),
}));

vi.mock("../providers/broker-factory", () => ({
  createBrokerProviders: vi.fn(() => ({
    broker: "alpaca",
    trading: {
      getAccount: vi.fn(async () => ({
        id: "acct-1",
        account_number: "acct-1",
        status: "ACTIVE",
        currency: "USD",
        cash: 10000,
        buying_power: 10000,
        regt_buying_power: 10000,
        daytrading_buying_power: 10000,
        equity: 10000,
        last_equity: 10000,
        long_market_value: 0,
        short_market_value: 0,
        portfolio_value: 10000,
        pattern_day_trader: false,
        trading_blocked: false,
        transfers_blocked: false,
        account_blocked: false,
        multiplier: "1",
        shorting_enabled: false,
        maintenance_margin: 0,
        initial_margin: 0,
        daytrade_count: 0,
        created_at: new Date().toISOString(),
      })),
      getPositions: vi.fn(async () => []),
      getClock: vi.fn(async () => ({
        timestamp: new Date().toISOString(),
        is_open: true,
        next_open: new Date().toISOString(),
        next_close: new Date().toISOString(),
      })),
      getAsset: vi.fn(async () => null),
      createOrder: vi.fn(),
      getPosition: vi.fn(async () => null),
      closePosition: vi.fn(),
      getOrder: vi.fn(),
      listOrders: vi.fn(async () => []),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getCalendar: vi.fn(async () => []),
      getPortfolioHistory: vi.fn(async () => ({ equity: [], profit_loss: [], profit_loss_pct: [], timestamp: [] })),
    },
    marketData: {
      getLatestQuote: vi.fn(async () => null),
      getBars: vi.fn(async () => []),
      getSnapshot: vi.fn(async () => null),
      getNews: vi.fn(async () => []),
      getTrades: vi.fn(async () => []),
      getHistoricalBars: vi.fn(async () => []),
      getLatestBar: vi.fn(async () => null),
      getMarketStatus: vi.fn(async () => ({ is_open: true })),
      getCorporateActions: vi.fn(async () => []),
      getDividends: vi.fn(async () => []),
      getSplits: vi.fn(async () => []),
      getExchanges: vi.fn(async () => []),
      getSymbols: vi.fn(async () => []),
    },
    options: {},
  })),
}));

import { OwokxHarness } from "../durable-objects/owokx-harness";

class MockStorage {
  private data = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
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

function createContext(id: string): { ctx: DurableObjectState; waitForInit: () => Promise<void> } {
  const storage = new MockStorage();
  let initPromise = Promise.resolve();
  const ctx = {
    id: createId(id),
    storage,
    waitUntil: (_promise: Promise<unknown>) => {
      // no-op in tests
    },
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      initPromise = fn();
      return initPromise;
    },
  } as unknown as DurableObjectState;

  return {
    ctx,
    waitForInit: async () => {
      await initPromise;
    },
  };
}

function createEnv(): Env {
  const inert = createNamespace();
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
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
    OWOKX_API_TOKEN_READONLY: "read-token",
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
  } as Env;
}

async function doFetch(target: OwokxHarness, path: string, init?: RequestInit): Promise<Response> {
  return target.fetch(new Request(`http://harness${path}`, init));
}

describe("OwokxHarness route regression", () => {
  it("requires auth for status/config/metrics/trigger routes", async () => {
    const { ctx, waitForInit } = createContext("harness-routes-auth");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const status = await doFetch(harness, "/status");
    const config = await doFetch(harness, "/config");
    const metrics = await doFetch(harness, "/metrics");
    const trigger = await doFetch(harness, "/trigger", { method: "POST" });

    expect(status.status).toBe(401);
    expect(config.status).toBe(401);
    expect(metrics.status).toBe(401);
    expect(trigger.status).toBe(401);
  });

  it("returns config, status, and metrics for authorized requests", async () => {
    const { ctx, waitForInit } = createContext("harness-routes-read");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const headers = { Authorization: "Bearer read-token" };

    const configResponse = await doFetch(harness, "/config", { headers });
    const configPayload = (await configResponse.json()) as { ok: boolean; data: { broker?: string } };
    expect(configResponse.ok).toBe(true);
    expect(configPayload.ok).toBe(true);
    expect(typeof configPayload.data).toBe("object");

    const statusResponse = await doFetch(harness, "/status", { headers });
    const statusPayload = (await statusResponse.json()) as {
      ok: boolean;
      data: { enabled: boolean; config: Record<string, unknown> };
    };
    expect(statusResponse.ok).toBe(true);
    expect(statusPayload.ok).toBe(true);
    expect(typeof statusPayload.data.enabled).toBe("boolean");
    expect(typeof statusPayload.data.config).toBe("object");

    const metricsResponse = await doFetch(harness, "/metrics", { headers });
    const metricsPayload = (await metricsResponse.json()) as {
      ok: boolean;
      data: {
        logs_total: number;
        llm: Record<string, unknown>;
        telemetry: {
          scope: string;
          counters: Record<string, unknown>;
          timers: Record<string, unknown>;
        };
      };
    };
    expect(metricsResponse.ok).toBe(true);
    expect(metricsPayload.ok).toBe(true);
    expect(typeof metricsPayload.data.logs_total).toBe("number");
    expect(typeof metricsPayload.data.llm).toBe("object");
    expect(metricsPayload.data.telemetry.scope).toBe("owokx_harness");
    expect(typeof metricsPayload.data.telemetry.counters).toBe("object");
    expect(typeof metricsPayload.data.telemetry.timers).toBe("object");
  });

  it("routes trigger to alarm execution when trade auth is present", async () => {
    const { ctx, waitForInit } = createContext("harness-routes-trigger");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const alarmSpy = vi.spyOn(harness, "alarm").mockResolvedValue();
    const response = await doFetch(harness, "/trigger", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
    });
    const payload = (await response.json()) as { ok: boolean; message?: string };

    expect(response.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.message).toBe("Alarm triggered");
    expect(alarmSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects non-POST trigger requests with 405 and Allow header", async () => {
    const { ctx, waitForInit } = createContext("harness-routes-trigger-method");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const alarmSpy = vi.spyOn(harness, "alarm").mockResolvedValue();
    const response = await doFetch(harness, "/trigger", {
      method: "GET",
      headers: { Authorization: "Bearer token" },
    });
    const payload = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Method not allowed");
    expect(alarmSpy).not.toHaveBeenCalled();
  });
});
