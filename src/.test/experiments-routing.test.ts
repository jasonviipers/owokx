import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";

const mocks = vi.hoisted(() => ({
  createD1ClientMock: vi.fn(),
  listExperimentRunsMock: vi.fn(),
  getExperimentRunByIdMock: vi.fn(),
  listExperimentMetricsMock: vi.fn(),
  listExperimentVariantsMock: vi.fn(),
  setExperimentChampionVariantMock: vi.fn(),
  upsertExperimentVariantMock: vi.fn(),
  createR2ClientMock: vi.fn(),
  getExperimentArtifactMock: vi.fn(),
}));

vi.mock("../mcp/agent", () => ({
  OwokxMcpAgent: {
    mount: () => ({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  },
}));

vi.mock("../durable-objects/owokx-harness", () => ({
  getHarnessStub: () =>
    ({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    }) as unknown as DurableObjectStub,
}));

vi.mock("../storage/d1/client", () => ({
  createD1Client: mocks.createD1ClientMock,
}));

vi.mock("../storage/d1/queries/experiments", () => ({
  listExperimentRuns: mocks.listExperimentRunsMock,
  getExperimentRunById: mocks.getExperimentRunByIdMock,
  listExperimentMetrics: mocks.listExperimentMetricsMock,
  listExperimentVariants: mocks.listExperimentVariantsMock,
  setExperimentChampionVariant: mocks.setExperimentChampionVariantMock,
  upsertExperimentVariant: mocks.upsertExperimentVariantMock,
}));

vi.mock("../storage/r2/client", () => ({
  createR2Client: mocks.createR2ClientMock,
}));

import worker from "../index";

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

function createEnv(overrides: Partial<Env> = {}): Env {
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
    OWOKX_API_TOKEN: "legacy-token",
    OWOKX_API_TOKEN_READONLY: "read-token",
    OWOKX_API_TOKEN_TRADE: "trade-token",
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

function authorizedRequest(path: string, token: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

describe("experiment routes", () => {
  beforeEach(() => {
    const fakeDb = { tag: "db" };
    mocks.createD1ClientMock.mockReset();
    mocks.createD1ClientMock.mockReturnValue(fakeDb);

    mocks.listExperimentRunsMock.mockReset();
    mocks.getExperimentRunByIdMock.mockReset();
    mocks.listExperimentMetricsMock.mockReset();
    mocks.listExperimentVariantsMock.mockReset();
    mocks.setExperimentChampionVariantMock.mockReset();
    mocks.upsertExperimentVariantMock.mockReset();

    mocks.getExperimentArtifactMock.mockReset();
    mocks.createR2ClientMock.mockReset();
    mocks.createR2ClientMock.mockReturnValue({
      getExperimentArtifact: mocks.getExperimentArtifactMock,
    });
  });

  it("lists experiment runs via /agent/experiments/runs", async () => {
    mocks.listExperimentRunsMock.mockResolvedValue([
      {
        id: "run-1",
        strategy_name: "live_hourly_snapshot",
      },
    ]);

    const response = await worker.fetch(
      authorizedRequest("/agent/experiments/runs?strategy_name=live_hourly_snapshot", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as { ok: boolean; data?: { runs?: Array<{ id: string }> } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.runs?.[0]?.id).toBe("run-1");
    expect(mocks.listExperimentRunsMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty runs when experiment schema is not initialized", async () => {
    mocks.listExperimentRunsMock.mockRejectedValue(new Error("D1_ERROR: no such table: experiment_runs"));

    const response = await worker.fetch(
      authorizedRequest("/agent/experiments/runs", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { runs?: Array<{ id: string }> };
      warning?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.runs).toEqual([]);
    expect(payload.warning).toContain("migrations/0008_experiments.sql");
  });

  it("returns empty variants when experiment schema is not initialized", async () => {
    mocks.listExperimentVariantsMock.mockRejectedValue(new Error("D1_ERROR: no such table: experiment_variants"));

    const response = await worker.fetch(
      authorizedRequest("/agent/experiments/variants", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { variants?: Array<{ id: string }> };
      warning?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.variants).toEqual([]);
    expect(payload.warning).toContain("migrations/0008_experiments.sql");
  });

  it("promotes a run via /agent/experiments/promote", async () => {
    mocks.getExperimentRunByIdMock.mockResolvedValue({
      id: "run-abc12345",
      strategy_name: "live_hourly_snapshot",
      config: { variant: "paper-a" },
    });
    mocks.upsertExperimentVariantMock.mockResolvedValue({
      id: "variant-1",
      strategy_name: "live_hourly_snapshot",
      variant_name: "paper-a",
      params: { variant: "paper-a" },
      status: "active",
      is_champion: false,
      created_at: "2026-02-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    mocks.setExperimentChampionVariantMock.mockResolvedValue(undefined);

    const response = await worker.fetch(
      authorizedRequest("/agent/experiments/promote", "trade-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: "run-abc12345" }),
      }),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { strategy_name?: string; promoted_variant?: { id: string; is_champion: boolean } };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.strategy_name).toBe("live_hourly_snapshot");
    expect(payload.data?.promoted_variant?.id).toBe("variant-1");
    expect(payload.data?.promoted_variant?.is_champion).toBe(true);
    expect(mocks.setExperimentChampionVariantMock).toHaveBeenCalledWith(
      expect.anything(),
      "live_hourly_snapshot",
      "variant-1"
    );
  });
});
