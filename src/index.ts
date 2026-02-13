import { getHarnessStub } from "./durable-objects/owokx-harness";
import type { Env } from "./env.d";
import { handleCronEvent } from "./jobs/cron";
import { isRequestAuthorized } from "./lib/auth";
import { OwokxMcpAgent } from "./mcp/agent";

export { SessionDO } from "./durable-objects/session";
export { OwokxMcpAgent, OwokxMcpAgent as owokxMcpAgent };
export { AnalystSimple as Analyst } from "./durable-objects/analyst-simple";
export { DataScoutSimple as DataScout } from "./durable-objects/data-scout-simple";
export { LearningAgent } from "./durable-objects/learning-agent";
export { OwokxHarness, OwokxHarness as owokxHarness } from "./durable-objects/owokx-harness";
export { RiskManager } from "./durable-objects/risk-manager";
export { SwarmRegistry } from "./durable-objects/swarm-registry";
export { TraderSimple as Trader } from "./durable-objects/trader-simple";

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <token>" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function getRegistryStub(env: Env): DurableObjectStub {
  const registryId = env.SWARM_REGISTRY.idFromName("default");
  return env.SWARM_REGISTRY.get(registryId);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          environment: env.ENVIRONMENT,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/metrics") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const stub = getHarnessStub(env);
      return stub.fetch(
        new Request("http://harness/metrics", {
          method: "GET",
          headers: request.headers,
        })
      );
    }

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "owokx",
          version: "0.3.0",
          description: "Autonomous LLM-powered trading agent on Cloudflare Workers",
          endpoints: {
            health: "/health",
            mcp: "/mcp (auth required)",
            agent: "/agent/* (auth required)",
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname.startsWith("/mcp")) {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      return OwokxMcpAgent.mount("/mcp", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
    }

    if (url.pathname.startsWith("/agent")) {
      const stub = getHarnessStub(env);
      const agentPath = url.pathname.replace("/agent", "") || "/status";
      const agentUrl = new URL(agentPath, "http://harness");
      agentUrl.search = url.search;
      const headers = new Headers(request.headers);
      headers.set("x-owokx-public-origin", url.origin);
      return stub.fetch(
        new Request(agentUrl.toString(), {
          method: request.method,
          headers,
          body: request.body,
        })
      );
    }

    // New specialized Durable Object routes
    if (url.pathname.startsWith("/data-scout")) {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const dataScoutId = env.DATA_SCOUT.idFromName("default");
      const dataScout = env.DATA_SCOUT.get(dataScoutId);
      const dataScoutPath = url.pathname.replace("/data-scout", "") || "/health";
      const dataScoutUrl = new URL(dataScoutPath, "http://data-scout");
      dataScoutUrl.search = url.search;
      return dataScout.fetch(
        new Request(dataScoutUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname.startsWith("/analyst")) {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const analystId = env.ANALYST.idFromName("default");
      const analyst = env.ANALYST.get(analystId);
      const analystPath = url.pathname.replace("/analyst", "") || "/health";
      const analystUrl = new URL(analystPath, "http://analyst");
      analystUrl.search = url.search;
      return analyst.fetch(
        new Request(analystUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname.startsWith("/trader")) {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      const traderId = env.TRADER.idFromName("default");
      const trader = env.TRADER.get(traderId);
      const traderPath = url.pathname.replace("/trader", "") || "/health";
      const traderUrl = new URL(traderPath, "http://trader");
      traderUrl.search = url.search;
      return trader.fetch(
        new Request(traderUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname.startsWith("/registry")) {
      // Registry might be public or protected. Let's protect it.
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      const registryPath = url.pathname.replace("/registry", "") || "/health";
      const registryUrl = new URL(registryPath, "http://registry");
      registryUrl.search = url.search;
      return registry.fetch(
        new Request(registryUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname === "/swarm/agents") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch("http://registry/agents");
    }

    if (url.pathname === "/swarm/health") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      const [healthRes, queueRes] = await Promise.all([
        registry.fetch("http://registry/health"),
        registry.fetch("http://registry/queue/state"),
      ]);

      if (!healthRes.ok || !queueRes.ok) {
        return new Response(
          JSON.stringify({
            healthy: false,
            error: "Unable to load swarm health",
            registryStatus: healthRes.status,
            queueStatus: queueRes.status,
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const health = (await healthRes.json()) as {
        healthy?: boolean;
      };
      const queue = (await queueRes.json()) as {
        deadLettered?: number;
        staleAgents?: number;
      };
      const deadLettered = Number.isFinite(queue.deadLettered) ? Number(queue.deadLettered) : 0;
      const staleAgents = Number.isFinite(queue.staleAgents) ? Number(queue.staleAgents) : 0;

      return new Response(
        JSON.stringify({
          healthy: Boolean(health.healthy),
          degraded: deadLettered > 0 || staleAgents > 0,
          deadLettered,
          staleAgents,
          registry: health,
          queue,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/swarm/metrics") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      const [agentsRes, queueRes] = await Promise.all([
        registry.fetch("http://registry/agents"),
        registry.fetch("http://registry/queue/state"),
      ]);

      if (!agentsRes.ok || !queueRes.ok) {
        return new Response(
          JSON.stringify({
            error: "Unable to load swarm metrics",
            registryAgentsStatus: agentsRes.status,
            queueStatus: queueRes.status,
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const now = Date.now();
      const staleThresholdMs = 300_000;
      const agents = (await agentsRes.json()) as Record<
        string,
        {
          id?: string;
          type?: string;
          status?: string;
          lastHeartbeat?: number;
        }
      >;
      const queue = (await queueRes.json()) as {
        queued?: number;
        deadLettered?: number;
        stats?: Record<string, number>;
        routingState?: Record<string, number>;
        staleAgents?: number;
      };

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let staleComputed = 0;

      for (const agent of Object.values(agents)) {
        const type = agent.type ?? "unknown";
        const status = agent.status ?? "unknown";
        byType[type] = (byType[type] ?? 0) + 1;
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        if (typeof agent.lastHeartbeat === "number" && now - agent.lastHeartbeat > staleThresholdMs) {
          staleComputed += 1;
        }
      }

      return new Response(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          agents: {
            total: Object.keys(agents).length,
            byType,
            byStatus,
            stale: Number.isFinite(queue.staleAgents) ? Number(queue.staleAgents) : staleComputed,
          },
          queue: {
            queued: Number.isFinite(queue.queued) ? Number(queue.queued) : 0,
            deadLettered: Number.isFinite(queue.deadLettered) ? Number(queue.deadLettered) : 0,
            stats: queue.stats ?? {},
            routingState: queue.routingState ?? {},
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.pathname === "/swarm/queue") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch("http://registry/queue/state");
    }

    if (url.pathname === "/swarm/subscriptions") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      const proxyUrl = new URL("/subscriptions", "http://registry");
      proxyUrl.search = url.search;
      return registry.fetch(proxyUrl.toString());
    }

    if (url.pathname === "/swarm/routing") {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      const proxyUrl = new URL("/routing/preview", "http://registry");
      proxyUrl.search = url.search;
      return registry.fetch(proxyUrl.toString());
    }

    if (url.pathname === "/swarm/dispatch" && request.method === "POST") {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch(
        new Request("http://registry/queue/dispatch", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname === "/swarm/recovery/requeue-dlq" && request.method === "POST") {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch(
        new Request("http://registry/recovery/requeue-dead-letter", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname === "/swarm/recovery/prune-stale" && request.method === "POST") {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch(
        new Request("http://registry/recovery/prune-stale-agents", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname === "/swarm/publish" && request.method === "POST") {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }
      const registry = getRegistryStub(env);
      return registry.fetch(
        new Request("http://registry/queue/publish", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname.startsWith("/risk-manager")) {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      const riskId = env.RISK_MANAGER.idFromName("default");
      const riskManager = env.RISK_MANAGER.get(riskId);
      const riskPath = url.pathname.replace("/risk-manager", "") || "/health";
      const riskUrl = new URL(riskPath, "http://risk-manager");
      riskUrl.search = url.search;
      return riskManager.fetch(
        new Request(riskUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    if (url.pathname.startsWith("/learning")) {
      if (!isRequestAuthorized(request, env, "read")) {
        return unauthorizedResponse();
      }
      if (!env.LEARNING_AGENT) {
        return new Response(JSON.stringify({ error: "Learning agent not configured" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const learningId = env.LEARNING_AGENT.idFromName("default");
      const learningAgent = env.LEARNING_AGENT.get(learningId);
      const learningPath = url.pathname.replace("/learning", "") || "/health";
      const learningUrl = new URL(learningPath, "http://learning");
      learningUrl.search = url.search;
      return learningAgent.fetch(
        new Request(learningUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronId = event.cron;
    console.log(`Cron triggered: ${cronId} at ${new Date().toISOString()}`);
    ctx.waitUntil(handleCronEvent(cronId, env));
  },
};
