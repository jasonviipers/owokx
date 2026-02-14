import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { LearningAgent } from "../durable-objects/learning-agent";

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

function createLearningEnv(): Env {
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

async function doFetch(agent: LearningAgent, url: string, init?: RequestInit): Promise<Response> {
  return agent.fetch(new Request(url, init));
}

describe("LearningAgent", () => {
  it("tracks outcome performance and exposes summary", async () => {
    const { ctx, waitForInit } = createContext("learning-test-1");
    const agent = new LearningAgent(ctx, createLearningEnv());
    await waitForInit();

    await doFetch(agent, "http://learning/record-outcome", {
      method: "POST",
      body: JSON.stringify({
        symbol: "AAPL",
        side: "buy",
        notional: 1000,
        success: true,
        pnl: 50,
      }),
    });

    await doFetch(agent, "http://learning/record-outcome", {
      method: "POST",
      body: JSON.stringify({
        symbol: "AAPL",
        side: "sell",
        notional: 1000,
        success: false,
        pnl: -20,
      }),
    });

    const summaryRes = await doFetch(agent, "http://learning/summary", { method: "GET" });
    const summary = (await summaryRes.json()) as {
      performance: { samples: number; wins: number; losses: number };
      symbols: Array<{ symbol: string; samples: number }>;
    };
    expect(summary.performance.samples).toBe(2);
    expect(summary.performance.wins).toBe(1);
    expect(summary.performance.losses).toBe(1);
    expect(summary.symbols[0]?.symbol).toBe("AAPL");
    expect(summary.symbols[0]?.samples).toBe(2);
  });

  it("tightens strategy after sustained weak performance", async () => {
    const { ctx, waitForInit } = createContext("learning-test-2");
    const agent = new LearningAgent(ctx, createLearningEnv());
    await waitForInit();

    for (let i = 0; i < 12; i += 1) {
      await doFetch(agent, "http://learning/record-outcome", {
        method: "POST",
        body: JSON.stringify({
          symbol: "TSLA",
          side: "buy",
          notional: 1000,
          success: false,
          pnl: -15,
        }),
      });
    }

    const optimizeRes = await doFetch(agent, "http://learning/optimize", {
      method: "POST",
      body: JSON.stringify({ reason: "test" }),
    });
    const optimize = (await optimizeRes.json()) as {
      updated: boolean;
      strategy: { minConfidenceBuy: number; maxPositionNotional: number };
    };

    expect(optimize.updated).toBe(true);
    expect(optimize.strategy.minConfidenceBuy).toBeGreaterThan(0.7);
    expect(optimize.strategy.maxPositionNotional).toBeLessThan(5000);
  });

  it("returns collaborative advice with symbol-level adjustments", async () => {
    const { ctx, waitForInit } = createContext("learning-test-3");
    const agent = new LearningAgent(ctx, createLearningEnv());
    await waitForInit();

    for (let i = 0; i < 3; i += 1) {
      await doFetch(agent, "http://learning/record-outcome", {
        method: "POST",
        body: JSON.stringify({
          symbol: "NVDA",
          side: "buy",
          notional: 1000,
          success: false,
        }),
      });
    }

    const adviceRes = await doFetch(agent, "http://learning/advice", {
      method: "POST",
      body: JSON.stringify({
        symbol: "NVDA",
        confidence: 0.72,
      }),
    });
    const advice = (await adviceRes.json()) as {
      approved: boolean;
      adjustedConfidence: number;
      reasons: string[];
    };

    expect(advice.adjustedConfidence).toBeLessThan(0.72);
    expect(advice.approved).toBe(false);
    expect(advice.reasons.length).toBeGreaterThan(0);
  });
});
