import { getHarnessStub } from "./durable-objects/owokx-harness";
import type { Env } from "./env.d";
import { handleCronEvent } from "./jobs/cron";
import { isRequestAuthorized, isTokenAuthorized } from "./lib/auth";
import { createTelemetry, type TelemetryTags } from "./lib/telemetry";
import { OwokxMcpAgent } from "./mcp/agent";
import { createD1Client } from "./storage/d1/client";
import {
  getExperimentRunById,
  listExperimentMetrics,
  listExperimentRuns,
  listExperimentVariants,
  setExperimentChampionVariant,
  upsertExperimentVariant,
} from "./storage/d1/queries/experiments";
import { createR2Client } from "./storage/r2/client";
import { R2Paths } from "./storage/r2/paths";

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

function buildSessionCookie(request: Request, token: string): string {
  const url = new URL(request.url);
  const isSecure =
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    !url.hostname.includes("localhost");
  const parts = [`OWOKX_SESSION=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=43200"];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(): string {
  return "OWOKX_SESSION=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parsePositiveInt(input: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const EXPERIMENTS_SCHEMA_HINT =
  "Experiment schema not initialized. Apply D1 migrations (including migrations/0008_experiments.sql).";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isMissingExperimentsSchemaError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("no such table") &&
    (message.includes("experiment_runs") ||
      message.includes("experiment_variants") ||
      message.includes("experiment_metrics"))
  );
}

/**
 * Retrieves the Durable Object stub for the swarm registry named "default".
 *
 * @returns The Durable Object stub for `SWARM_REGISTRY` bound to the name `"default"`.
 */
function getRegistryStub(env: Env): DurableObjectStub {
  const registryId = env.SWARM_REGISTRY.idFromName("default");
  return env.SWARM_REGISTRY.get(registryId);
}

const workerTelemetry = createTelemetry("worker_index");

/**
 * Record telemetry for an HTTP route (requests, responses, errors, latency) and run the provided handler.
 *
 * Records request/response counts, error counts, and request latency using the given telemetry tags while invoking `handler`.
 *
 * @param tags - Telemetry tags applied to all recorded metrics for this route
 * @param handler - Async function that handles the route and returns a `Response`
 * @returns The `Response` produced by `handler`
 */
async function withRouteTelemetry(tags: TelemetryTags, handler: () => Promise<Response>): Promise<Response> {
  workerTelemetry.increment("http_requests_total", 1, tags);
  const stopTimer = workerTelemetry.startTimer("http_request_latency_ms", tags);
  try {
    const response = await handler();
    const status = response.status;
    workerTelemetry.increment("http_responses_total", 1, { ...tags, status });
    if (status >= 400) {
      workerTelemetry.increment("http_errors_total", 1, { ...tags, status });
    }
    return response;
  } catch (error) {
    workerTelemetry.increment("http_errors_total", 1, { ...tags, status: 500 });
    throw error;
  } finally {
    stopTimer();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/auth/session" && request.method === "POST") {
      let body: { token?: string };
      try {
        body = (await request.json()) as { token?: string };
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || !isTokenAuthorized(token, env, "read")) {
        return new Response(JSON.stringify({ ok: false, error: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": buildSessionCookie(request, token),
        },
      });
    }

    if (url.pathname === "/auth/session" && request.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": clearSessionCookie(),
        },
      });
    }

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
      return withRouteTelemetry({ route: "/metrics", method: request.method }, async () => {
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
      });
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

    if (url.pathname === "/agent/experiments/runs" && request.method === "GET") {
      return withRouteTelemetry({ route: "/agent/experiments/runs", method: request.method }, async () => {
        if (!isRequestAuthorized(request, env, "read")) {
          return unauthorizedResponse();
        }

        const db = createD1Client(env.DB);
        const strategyName = url.searchParams.get("strategy_name") ?? undefined;
        const dateFrom = url.searchParams.get("date_from") ?? undefined;
        const dateTo = url.searchParams.get("date_to") ?? undefined;
        const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 500);
        const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
        const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

        try {
          const runs = await listExperimentRuns(db, {
            strategy_name: strategyName,
            date_from: dateFrom,
            date_to: dateTo,
            limit,
            offset,
          });
          return jsonResponse({ ok: true, data: { runs } });
        } catch (error) {
          if (isMissingExperimentsSchemaError(error)) {
            return jsonResponse({
              ok: true,
              data: { runs: [] },
              warning: EXPERIMENTS_SCHEMA_HINT,
            });
          }
          return jsonResponse({ ok: false, error: getErrorMessage(error) }, 500);
        }
      });
    }

    if (url.pathname.startsWith("/agent/experiments/runs/") && request.method === "GET") {
      return withRouteTelemetry({ route: "/agent/experiments/runs/:id", method: request.method }, async () => {
        if (!isRequestAuthorized(request, env, "read")) {
          return unauthorizedResponse();
        }

        const runId = decodeURIComponent(url.pathname.slice("/agent/experiments/runs/".length));
        if (!runId) {
          return jsonResponse({ ok: false, error: "run_id is required" }, 400);
        }

        const db = createD1Client(env.DB);
        const r2 = createR2Client(env.ARTIFACTS);

        try {
          const run = await getExperimentRunById(db, runId);
          if (!run) {
            return jsonResponse({ ok: false, error: "Experiment run not found" }, 404);
          }

          const metricsKey = R2Paths.experimentRunMetrics(run.strategy_name, run.id);
          const [summaryArtifact, equityArtifact, metricsArtifact, metrics] = await Promise.all([
            run.summary_artifact_key ? r2.getExperimentArtifact(run.summary_artifact_key) : Promise.resolve(null),
            run.equity_artifact_key ? r2.getExperimentArtifact(run.equity_artifact_key) : Promise.resolve(null),
            r2.getExperimentArtifact(metricsKey).catch(() => null),
            listExperimentMetrics(db, { run_id: run.id, limit: 2000 }),
          ]);

          return jsonResponse({
            ok: true,
            data: {
              run,
              summary_artifact: summaryArtifact,
              equity_artifact: equityArtifact,
              metrics_artifact: metricsArtifact,
              metrics,
            },
          });
        } catch (error) {
          if (isMissingExperimentsSchemaError(error)) {
            return jsonResponse({ ok: false, error: EXPERIMENTS_SCHEMA_HINT }, 503);
          }
          return jsonResponse({ ok: false, error: getErrorMessage(error) }, 500);
        }
      });
    }

    if (url.pathname === "/agent/experiments/variants" && request.method === "GET") {
      return withRouteTelemetry({ route: "/agent/experiments/variants", method: request.method }, async () => {
        if (!isRequestAuthorized(request, env, "read")) {
          return unauthorizedResponse();
        }

        const db = createD1Client(env.DB);
        const strategyName = url.searchParams.get("strategy_name") ?? undefined;
        const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 500);
        const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
        const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

        try {
          const variants = await listExperimentVariants(db, {
            strategy_name: strategyName,
            limit,
            offset,
          });
          return jsonResponse({ ok: true, data: { variants } });
        } catch (error) {
          if (isMissingExperimentsSchemaError(error)) {
            return jsonResponse({
              ok: true,
              data: { variants: [] },
              warning: EXPERIMENTS_SCHEMA_HINT,
            });
          }
          return jsonResponse({ ok: false, error: getErrorMessage(error) }, 500);
        }
      });
    }

    if (url.pathname === "/agent/experiments/promote" && request.method === "POST") {
      if (!isRequestAuthorized(request, env, "trade")) {
        return unauthorizedResponse();
      }

      type PromoteBody = {
        run_id?: string;
        strategy_name?: string;
        variant_id?: string;
        variant_name?: string;
        params?: Record<string, unknown>;
      };

      let body: PromoteBody = {};
      try {
        body = (await request.json()) as PromoteBody;
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON payload" }, 400);
      }

      const db = createD1Client(env.DB);

      try {
        if (body.run_id) {
          const run = await getExperimentRunById(db, body.run_id);
          if (!run) {
            return jsonResponse({ ok: false, error: "Experiment run not found" }, 404);
          }

          const config = run.config ?? {};
          const derivedVariantName =
            body.variant_name ??
            (typeof config.variant === "string" && config.variant.trim().length > 0
              ? config.variant.trim()
              : `run-${run.id.slice(0, 8)}`);

          const promotedVariant = await upsertExperimentVariant(db, {
            strategy_name: run.strategy_name,
            variant_name: derivedVariantName,
            params: body.params ?? config,
            status: "active",
            is_champion: false,
          });

          await setExperimentChampionVariant(db, run.strategy_name, promotedVariant.id);
          return jsonResponse({
            ok: true,
            data: {
              strategy_name: run.strategy_name,
              promoted_variant: {
                ...promotedVariant,
                is_champion: true,
              },
            },
          });
        }

        if (body.strategy_name && body.variant_id) {
          await setExperimentChampionVariant(db, body.strategy_name, body.variant_id);
          return jsonResponse({
            ok: true,
            data: {
              strategy_name: body.strategy_name,
              variant_id: body.variant_id,
            },
          });
        }

        if (body.strategy_name && body.variant_name) {
          const promotedVariant = await upsertExperimentVariant(db, {
            strategy_name: body.strategy_name,
            variant_name: body.variant_name,
            params: body.params ?? {},
            status: "active",
            is_champion: false,
          });
          await setExperimentChampionVariant(db, body.strategy_name, promotedVariant.id);
          return jsonResponse({
            ok: true,
            data: {
              strategy_name: body.strategy_name,
              promoted_variant: {
                ...promotedVariant,
                is_champion: true,
              },
            },
          });
        }

        return jsonResponse(
          {
            ok: false,
            error: "Provide either run_id or strategy_name + variant_id (or strategy_name + variant_name)",
          },
          400
        );
      } catch (error) {
        if (isMissingExperimentsSchemaError(error)) {
          return jsonResponse({ ok: false, error: EXPERIMENTS_SCHEMA_HINT }, 503);
        }
        return jsonResponse({ ok: false, error: getErrorMessage(error) }, 500);
      }
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
      return withRouteTelemetry({ route: "/swarm/health", method: request.method }, async () => {
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
              telemetry: workerTelemetry.snapshot(),
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
            telemetry: workerTelemetry.snapshot(),
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      });
    }

    if (url.pathname === "/swarm/metrics") {
      return withRouteTelemetry({ route: "/swarm/metrics", method: request.method }, async () => {
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
              telemetry: workerTelemetry.snapshot(),
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
            telemetry: workerTelemetry.snapshot(),
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      });
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