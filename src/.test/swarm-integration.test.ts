import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const { completeMock, executeOrderMock, createBrokerProvidersMock, createD1ClientMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  executeOrderMock: vi.fn(),
  createBrokerProvidersMock: vi.fn(),
  createD1ClientMock: vi.fn(() => ({})),
}));

vi.mock("../providers/llm/factory", () => ({
  createLLMProvider: vi.fn(() => ({
    complete: completeMock,
  })),
}));

vi.mock("../execution/execute-order", () => ({
  executeOrder: executeOrderMock,
}));

vi.mock("../providers/broker-factory", () => ({
  createBrokerProviders: createBrokerProvidersMock,
}));

vi.mock("../storage/d1/client", () => ({
  createD1Client: createD1ClientMock,
}));

import { AnalystSimple } from "../durable-objects/analyst-simple";
import { SwarmRegistry } from "../durable-objects/swarm-registry";
import { TraderSimple } from "../durable-objects/trader-simple";

class MockStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(_at: number): Promise<void> {
    // no-op for tests
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

function createBaseEnv(overrides: Partial<Env>): Env {
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
    ...overrides,
  } as Env;
}

async function doFetch(
  target: { fetch: (request: Request) => Promise<Response> },
  url: string,
  init?: RequestInit
): Promise<Response> {
  return target.fetch(new Request(url, init));
}

