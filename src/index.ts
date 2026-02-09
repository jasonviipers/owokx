import { getHarnessStub } from "./durable-objects/owokx-harness";
import type { Env } from "./env.d";
import { handleCronEvent } from "./jobs/cron";
import { isRequestAuthorized } from "./lib/auth";
import { OwokxMcpAgent } from "./mcp/agent";

export { SessionDO } from "./durable-objects/session";
export { OwokxMcpAgent, OwokxMcpAgent as owokxMcpAgent };
export { OwokxHarness, OwokxHarness as owokxHarness } from "./durable-objects/owokx-harness";
export { DataScoutSimple as DataScout } from "./durable-objects/data-scout-simple";
export { AnalystSimple as Analyst } from "./durable-objects/analyst-simple";
export { TraderSimple as Trader } from "./durable-objects/trader-simple";
export { SwarmRegistry } from "./durable-objects/swarm-registry";
export { RiskManager } from "./durable-objects/risk-manager";

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <token>" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
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
      return stub.fetch(
        new Request(agentUrl.toString(), {
          method: request.method,
          headers: request.headers,
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
      const registryId = env.SWARM_REGISTRY.idFromName("default");
      const registry = env.SWARM_REGISTRY.get(registryId);
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

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronId = event.cron;
    console.log(`Cron triggered: ${cronId} at ${new Date().toISOString()}`);
    ctx.waitUntil(handleCronEvent(cronId, env));
  },
};
