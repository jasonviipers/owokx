import { describe, expect, it } from "vitest";
import { SwarmRegistry } from "../durable-objects/swarm-registry";
import type { Env } from "../env";

class MockStorage {
  private data = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  getAlarm(): number | null {
    return this.alarmAt;
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

function createRegistryEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides,
  } as Env;
}

async function doFetch(registry: SwarmRegistry, url: string, init?: RequestInit): Promise<Response> {
  return registry.fetch(new Request(url, init));
}

describe("SwarmRegistry", () => {
  it("publishes to topic subscribers and supports queue polling", async () => {
    const { ctx, waitForInit } = createContext("registry-test-1");
    const registry = new SwarmRegistry(ctx, createRegistryEnv());
    await waitForInit();

    const subscribeRes = await doFetch(registry, "http://registry/subscriptions/subscribe", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-1", topic: "signals_updated" }),
    });
    expect(subscribeRes.ok).toBe(true);

    const publishRes = await doFetch(registry, "http://registry/queue/publish", {
      method: "POST",
      body: JSON.stringify({
        source: "scout-1",
        topic: "signals_updated",
        payload: { count: 2 },
      }),
    });
    const publishData = (await publishRes.json()) as { enqueued: number };
    expect(publishData.enqueued).toBe(1);

    const pollRes = await doFetch(registry, "http://registry/queue/poll?agentId=agent-1&limit=10", { method: "GET" });
    const pollData = (await pollRes.json()) as { messages: Array<{ topic: string; source: string }> };
    expect(pollData.messages).toHaveLength(1);
    expect(pollData.messages[0]?.topic).toBe("signals_updated");
    expect(pollData.messages[0]?.source).toBe("scout-1");

    const queueStateRes = await doFetch(registry, "http://registry/queue/state", { method: "GET" });
    const queueState = (await queueStateRes.json()) as {
      queued: number;
      stats: { delivered: number };
      telemetry: { scope: string };
    };
    expect(queueState.queued).toBe(0);
    expect(queueState.stats.delivered).toBe(1);
    expect(queueState.telemetry.scope).toBe("swarm_registry");
  });

  it("dispatches queued messages to registered active agents", async () => {
    const deliveredMessages: Array<{ topic: string; target: string }> = [];
    const analystNamespace = createNamespace(async (request: Request) => {
      if (new URL(request.url).pathname === "/message") {
        const body = (await request.json()) as { topic: string; target: string };
        deliveredMessages.push({ topic: body.topic, target: body.target });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { ctx, waitForInit } = createContext("registry-test-2");
    const registry = new SwarmRegistry(
      ctx,
      createRegistryEnv({
        ANALYST: analystNamespace,
      })
    );
    await waitForInit();

    await doFetch(registry, "http://registry/register", {
      method: "POST",
      body: JSON.stringify({
        id: "analyst-1",
        type: "analyst",
        status: "active",
        lastHeartbeat: Date.now(),
        capabilities: ["analyze_signals"],
      }),
    });

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "msg-1",
          source: "scout-1",
          target: "analyst-1",
          type: "COMMAND",
          topic: "analyze_signals",
          payload: { signals: [] },
          timestamp: Date.now(),
        },
      }),
    });

    const dispatchRes = await doFetch(registry, "http://registry/queue/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: 10 }),
    });
    const dispatchData = (await dispatchRes.json()) as { delivered: number; pending: number };
    expect(dispatchData.delivered).toBe(1);
    expect(dispatchData.pending).toBe(0);
    expect(deliveredMessages).toHaveLength(1);
    expect(deliveredMessages[0]?.topic).toBe("analyze_signals");
    expect(deliveredMessages[0]?.target).toBe("analyst-1");
  });

  it("moves expired messages to dead letter queue during poll", async () => {
    const { ctx, waitForInit } = createContext("registry-test-3");
    const registry = new SwarmRegistry(ctx, createRegistryEnv());
    await waitForInit();

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "msg-expired",
          source: "system",
          target: "agent-expired",
          type: "EVENT",
          topic: "test_topic",
          payload: {},
          timestamp: Date.now() - 10_000,
          ttlMs: 1,
        },
      }),
    });

    const pollRes = await doFetch(registry, "http://registry/queue/poll?agentId=agent-expired&limit=10", {
      method: "GET",
    });
    const pollData = (await pollRes.json()) as { messages: unknown[] };
    expect(pollData.messages).toHaveLength(0);

    const queueStateRes = await doFetch(registry, "http://registry/queue/state", { method: "GET" });
    const queueState = (await queueStateRes.json()) as { deadLettered: number; queued: number };
    expect(queueState.deadLettered).toBe(1);
    expect(queueState.queued).toBe(0);
  });

  it("load balances type-routed targets across active agents", async () => {
    const { ctx, waitForInit } = createContext("registry-test-4");
    const registry = new SwarmRegistry(ctx, createRegistryEnv());
    await waitForInit();

    await doFetch(registry, "http://registry/register", {
      method: "POST",
      body: JSON.stringify({
        id: "analyst-1",
        type: "analyst",
        status: "active",
        lastHeartbeat: Date.now(),
        capabilities: [],
      }),
    });
    await doFetch(registry, "http://registry/register", {
      method: "POST",
      body: JSON.stringify({
        id: "analyst-2",
        type: "analyst",
        status: "active",
        lastHeartbeat: Date.now(),
        capabilities: [],
      }),
    });

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "lb-msg-1",
          source: "system",
          target: "type:analyst",
          type: "COMMAND",
          topic: "analyze_signals",
          payload: { signals: [] },
          timestamp: Date.now(),
        },
      }),
    });

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "lb-msg-2",
          source: "system",
          target: "type:analyst",
          type: "COMMAND",
          topic: "analyze_signals",
          payload: { signals: [] },
          timestamp: Date.now(),
        },
      }),
    });

    const poll1 = await doFetch(registry, "http://registry/queue/poll?agentId=analyst-1&limit=10", { method: "GET" });
    const poll2 = await doFetch(registry, "http://registry/queue/poll?agentId=analyst-2&limit=10", { method: "GET" });
    const data1 = (await poll1.json()) as { messages: Array<{ id: string }> };
    const data2 = (await poll2.json()) as { messages: Array<{ id: string }> };

    expect(data1.messages).toHaveLength(1);
    expect(data2.messages).toHaveLength(1);
    expect(data1.messages[0]?.id).toBe("lb-msg-1");
    expect(data2.messages[0]?.id).toBe("lb-msg-2");
  });

  it("can recover dead-letter messages by requeueing after agent registration", async () => {
    const { ctx, waitForInit } = createContext("registry-test-5");
    const registry = new SwarmRegistry(ctx, createRegistryEnv());
    await waitForInit();

    await doFetch(registry, "http://registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: "dlq-msg-1",
          source: "system",
          target: "analyst-recovery",
          type: "COMMAND",
          topic: "analyze_signals",
          payload: { signals: [] },
          timestamp: Date.now(),
        },
        maxAttempts: 1,
      }),
    });

    await doFetch(registry, "http://registry/queue/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: 10 }),
    });

    await doFetch(registry, "http://registry/register", {
      method: "POST",
      body: JSON.stringify({
        id: "analyst-recovery",
        type: "analyst",
        status: "active",
        lastHeartbeat: Date.now(),
        capabilities: [],
      }),
    });

    const requeueRes = await doFetch(registry, "http://registry/recovery/requeue-dead-letter", {
      method: "POST",
      body: JSON.stringify({ limit: 10 }),
    });
    const requeueData = (await requeueRes.json()) as { requeued: number; remaining: number };
    expect(requeueData.requeued).toBe(1);
    expect(requeueData.remaining).toBe(0);

    const poll = await doFetch(registry, "http://registry/queue/poll?agentId=analyst-recovery&limit=10", {
      method: "GET",
    });
    const pollData = (await poll.json()) as { messages: Array<{ id: string }> };
    expect(pollData.messages).toHaveLength(1);
    expect(pollData.messages[0]?.id).toBe("dlq-msg-1");
  });
});
