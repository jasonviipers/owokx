#!/usr/bin/env node

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function normalizeUrl(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required argument: --${label}`);
  }
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function toBoolean(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isAbortLikeError(error) {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return typeof error.message === "string" && error.message.toLowerCase().includes("aborted");
}

async function checkEndpoint(input) {
  const startedAt = Date.now();
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let bodyText = "";
  let error = null;

  try {
    response = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      redirect: "follow",
      signal,
    });
    bodyText = await response.text();
  } catch (fetchError) {
    if (isAbortLikeError(fetchError)) {
      error = `Request timed out after ${timeoutMs}ms`;
    } else {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    }
  }

  const durationMs = Date.now() - startedAt;
  const status = response?.status ?? 0;
  const statusAllowed = input.allowedStatuses.includes(status);
  const bodyAllowed = input.validateBody ? input.validateBody(bodyText) : true;
  const ok = !error && statusAllowed && bodyAllowed;

  return {
    name: input.name,
    method: "GET",
    url: input.url,
    status,
    allowed_statuses: input.allowedStatuses,
    duration_ms: durationMs,
    ok,
    error,
    body_preview: bodyText.slice(0, 200),
  };
}

function printResult(result) {
  const symbol = result.ok ? "PASS" : "FAIL";
  const statusPart = result.status ? String(result.status) : "ERR";
  const durationPart = `${result.duration_ms}ms`;
  process.stdout.write(`${symbol.padEnd(4)} | ${result.name.padEnd(28)} | ${statusPart.padEnd(3)} | ${durationPart}\n`);
  if (!result.ok && result.error) {
    process.stdout.write(`       error: ${result.error}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skipWorker = toBoolean(args["skip-worker"]);
  const skipDashboard = toBoolean(args["skip-dashboard"]);

  const workerUrlBase = skipWorker ? null : normalizeUrl(args["worker-url"], "worker-url");
  const dashboardUrlBase = skipDashboard ? null : normalizeUrl(args["dashboard-url"], "dashboard-url");
  const token = typeof args.token === "string" && args.token.trim().length > 0 ? args.token.trim() : null;
  const strictAuth = toBoolean(args["strict-auth"]);
  const jsonOutput = typeof args["json-output"] === "string" ? args["json-output"] : null;

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const checks = [];

  if (!skipWorker && workerUrlBase) {
    checks.push({
      name: "worker_health",
      url: `${workerUrlBase}/health`,
      allowedStatuses: [200],
      headers: {},
      validateBody: (body) => body.includes("ok"),
    });
  }

  if (!skipDashboard && dashboardUrlBase) {
    checks.push(
      {
        name: "dashboard_health",
        url: `${dashboardUrlBase}/health`,
        allowedStatuses: [200],
        headers: {},
        validateBody: (body) => body.toLowerCase().includes("ok"),
      },
      {
        name: "dashboard_api_status_route",
        url: `${dashboardUrlBase}/api/status`,
        allowedStatuses: strictAuth ? [200] : [200, 401],
        headers: authHeaders,
      },
      {
        name: "dashboard_api_swarm_health_route",
        url: `${dashboardUrlBase}/api/swarm/health`,
        allowedStatuses: strictAuth ? [200] : [200, 401],
        headers: authHeaders,
      },
      {
        name: "dashboard_auth_route",
        url: `${dashboardUrlBase}/auth/session`,
        allowedStatuses: [404, 405, 400, 401],
        headers: authHeaders,
      }
    );
  }

  if (!skipWorker && workerUrlBase && token) {
    checks.push({
      name: "worker_agent_status_authenticated",
      url: `${workerUrlBase}/agent/status`,
      allowedStatuses: [200],
      headers: authHeaders,
    });
  }

  process.stdout.write("Deployment verification checks\n");
  process.stdout.write("---- | ---------------------------- | --- | -------\n");
  const results = [];
  for (const check of checks) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkEndpoint(check);
    results.push(result);
    printResult(result);
  }

  const failed = results.filter((result) => !result.ok);
  const summary = {
    created_at: new Date().toISOString(),
    worker_url: workerUrlBase,
    dashboard_url: dashboardUrlBase,
    skip_worker: skipWorker,
    skip_dashboard: skipDashboard,
    strict_auth: strictAuth,
    checks: results,
    passed: failed.length === 0,
    failed_checks: failed.map((result) => result.name),
  };

  if (jsonOutput) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(jsonOutput, JSON.stringify(summary, null, 2), "utf8");
  }

  if (failed.length > 0) {
    process.stderr.write(`Verification failed: ${failed.length} check(s) failed.\n`);
    process.exit(1);
  }

  process.stdout.write("Verification passed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
