import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";

const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
}));

vi.mock("../providers/llm/factory", () => ({
  createLLMProvider: vi.fn(() => ({
    complete: completeMock,
  })),
}));

import { AnalystSimple } from "./analyst-simple";

class MockStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(_at: number): Promise<void> {
    // no-op
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

function createAnalystEnv(): Env {
  const inert = createNamespace();
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ARTIFACTS: {} as R2Bucket,
    SESSION: inert,
    MCP_AGENT: inert,
    OWOKX_HARNESS: inert,
    DATA_SCOUT: createNamespace(async () => new Response(JSON.stringify({ signals: [] }), { status: 200 })),
    ANALYST: inert,
    TRADER: inert,
    SWARM_REGISTRY: inert,
    RISK_MANAGER: inert,
    LEARNING_AGENT: inert,
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

async function doFetch(analyst: AnalystSimple, url: string, init?: RequestInit): Promise<Response> {
  return analyst.fetch(new Request(url, init));
}

describe("AnalystSimple Phase 4", () => {
  beforeEach(() => {
    completeMock.mockReset();
  });

  it("reuses cached analysis for identical signal batches", async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify([
        {
          symbol: "AAPL",
          action: "BUY",
          confidence: 0.82,
          reasoning: "Momentum and sentiment aligned",
          urgency: "high",
        },
      ]),
    });

    const { ctx, waitForInit } = createContext("analyst-test-1");
    const analyst = new AnalystSimple(ctx, createAnalystEnv());
    await waitForInit();

    const payload = {
      signals: [{ symbol: "AAPL", sentiment: 0.8, volume: 120, sources: ["reddit"] }],
    };

    const first = await doFetch(analyst, "http://analyst/analyze", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const second = await doFetch(analyst, "http://analyst/analyze", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const firstData = (await first.json()) as { recommendations: unknown[] };
    const secondData = (await second.json()) as { recommendations: unknown[] };
    expect(firstData.recommendations.length).toBe(1);
    expect(secondData.recommendations.length).toBe(1);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("batches multi-symbol research and then serves cache hits", async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify([
        { symbol: "AAPL", verdict: "BUY", confidence: 0.77, reasoning: "Strong catalyst flow" },
        { symbol: "TSLA", verdict: "WAIT", confidence: 0.55, reasoning: "Mixed confirmation" },
      ]),
    });

    const { ctx, waitForInit } = createContext("analyst-test-2");
    const analyst = new AnalystSimple(ctx, createAnalystEnv());
    await waitForInit();

    const batchPayload = {
      signals: [
        { symbol: "AAPL", sentiment: 0.7 },
        { symbol: "TSLA", sentiment: 0.65 },
      ],
    };

    const first = await doFetch(analyst, "http://analyst/research-batch", {
      method: "POST",
      body: JSON.stringify(batchPayload),
    });
    const second = await doFetch(analyst, "http://analyst/research-batch", {
      method: "POST",
      body: JSON.stringify(batchPayload),
    });

    const firstData = (await first.json()) as { results: Record<string, { verdict: string }> };
    const secondData = (await second.json()) as { results: Record<string, { verdict: string }> };
    expect(firstData.results.AAPL?.verdict).toBe("BUY");
    expect(secondData.results.TSLA?.verdict).toBe("WAIT");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("opens LLM circuit after repeated failures and falls back without extra calls", async () => {
    completeMock.mockRejectedValue(new Error("upstream unavailable"));

    const { ctx, waitForInit } = createContext("analyst-test-3");
    const analyst = new AnalystSimple(ctx, createAnalystEnv());
    await waitForInit();

    const symbols = ["AAA", "BBB", "CCC", "DDD"];
    for (const symbol of symbols) {
      await doFetch(analyst, "http://analyst/analyze", {
        method: "POST",
        body: JSON.stringify({
          signals: [{ symbol, sentiment: 0.8, volume: 100, sources: ["stocktwits"] }],
        }),
      });
    }

    expect(completeMock).toHaveBeenCalledTimes(3);
  });
});
