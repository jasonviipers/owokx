import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { DataScoutSimple } from "./data-scout-simple";

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

  async getAlarm(): Promise<number | null> {
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
    waitUntil: (_promise: Promise<unknown>) => {
      // no-op
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
    ...overrides,
  } as Env;
}

async function doFetch(target: DataScoutSimple, url: string, init?: RequestInit): Promise<Response> {
  return target.fetch(new Request(url, init));
}

function toUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

const SAMPLE_REDDIT_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>$AAPL buy rocket squeeze</title>
    <content type="html">&lt;p&gt;Long thesis on $AAPL buy rocket squeeze&lt;/p&gt;</content>
  </entry>
</feed>`;

const SAMPLE_ALPHA_VANTAGE_NEWS = {
  feed: [
    {
      ticker_sentiment: [
        {
          ticker: "MSFT",
          ticker_sentiment_score: "0.62",
          relevance_score: "0.81",
        },
        {
          ticker: "NVDA",
          ticker_sentiment_score: "0.48",
          relevance_score: "0.63",
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DataScoutSimple Reddit RSS fallback", () => {
  it("uses RSS backup when Reddit API credentials are missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = toUrl(input);
      if (url.includes("/hot/.rss")) {
        return new Response(SAMPLE_REDDIT_RSS, {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, waitForInit } = createContext("data-scout-rss-no-creds");
    const scout = new DataScoutSimple(ctx, createEnv());
    await waitForInit();

    const gatherResponse = await doFetch(scout, "http://scout/gather");
    expect(gatherResponse.ok).toBe(true);

    const signalsResponse = await doFetch(scout, "http://scout/signals");
    const payload = (await signalsResponse.json()) as {
      signals: Array<{ symbol: string; sources: string[] }>;
    };

    expect(payload.signals.some((signal) => signal.symbol === "AAPL")).toBe(true);

    const requestedUrls = fetchMock.mock.calls.map(([input]) => toUrl(input as RequestInfo | URL));
    expect(requestedUrls.some((url) => url.includes("/api/v1/access_token"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/hot/.rss"))).toBe(true);
  });

  it("still uses RSS when Reddit credentials exist", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = toUrl(input);
      if (url.includes("/hot/.rss")) {
        return new Response(SAMPLE_REDDIT_RSS, {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, waitForInit } = createContext("data-scout-rss-auth-fail");
    const scout = new DataScoutSimple(
      ctx,
      createEnv({
        REDDIT_CLIENT_ID: "reddit-client",
        REDDIT_CLIENT_SECRET: "reddit-secret",
      })
    );
    await waitForInit();

    const gatherResponse = await doFetch(scout, "http://scout/gather");
    expect(gatherResponse.ok).toBe(true);

    const signalsResponse = await doFetch(scout, "http://scout/signals");
    const payload = (await signalsResponse.json()) as {
      signals: Array<{ symbol: string }>;
    };
    expect(payload.signals.some((signal) => signal.symbol === "AAPL")).toBe(true);

    const requestedUrls = fetchMock.mock.calls.map(([input]) => toUrl(input as RequestInfo | URL));
    expect(requestedUrls.some((url) => url.includes("/api/v1/access_token"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/hot/.rss"))).toBe(true);
  });

  it("ingests ticker sentiment from Alpha Vantage when API key is configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = toUrl(input);
      if (url.includes("alphavantage.co/query")) {
        return new Response(JSON.stringify(SAMPLE_ALPHA_VANTAGE_NEWS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/hot/.rss")) {
        return new Response("<feed></feed>", {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, waitForInit } = createContext("data-scout-alpha-vantage");
    const scout = new DataScoutSimple(
      ctx,
      createEnv({
        ALPHA_VANTAGE_API_KEY: "demo-key",
      })
    );
    await waitForInit();

    const gatherResponse = await doFetch(scout, "http://scout/gather");
    expect(gatherResponse.ok).toBe(true);

    const signalsResponse = await doFetch(scout, "http://scout/signals");
    const payload = (await signalsResponse.json()) as {
      signals: Array<{ symbol: string; sources: string[]; sentiment: number }>;
    };

    const msftSignal = payload.signals.find((signal) => signal.symbol === "MSFT");
    expect(msftSignal).toBeDefined();
    expect(msftSignal?.sources).toContain("alphavantage");
    expect((msftSignal?.sentiment ?? 0) > 0).toBe(true);

    const requestedUrls = fetchMock.mock.calls.map(([input]) => toUrl(input as RequestInfo | URL));
    expect(requestedUrls.some((url) => url.includes("alphavantage.co/query"))).toBe(true);
    expect(
      requestedUrls.some((url) => url.includes("function=NEWS_SENTIMENT") && url.includes("apikey=demo-key"))
    ).toBe(true);
  });
});
