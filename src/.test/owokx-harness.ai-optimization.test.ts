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

function createAccount(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    id: "acct-1",
    account_number: "A-1",
    status: "ACTIVE",
    currency: "USD",
    cash: 10_000,
    buying_power: 20_000,
    regt_buying_power: 20_000,
    daytrading_buying_power: 20_000,
    equity: 10_000,
    last_equity: 10_000,
    long_market_value: 0,
    short_market_value: 0,
    portfolio_value: 10_000,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    multiplier: "1",
    shorting_enabled: true,
    maintenance_margin: 0,
    initial_margin: 0,
    daytrade_count: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
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

  it("forecasts regime probabilities that stay normalized", async () => {
    const { ctx, waitForInit } = createContext("owokx-forecast-1");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    state.marketRegime.characteristics = {
      volatility: 0.055,
      trend: 0.05,
      sharpe_like: 0.1,
      sentiment_dispersion: 0.5,
    };

    const probs = (harness as any).updateRegimeForecast("volatile");
    const sum = probs.trending + probs.ranging + probs.volatile;

    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThan(1.001);
    expect(probs.volatile).toBeGreaterThan(probs.trending);
  });

  it("applies Bayesian risk updates to reduce suggested risk after losses", async () => {
    const { ctx, waitForInit } = createContext("owokx-bayes-1");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const account = createAccount();
    const initial = (harness as any).getDynamicRiskProfile(account);
    for (let i = 0; i < 12; i += 1) {
      (harness as any).updateBayesianRiskFromOutcome(-3.5);
    }
    const afterLosses = (harness as any).getDynamicRiskProfile(account);

    expect(afterLosses.bayesianWinProbability).toBeLessThan(initial.bayesianWinProbability);
    expect(afterLosses.multiplier).toBeLessThan(initial.multiplier);
  });

  it("triggers drift detection retraining and clears pending flag", async () => {
    const { ctx, waitForInit } = createContext("owokx-drift-1");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const state = (harness as any).state;
    state.predictiveModel.weights.sentiment = 2.6;
    state.driftDetection.shortErrorEma = 0.62;
    state.driftDetection.longErrorEma = 0.24;
    state.driftDetection.ratio = 2.58;
    state.driftDetection.samples = 60;
    state.driftDetection.consecutiveBreaches = 3;
    state.driftDetection.retrainPending = true;

    const beforeWeight = state.predictiveModel.weights.sentiment;
    const retrained = (harness as any).performAutoRetrainingIfNeeded(Date.now());

    expect(retrained).toBe(true);
    expect(state.driftDetection.retrainPending).toBe(false);
    expect(state.driftDetection.retrainCount).toBeGreaterThan(0);
    expect(state.predictiveModel.weights.sentiment).toBeLessThan(beforeWeight);
  });

  it("exposes cache/coalescing and d1 latency p95 in metrics endpoint payload", async () => {
    const { ctx, waitForInit } = createContext("owokx-metrics-1");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const h = harness as any;
    h.cacheReadHits = 9;
    h.cacheReadMisses = 3;
    h.cacheCoalescingHitCount = 5;
    h.d1QueryLatencySamplesMs.splice(0, h.d1QueryLatencySamplesMs.length, 11, 15, 22, 40, 70, 90);

    const response: Response = h.handleMetrics();
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        performance: {
          cache: { hit_rate: number; hits: number; misses: number };
          coalescing: { hit_count: number };
          d1: { query_latency_p95_ms: number };
        };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.performance.cache.hit_rate).toBeCloseTo(0.75, 4);
    expect(payload.data.performance.cache.hits).toBe(9);
    expect(payload.data.performance.cache.misses).toBe(3);
    expect(payload.data.performance.coalescing.hit_count).toBe(5);
    expect(payload.data.performance.d1.query_latency_p95_ms).toBe(90);
  });
});
