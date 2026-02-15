import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

vi.mock("../providers/llm/factory", () => ({
  createLLMProvider: vi.fn(() => null),
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
}

function createId(id: string): DurableObjectId {
  return { toString: () => id } as unknown as DurableObjectId;
}

function createNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => createId(name),
    idFromString: (id: string) => createId(id),
    get: (_id: DurableObjectId) =>
      ({
        fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
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
      // no-op for tests
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

describe("OwokxHarness AI optimization policy", () => {
  it("routes research tasks to the lower-latency/lower-cost model when quality is comparable", async () => {
    const { ctx, waitForInit } = createContext("owokx-routing-1");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    state.config.llm_model = "gpt-4o-mini";
    state.config.llm_analyst_model = "gpt-4o";
    state.llmRouting.perModel["gpt-4o-mini"] = {
      calls: 30,
      successes: 28,
      failures: 2,
      parseFailures: 1,
      latencyEmaMs: 360,
      costEmaUsd: 0.00025,
      lastUsedAt: Date.now(),
    };
    state.llmRouting.perModel["gpt-4o"] = {
      calls: 30,
      successes: 29,
      failures: 1,
      parseFailures: 1,
      latencyEmaMs: 1500,
      costEmaUsd: 0.0022,
      lastUsedAt: Date.now(),
    };

    const selection = (harness as any).selectModelForTask("research", { stressFailed: false });
    expect(selection.model).toBe("gpt-4o-mini");
  });

  it("adapts prompt depth based on volatility and stress", async () => {
    const { ctx, waitForInit } = createContext("owokx-routing-2");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const lean = (harness as any).resolvePromptPolicy("research", {
      candidateCount: 1,
      stressFailed: false,
      volatility: 0.008,
      avgSignalStrength: 0.15,
    });
    const deep = (harness as any).resolvePromptPolicy("analyst", {
      candidateCount: 12,
      stressFailed: true,
      volatility: 0.07,
      avgSignalStrength: 0.9,
    });

    expect(lean.tier).toBe("lean");
    expect(deep.tier).toBe("deep");
    expect(deep.maxTokens).toBeGreaterThan(lean.maxTokens);
  });

  it("raises buy gating threshold under stress and lowers sell threshold", async () => {
    const { ctx, waitForInit } = createContext("owokx-routing-3");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    state.config.min_analyst_confidence = 0.6;
    state.marketRegime.type = "volatile";
    state.marketRegime.confidence = 0.9;
    state.llmRouting.confidenceCalibrationEmaError = 0.55;
    state.llmRouting.perModel["gpt-4o-mini"] = {
      calls: 40,
      successes: 30,
      failures: 10,
      parseFailures: 8,
      latencyEmaMs: 900,
      costEmaUsd: 0.0005,
      lastUsedAt: Date.now(),
    };

    const buyThreshold = (harness as any).getCalibratedConfidenceThreshold("analyst_buy", true);
    const sellThreshold = (harness as any).getCalibratedConfidenceThreshold("analyst_sell", true);
    expect(buyThreshold).toBeGreaterThan(0.6);
    expect(sellThreshold).toBeLessThan(buyThreshold);
  });

  it("down-calibrates confidence scale after overconfident losses", async () => {
    const { ctx, waitForInit } = createContext("owokx-routing-4");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    const before = state.llmRouting.confidenceScale;

    (harness as any).updateConfidenceCalibration(0.92, 0);
    (harness as any).updateConfidenceCalibration(0.88, 0);

    const after = state.llmRouting.confidenceScale;
    expect(after).toBeLessThan(before);
  });

  it("tunes routing weights and gating constants from live telemetry", async () => {
    const { ctx, waitForInit } = createContext("owokx-routing-5");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    state.optimization.researchLatencyEmaMs = 9_200;
    state.optimization.analystLatencyEmaMs = 11_000;
    state.optimization.errorRateEma = 0.27;
    state.llmRouting.confidenceCalibrationEmaError = 0.52;
    state.llmRouting.perModel["gpt-4o-mini"] = {
      calls: 80,
      successes: 52,
      failures: 28,
      parseFailures: 18,
      latencyEmaMs: 1200,
      costEmaUsd: 0.0007,
      lastUsedAt: Date.now(),
    };

    const beforeQuality = state.llmRouting.selectorWeights.quality;
    const beforeBaseBias = state.llmRouting.gating.baseBias;

    (harness as any).tuneLLMPolicyFromTelemetry();

    expect(state.llmRouting.selectorWeights.quality).toBeGreaterThan(beforeQuality);
    expect(state.llmRouting.gating.baseBias).toBeGreaterThan(beforeBaseBias);
  });
});