describe("Swarm integration", () => {
  beforeEach(() => {
    completeMock.mockReset();
    executeOrderMock.mockReset();
    createBrokerProvidersMock.mockReset();
    createD1ClientMock.mockReset();
    createD1ClientMock.mockImplementation(() => ({}));

    createBrokerProvidersMock.mockImplementation(() => ({
      broker: "alpaca",
      trading: {
        getAccount: vi.fn(async () => ({ cash: 10_000 })),
        getPosition: vi.fn(async () => null),
      },
      marketData: {},
      options: {},
    }));

    executeOrderMock.mockResolvedValue({
      submission: { state: "SUBMITTED" },
    });

    completeMock.mockResolvedValue({
      content: JSON.stringify([
        {
          symbol: "AAPL",
          action: "BUY",
          confidence: 0.9,
          reasoning: "Strong coordinated sentiment",
          urgency: "high",
        },
      ]),
    });
  });

  it("delivers analyst recommendations through the registry to trader execution", async () => {
    let registry: SwarmRegistry;
    let analyst: AnalystSimple | null = null;
    let trader: TraderSimple | null = null;

    const registryNamespace = createNamespace((request) => registry.fetch(request));
    const analystNamespace = createNamespace((request) => {
      if (!analyst) {
        return new Response(JSON.stringify({ error: "analyst unavailable" }), { status: 503 });
      }
      return analyst.fetch(request);
    });
    const traderNamespace = createNamespace((request) => {
      if (!trader) {
        return new Response(JSON.stringify({ error: "trader unavailable" }), { status: 503 });
      }
      return trader.fetch(request);
    });
    const dataScoutNamespace = createNamespace((request) => {
      if (new URL(request.url).pathname === "/signals") {
        return new Response(
          JSON.stringify({
            signals: [{ symbol: "AAPL", sentiment: 0.82, volume: 150, sources: ["reddit"] }],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const riskNamespace = createNamespace((request) => {
      if (new URL(request.url).pathname === "/validate") {
        return new Response(JSON.stringify({ approved: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const learningNamespace = createNamespace(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/strategy") {
        return new Response(
          JSON.stringify({
            minConfidenceBuy: 0.7,
            maxPositionNotional: 5000,
            riskMultiplier: 1,
          }),
          { status: 200 }
        );
      }
      if (path === "/advice") {
        const body = (await request.json()) as { confidence?: number };
        return new Response(
          JSON.stringify({
            approved: true,
            adjustedConfidence: typeof body.confidence === "number" ? body.confidence : 0.8,
            reasons: [],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const sharedEnv = createBaseEnv({
      SWARM_REGISTRY: registryNamespace,
      DATA_SCOUT: dataScoutNamespace,
      ANALYST: analystNamespace,
      TRADER: traderNamespace,
      RISK_MANAGER: riskNamespace,
      LEARNING_AGENT: learningNamespace,
    });

    const registryCtx = createContext("registry-int-1");
    registry = new SwarmRegistry(registryCtx.ctx, sharedEnv);
    await registryCtx.waitForInit();

    const analystCtx = createContext("analyst-int-1");
    analyst = new AnalystSimple(analystCtx.ctx, sharedEnv);
    await analystCtx.waitForInit();

    const traderCtx = createContext("trader-int-1");
    trader = new TraderSimple(traderCtx.ctx, sharedEnv);
    await traderCtx.waitForInit();

    const analyzeRes = await doFetch(analyst, "http://analyst/analysis-cycle", {
      method: "POST",
    });
    expect(analyzeRes.ok).toBe(true);

    const dispatchRes = await doFetch(registry, "http://registry/queue/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: 25 }),
    });
    const dispatch = (await dispatchRes.json()) as { delivered: number };
    expect(dispatch.delivered).toBeGreaterThanOrEqual(1);
    expect(executeOrderMock).toHaveBeenCalledTimes(1);

    const orderArgs = executeOrderMock.mock.calls[0]?.[0] as { order?: { symbol?: string } } | undefined;
    expect(orderArgs?.order?.symbol).toBe("AAPL");

    const historyRes = await doFetch(trader, "http://trader/history");
    const history = (await historyRes.json()) as {
      trades: Array<{ symbol: string; success: boolean }>;
    };
    expect(history.trades).toHaveLength(1);
    expect(history.trades[0]?.symbol).toBe("AAPL");
    expect(history.trades[0]?.success).toBe(true);
  });

  it("requeues dead-lettered messages and completes delivery when trader recovers", async () => {
    let registry: SwarmRegistry;
    let trader: TraderSimple | null = null;

    const registryNamespace = createNamespace((request) => registry.fetch(request));
    const traderNamespace = createNamespace((request) => {
      if (!trader) {
        return new Response(JSON.stringify({ error: "trader unavailable" }), { status: 503 });
      }
      return trader.fetch(request);
    });
    const riskNamespace = createNamespace((request) => {
      if (new URL(request.url).pathname === "/validate") {
        return new Response(JSON.stringify({ approved: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const learningNamespace = createNamespace(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/strategy") {
        return new Response(
          JSON.stringify({
            minConfidenceBuy: 0.7,
            maxPositionNotional: 5000,
            riskMultiplier: 1,
          }),
          { status: 200 }
        );
      }
      if (path === "/advice") {
        const body = (await request.json()) as { confidence?: number };
        return new Response(
          JSON.stringify({
            approved: true,
            adjustedConfidence: typeof body.confidence === "number" ? body.confidence : 0.8,
            reasons: [],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const sharedEnv = createBaseEnv({
      SWARM_REGISTRY: registryNamespace,
      TRADER: traderNamespace,
      RISK_MANAGER: riskNamespace,
      LEARNING_AGENT: learningNamespace,
    });

    const registryCtx = createContext("registry-int-2");
    registry = new SwarmRegistry(registryCtx.ctx, sharedEnv);
    await registryCtx.waitForInit();

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "integration-dlq-msg-1",
          source: "analyst-int-2",
          target: "trader-int-2",
          type: "EVENT",
          topic: "analysis_ready",
          payload: {
            recommendations: [{ symbol: "MSFT", action: "BUY", confidence: 0.88 }],
          },
          timestamp: Date.now(),
        },
        maxAttempts: 1,
      }),
    });

    await doFetch(registry, "http://registry/queue/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: 25 }),
    });

    const firstStateRes = await doFetch(registry, "http://registry/queue/state", {
      method: "GET",
    });
    const firstState = (await firstStateRes.json()) as {
      deadLettered: number;
      queued: number;
    };
    expect(firstState.deadLettered).toBe(1);
    expect(firstState.queued).toBe(0);
    expect(executeOrderMock).toHaveBeenCalledTimes(0);

    const traderCtx = createContext("trader-int-2");
    trader = new TraderSimple(traderCtx.ctx, sharedEnv);
    await traderCtx.waitForInit();

    const requeueRes = await doFetch(registry, "http://registry/recovery/requeue-dead-letter", {
      method: "POST",
      body: JSON.stringify({ limit: 10 }),
    });
    const requeue = (await requeueRes.json()) as { requeued: number; remaining: number };
    expect(requeue.requeued).toBe(1);
    expect(requeue.remaining).toBe(0);

    const dispatchRes = await doFetch(registry, "http://registry/queue/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: 25 }),
    });
    const dispatch = (await dispatchRes.json()) as { delivered: number };
    expect(dispatch.delivered).toBe(1);
    expect(executeOrderMock).toHaveBeenCalledTimes(1);

    const orderArgs = executeOrderMock.mock.calls[0]?.[0] as { order?: { symbol?: string } } | undefined;
    expect(orderArgs?.order?.symbol).toBe("MSFT");
  });
});
