import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";

const harnessFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

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
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        return harnessFetch(request);
      },
    }) as unknown as DurableObjectStub,
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

function authorizedRequest(path: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: {
      Authorization: "Bearer read-token",
    },
  });
}

describe("worker routing", () => {
  beforeEach(() => {
    harnessFetch.mockClear();
  });

  it("returns API metadata on root path", async () => {
    const response = await worker.fetch(new Request("https://example.com/"), createEnv(), {} as ExecutionContext);
    const payload = (await response.json()) as { name: string; endpoints: Record<string, string> };

    expect(response.ok).toBe(true);
    expect(payload.name).toBe("owokx");
    expect(payload.endpoints.agent).toContain("/agent/*");
  });

  it("requires auth for metrics endpoint", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/metrics"),
      createEnv(),
      {} as ExecutionContext
    );
    expect(response.status).toBe(401);
  });

  it("proxies /agent requests to the harness with origin context", async () => {
    await worker.fetch(authorizedRequest("/agent/config?scope=runtime"), createEnv(), {} as ExecutionContext);

    expect(harnessFetch).toHaveBeenCalledTimes(1);
    const proxied = harnessFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(proxied.url).pathname).toBe("/config");
    expect(new URL(proxied.url).searchParams.get("scope")).toBe("runtime");
    expect(proxied.headers.get("x-owokx-public-origin")).toBe("https://example.com");
  });

  it("enforces auth for data-scout routes and proxies when authorized", async () => {
    const dataScoutNamespace = createNamespace(
      (request) => new Response(JSON.stringify({ path: new URL(request.url).pathname }), { status: 200 })
    );

    const unauthorized = await worker.fetch(
      new Request("https://example.com/data-scout/health"),
      createEnv({ DATA_SCOUT: dataScoutNamespace }),
      {} as ExecutionContext
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await worker.fetch(
      authorizedRequest("/data-scout/health"),
      createEnv({ DATA_SCOUT: dataScoutNamespace }),
      {} as ExecutionContext
    );
    expect(authorized.status).toBe(200);
    const payload = (await authorized.json()) as { path: string };
    expect(payload.path).toBe("/health");
  });

  it("loads OKX rate limiter exports", async () => {
    const module = await import("../providers/okx/rate-limiter");
    expect(typeof module.RateLimiter).toBe("function");
    expect(typeof module.RetryWithBackoff).toBe("function");
  });
});
