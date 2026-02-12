import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";

const { executeOrderMock, createBrokerProvidersMock, createD1ClientMock } = vi.hoisted(() => ({
  executeOrderMock: vi.fn(),
  createBrokerProvidersMock: vi.fn(),
  createD1ClientMock: vi.fn(() => ({})),
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

import { TraderSimple } from "./trader-simple";

class MockStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(_at: number): Promise<void> {
    // no-op in tests
  }
}

function createId(id: string): DurableObjectId {
  return { toString: () => id } as unknown as DurableObjectId;
}

function createNamespace(fetchImpl: (request: Request) => Promise<Response> | Response): DurableObjectNamespace {
  return {
    idFromName: (name: string) => createId(name),
    idFromString: (id: string) => createId(id),
    get: (_id: DurableObjectId) =>
      ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          return Promise.resolve(fetchImpl(request));
        },
      }) as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function createContext(id: string): {
  ctx: DurableObjectState;
  waitForInit: () => Promise<void>;
} {
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

function createTraderEnv(riskApproved: { current: boolean }): Env {
  const swarmRegistryNamespace = createNamespace(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  const riskNamespace = createNamespace(async (request: Request) => {
    if (new URL(request.url).pathname === "/validate") {
      if (riskApproved.current) {
        return new Response(JSON.stringify({ approved: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ approved: false, reason: "Kill switch is active" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ARTIFACTS: {} as R2Bucket,
    SESSION: swarmRegistryNamespace,
    MCP_AGENT: swarmRegistryNamespace,
    OWOKX_HARNESS: swarmRegistryNamespace,
    DATA_SCOUT: swarmRegistryNamespace,
    ANALYST: swarmRegistryNamespace,
    TRADER: swarmRegistryNamespace,
    SWARM_REGISTRY: swarmRegistryNamespace,
    RISK_MANAGER: riskNamespace,
    ALPACA_API_KEY: "x",
    ALPACA_API_SECRET: "y",
    OWOKX_API_TOKEN: "t",
    KILL_SWITCH_SECRET: "k",
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

async function doFetch(trader: TraderSimple, url: string, init?: RequestInit): Promise<Response> {
  return trader.fetch(new Request(url, init));
}

describe("TraderSimple risk gating", () => {
  beforeEach(() => {
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
      submission: {
        state: "SUBMITTED",
      },
    });
  });

  it("blocks direct buy when risk manager rejects order", async () => {
    const riskApproved = { current: false };
    const { ctx, waitForInit } = createContext("trader-test-1");
    const trader = new TraderSimple(ctx, createTraderEnv(riskApproved));
    await waitForInit();

    const response = await doFetch(trader, "http://trader/buy", {
      method: "POST",
      body: JSON.stringify({
        symbol: "AAPL",
        confidence: 0.9,
        account: { cash: 10_000 },
      }),
    });
    const payload = (await response.json()) as { success: boolean };

    expect(payload.success).toBe(false);
    expect(executeOrderMock).not.toHaveBeenCalled();
  });

  it("allows direct buy when risk manager approves order", async () => {
    const riskApproved = { current: true };
    const { ctx, waitForInit } = createContext("trader-test-2");
    const trader = new TraderSimple(ctx, createTraderEnv(riskApproved));
    await waitForInit();

    const response = await doFetch(trader, "http://trader/buy", {
      method: "POST",
      body: JSON.stringify({
        symbol: "MSFT",
        confidence: 0.85,
        account: { cash: 10_000 },
      }),
    });
    const payload = (await response.json()) as { success: boolean };

    expect(payload.success).toBe(true);
    expect(executeOrderMock).toHaveBeenCalledTimes(1);
  });

  it("blocks analysis-driven BUY recommendations when risk manager rejects", async () => {
    const riskApproved = { current: false };
    const { ctx, waitForInit } = createContext("trader-test-3");
    const trader = new TraderSimple(ctx, createTraderEnv(riskApproved));
    await waitForInit();

    await doFetch(trader, "http://trader/message", {
      method: "POST",
      body: JSON.stringify({
        id: "msg-analysis-1",
        source: "analyst-1",
        target: "trader-test-3",
        type: "EVENT",
        topic: "analysis_ready",
        payload: {
          recommendations: [
            { symbol: "NVDA", action: "BUY", confidence: 0.9 },
            { symbol: "TSLA", action: "WAIT", confidence: 0.5 },
          ],
        },
        timestamp: Date.now(),
      }),
    });

    expect(executeOrderMock).not.toHaveBeenCalled();
  });
});
