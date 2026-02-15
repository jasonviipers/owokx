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

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.alarm = null;
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

function createContext(
  id: string,
  initialState?: unknown
): {
  ctx: DurableObjectState;
  waitForInit: () => Promise<void>;
} {
  const storage = new MockStorage();
  if (initialState !== undefined) {
    storage.put("state", initialState);
  }
  let initPromise = Promise.resolve();
  const ctx = {
    id: createId(id),
    storage,
    waitUntil: (_promise: Promise<unknown>) => {
      // no-op in tests
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
    ALPACA_API_KEY: "alpaca-key",
    ALPACA_API_SECRET: "alpaca-secret",
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

async function doFetch(target: OwokxHarness, url: string, init?: RequestInit): Promise<Response> {
  return target.fetch(new Request(url, init));
}

const AUTH_HEADERS = { Authorization: "Bearer token" };

describe("OwokxHarness config broker switching", () => {
  it("saves broker switch and returns both config and data payloads", async () => {
    const { ctx, waitForInit } = createContext("owokx-switch-1");
    const harness = new OwokxHarness(
      ctx,
      createEnv({
        OKX_API_KEY: "okx-key",
        OKX_SECRET: "okx-secret",
        OKX_PASSPHRASE: "okx-passphrase",
      })
    );
    await waitForInit();

    const response = await doFetch(harness, "http://harness/config", {
      method: "POST",
      headers: {
        ...AUTH_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ broker: "okx" }),
    });
    const payload = (await response.json()) as {
      ok: boolean;
      config?: { broker?: string };
      data?: { broker?: string };
      message?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.config?.broker).toBe("okx");
    expect(payload.data?.broker).toBe("okx");
    expect(payload.message).toContain("Active broker");
  });

  it("rejects broker switch when target broker credentials are missing", async () => {
    const { ctx, waitForInit } = createContext("owokx-switch-2");
    const harness = new OwokxHarness(ctx, createEnv());
    await waitForInit();

    const response = await doFetch(harness, "http://harness/config", {
      method: "POST",
      headers: {
        ...AUTH_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ broker: "okx" }),
    });
    const payload = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("not configured");
  });

  it("handles concurrent save requests without corrupting broker config", async () => {
    const { ctx, waitForInit } = createContext("owokx-switch-3");
    const harness = new OwokxHarness(
      ctx,
      createEnv({
        OKX_API_KEY: "okx-key",
        OKX_SECRET: "okx-secret",
        OKX_PASSPHRASE: "okx-passphrase",
      })
    );
    await waitForInit();

    const reqA = doFetch(harness, "http://harness/config", {
      method: "POST",
      headers: {
        ...AUTH_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ broker: "okx" }),
    });
    const reqB = doFetch(harness, "http://harness/config", {
      method: "POST",
      headers: {
        ...AUTH_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ broker: "alpaca" }),
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    const current = await doFetch(harness, "http://harness/config", { headers: AUTH_HEADERS });
    const payload = (await current.json()) as { ok: boolean; data?: { broker?: string } };
    expect(payload.ok).toBe(true);
    expect(["alpaca", "okx"]).toContain(payload.data?.broker);
  });
});

