import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.d";

vi.mock("./mcp/agent", () => ({
  OwokxMcpAgent: {
    mount: () => ({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  },
}));

vi.mock("./durable-objects/owokx-harness", () => ({
  getHarnessStub: () =>
    ({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }) as unknown as DurableObjectStub,
}));

import worker from "./index";

function createId(id: string): DurableObjectId {
  return { toString: () => id } as unknown as DurableObjectId;
}

function createNamespace(
  fetchImpl?: (request: Request) => Promise<Response> | Response
): DurableObjectNamespace {
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

function createAuthorizedRequest(path: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: {
      Authorization: "Bearer read-token",
    },
  });
}

describe("swarm monitoring routes", () => {
  it("rejects unauthenticated swarm health requests", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/swarm/health"),
      createEnv(),
      {} as ExecutionContext
    );

    expect(response.status).toBe(401);
  });

  it("returns consolidated swarm health with degradation flags", async () => {
    const registryNamespace = createNamespace((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/health") {
        return new Response(
          JSON.stringify({
            healthy: true,
            active_agents: 3,
            total_agents: 4,
            queue_depth: 2,
            dead_letter_depth: 1,
          }),
          { status: 200 }
        );
      }
      if (path === "/queue/state") {
        return new Response(
          JSON.stringify({
            queued: 2,
            deadLettered: 1,
            stats: { enqueued: 20, delivered: 18, failed: 2, deadLettered: 1 },
            routingState: { analyst: 1 },
            staleAgents: 1,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const response = await worker.fetch(
      createAuthorizedRequest("/swarm/health"),
      createEnv({ SWARM_REGISTRY: registryNamespace }),
      {} as ExecutionContext
    );
    const payload = await response.json() as {
      healthy: boolean;
      degraded: boolean;
      deadLettered: number;
      staleAgents: number;
    };

    expect(response.ok).toBe(true);
    expect(payload.healthy).toBe(true);
    expect(payload.degraded).toBe(true);
    expect(payload.deadLettered).toBe(1);
    expect(payload.staleAgents).toBe(1);
  });

  it("returns aggregated swarm metrics by type and status", async () => {
    const registryNamespace = createNamespace((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/agents") {
        return new Response(
          JSON.stringify({
            "analyst-1": {
              id: "analyst-1",
              type: "analyst",
              status: "active",
              lastHeartbeat: Date.now(),
            },
            "trader-1": {
              id: "trader-1",
              type: "trader",
              status: "busy",
              lastHeartbeat: Date.now(),
            },
            "trader-2": {
              id: "trader-2",
              type: "trader",
              status: "active",
              lastHeartbeat: Date.now() - 600_000,
            },
          }),
          { status: 200 }
        );
      }
      if (path === "/queue/state") {
        return new Response(
          JSON.stringify({
            queued: 4,
            deadLettered: 1,
            stats: { enqueued: 30, delivered: 25, failed: 5, deadLettered: 1 },
            routingState: { analyst: 0, trader: 1 },
            staleAgents: 1,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const response = await worker.fetch(
      createAuthorizedRequest("/swarm/metrics"),
      createEnv({ SWARM_REGISTRY: registryNamespace }),
      {} as ExecutionContext
    );
    const payload = await response.json() as {
      agents: {
        total: number;
        byType: Record<string, number>;
        byStatus: Record<string, number>;
        stale: number;
      };
      queue: {
        queued: number;
        deadLettered: number;
        routingState: Record<string, number>;
      };
    };

    expect(response.ok).toBe(true);
    expect(payload.agents.total).toBe(3);
    expect(payload.agents.byType.analyst).toBe(1);
    expect(payload.agents.byType.trader).toBe(2);
    expect(payload.agents.byStatus.active).toBe(2);
    expect(payload.agents.byStatus.busy).toBe(1);
    expect(payload.agents.stale).toBe(1);
    expect(payload.queue.queued).toBe(4);
    expect(payload.queue.deadLettered).toBe(1);
    expect(payload.queue.routingState.trader).toBe(1);
  });
});
