import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";

const mocks = vi.hoisted(() => ({
  createD1ClientMock: vi.fn(),
  seedDefaultAlertRulesMock: vi.fn(),
  listAlertRulesMock: vi.fn(),
  upsertAlertRuleMock: vi.fn(),
  getAlertRuleByIdMock: vi.fn(),
  deleteAlertRuleMock: vi.fn(),
  listAlertEventsMock: vi.fn(),
  acknowledgeAlertEventMock: vi.fn(),
  acknowledgeAlertEventsByRuleMock: vi.fn(),
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

vi.mock("../storage/d1/queries/alerts", () => ({
  seedDefaultAlertRules: mocks.seedDefaultAlertRulesMock,
  listAlertRules: mocks.listAlertRulesMock,
  upsertAlertRule: mocks.upsertAlertRuleMock,
  getAlertRuleById: mocks.getAlertRuleByIdMock,
  deleteAlertRule: mocks.deleteAlertRuleMock,
  listAlertEvents: mocks.listAlertEventsMock,
  acknowledgeAlertEvent: mocks.acknowledgeAlertEventMock,
  acknowledgeAlertEventsByRule: mocks.acknowledgeAlertEventsByRuleMock,
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

describe("alert routes", () => {
  beforeEach(() => {
    const fakeDb = { tag: "db" };
    mocks.createD1ClientMock.mockReset();
    mocks.createD1ClientMock.mockReturnValue(fakeDb);

    mocks.seedDefaultAlertRulesMock.mockReset();
    mocks.seedDefaultAlertRulesMock.mockResolvedValue(undefined);
    mocks.listAlertRulesMock.mockReset();
    mocks.upsertAlertRuleMock.mockReset();
    mocks.getAlertRuleByIdMock.mockReset();
    mocks.deleteAlertRuleMock.mockReset();
    mocks.listAlertEventsMock.mockReset();
    mocks.acknowledgeAlertEventMock.mockReset();
    mocks.acknowledgeAlertEventsByRuleMock.mockReset();
  });

  it("lists managed alert rules", async () => {
    mocks.listAlertRulesMock.mockResolvedValue([
      {
        id: "portfolio_drawdown",
        title: "Portfolio Drawdown",
      },
    ]);

    const response = await worker.fetch(
      authorizedRequest("/agent/alerts/rules", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as { ok: boolean; data?: { rules?: Array<{ id: string }> } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.rules?.[0]?.id).toBe("portfolio_drawdown");
    expect(mocks.listAlertRulesMock).toHaveBeenCalledTimes(1);
  });

  it("creates alert rules with trade authorization", async () => {
    mocks.upsertAlertRuleMock.mockResolvedValue({
      id: "custom_rule",
      title: "Custom Rule",
      description: "d",
      enabled: true,
      default_severity: "warning",
      config: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const unauthorized = await worker.fetch(
      authorizedRequest("/agent/alerts/rules", "read-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Custom Rule" }),
      }),
      createEnv(),
      {} as ExecutionContext
    );
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(
      authorizedRequest("/agent/alerts/rules", "trade-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Custom Rule" }),
      }),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as { ok: boolean; data?: { rule?: { id: string } } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.rule?.id).toBe("custom_rule");
  });

  it("lists alert history and acknowledges individual events", async () => {
    mocks.listAlertEventsMock.mockResolvedValue([
      {
        id: "evt-1",
        rule_id: "portfolio_drawdown",
      },
    ]);
    mocks.acknowledgeAlertEventMock.mockResolvedValue({
      id: "evt-1",
      rule_id: "portfolio_drawdown",
      severity: "warning",
      title: "Portfolio Drawdown",
      message: "warning",
      fingerprint: "f",
      details: {},
      occurred_at: "2026-02-01T00:00:00Z",
      acknowledged_at: "2026-02-01T00:10:00Z",
      acknowledged_by: "dashboard",
      created_at: "2026-02-01T00:00:00Z",
    });

    const historyResponse = await worker.fetch(
      authorizedRequest("/agent/alerts/history?acknowledged=false", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const historyPayload = (await historyResponse.json()) as {
      ok: boolean;
      data?: { events?: Array<{ id: string }> };
    };

    expect(historyResponse.status).toBe(200);
    expect(historyPayload.ok).toBe(true);
    expect(historyPayload.data?.events?.[0]?.id).toBe("evt-1");

    const ackResponse = await worker.fetch(
      authorizedRequest("/agent/alerts/history/evt-1/ack", "trade-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged_by: "dashboard" }),
      }),
      createEnv(),
      {} as ExecutionContext
    );
    const ackPayload = (await ackResponse.json()) as { ok: boolean; data?: { event?: { id: string } } };

    expect(ackResponse.status).toBe(200);
    expect(ackPayload.ok).toBe(true);
    expect(ackPayload.data?.event?.id).toBe("evt-1");
  });

  it("returns empty arrays when alert schema is missing", async () => {
    mocks.listAlertRulesMock.mockRejectedValue(new Error("D1_ERROR: no such table: alert_rules"));

    const response = await worker.fetch(
      authorizedRequest("/agent/alerts/rules", "read-token"),
      createEnv(),
      {} as ExecutionContext
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { rules?: unknown[] };
      warning?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data?.rules).toEqual([]);
    expect(payload.warning).toContain("migrations/0010_alerts.sql");
  });
});
