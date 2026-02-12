#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const defaultBaseUrl = process.env.OWOKX_WORKER_URL ?? "http://127.0.0.1:8787";
  const defaultToken =
    process.env.OWOKX_API_TOKEN_TRADE ??
    process.env.OWOKX_API_TOKEN_ADMIN ??
    process.env.OWOKX_API_TOKEN ??
    "";

  const options = {
    baseUrl: defaultBaseUrl,
    token: defaultToken,
    messages: 1000,
    agents: 5,
    dispatchLimit: 200,
    runs: 3,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--base-url" && next) {
      options.baseUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--token" && next) {
      options.token = next;
      i += 1;
      continue;
    }
    if (arg === "--messages" && next) {
      options.messages = Math.max(1, Number.parseInt(next, 10) || options.messages);
      i += 1;
      continue;
    }
    if (arg === "--agents" && next) {
      options.agents = Math.max(1, Number.parseInt(next, 10) || options.agents);
      i += 1;
      continue;
    }
    if (arg === "--dispatch-limit" && next) {
      options.dispatchLimit = Math.max(1, Number.parseInt(next, 10) || options.dispatchLimit);
      i += 1;
      continue;
    }
    if (arg === "--runs" && next) {
      options.runs = Math.max(1, Number.parseInt(next, 10) || options.runs);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--out" && next) {
      options.out = next;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Swarm benchmark (HTTP)

Usage:
  npm run benchmark:swarm -- [options]

Options:
  --base-url <url>     Worker base URL (default: OWOKX_WORKER_URL or http://127.0.0.1:8787)
  --token <token>      API token (default: OWOKX_API_TOKEN_TRADE/ADMIN/API env)
  --messages <n>       Number of messages to enqueue per run (default: 1000)
  --agents <n>         Number of benchmark analyst agents to register (default: 5)
  --dispatch-limit <n> Dispatch batch size per call (default: 200)
  --runs <n>           Number of benchmark runs (default: 3)
  --json               Print JSON output
  --out <path>         Write JSON output to a file
  -h, --help           Show this help
`);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, current) => sum + current, 0) / values.length;
}

async function apiFetch(options, path, init = {}) {
  const baseHeaders = new Headers(init.headers);
  baseHeaders.set("Authorization", `Bearer ${options.token}`);

  if (init.body && !baseHeaders.has("Content-Type")) {
    baseHeaders.set("Content-Type", "application/json");
  }

  const response = await fetch(`${options.baseUrl}${path}`, {
    ...init,
    headers: baseHeaders,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${path}: ${body}`);
  }

  return await response.json();
}

async function registerBenchmarkAgents(options) {
  for (let i = 0; i < options.agents; i += 1) {
    await apiFetch(options, "/registry/register", {
      method: "POST",
      body: JSON.stringify({
        id: `bench-analyst-${i + 1}`,
        type: "analyst",
        status: "active",
        lastHeartbeat: Date.now(),
        capabilities: ["analyze_signals"],
      }),
    });
  }
}

async function runSingleBenchmark(options, run) {
  await registerBenchmarkAgents(options);

  const baselineQueue = await apiFetch(options, "/swarm/queue", {
    method: "GET",
  });
  const baselineQueued = Number.isFinite(baselineQueue.queued) ? Number(baselineQueue.queued) : 0;

  const enqueueStartedAt = performance.now();
  for (let i = 0; i < options.messages; i += 1) {
    await apiFetch(options, "/registry/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        message: {
          id: `bench-msg-${run}-${i}`,
          source: "benchmark",
          target: "type:analyst",
          type: "COMMAND",
          topic: "analyze_signals",
          payload: {
            signals: [{ symbol: "AAPL", sentiment: 0.8, volume: 100, sources: ["benchmark"] }],
          },
          timestamp: Date.now(),
        },
      }),
    });
  }
  const enqueueMs = performance.now() - enqueueStartedAt;

  const batchDurations = [];
  let delivered = 0;
  let failed = 0;

  const dispatchStartedAt = performance.now();
  const maxIterations = Math.max(20, Math.ceil(options.messages / Math.max(1, options.dispatchLimit)) * 20);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const startedAt = performance.now();
    const dispatch = await apiFetch(options, "/swarm/dispatch", {
      method: "POST",
      body: JSON.stringify({ limit: options.dispatchLimit }),
    });
    batchDurations.push(performance.now() - startedAt);

    delivered += dispatch.delivered;
    failed += dispatch.failed;

    if (delivered >= options.messages && dispatch.pending <= baselineQueued) {
      break;
    }

    if (dispatch.delivered === 0 && dispatch.failed === 0 && dispatch.pending <= baselineQueued) {
      break;
    }

    if (iteration === maxIterations - 1) {
      throw new Error("Benchmark dispatch loop reached max iterations before expected completion");
    }
  }

  const dispatchMs = performance.now() - dispatchStartedAt;
  const totalMs = enqueueMs + dispatchMs;

  const queueAfter = await apiFetch(options, "/swarm/queue", {
    method: "GET",
  });

  const deliveredBounded = Math.min(delivered, options.messages);

  return {
    run,
    baselineQueued,
    enqueueMs,
    dispatchMs,
    totalMs,
    throughputPerSecond: dispatchMs > 0 ? (deliveredBounded * 1000) / dispatchMs : 0,
    delivered: deliveredBounded,
    failed,
    deadLettered: Number.isFinite(queueAfter.deadLettered) ? Number(queueAfter.deadLettered) : 0,
    queuedAfterDispatch: Number.isFinite(queueAfter.queued) ? Number(queueAfter.queued) : 0,
    batchLatencyP50: percentile(batchDurations, 50),
    batchLatencyP95: percentile(batchDurations, 95),
    batchLatencyP99: percentile(batchDurations, 99),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.token) {
    throw new Error(
      "Missing API token. Set OWOKX_API_TOKEN (or _TRADE/_ADMIN) env var, or pass --token <value>."
    );
  }

  const health = await apiFetch(options, "/health", { method: "GET" });
  if (health.status !== "ok") {
    throw new Error(`Unexpected /health response: ${JSON.stringify(health)}`);
  }

  const runs = [];
  for (let run = 1; run <= options.runs; run += 1) {
    runs.push(await runSingleBenchmark(options, run));
  }

  const summary = {
    runs: options.runs,
    messagesPerRun: options.messages,
    agents: options.agents,
    dispatchLimit: options.dispatchLimit,
    avgEnqueueMs: average(runs.map((r) => r.enqueueMs)),
    avgDispatchMs: average(runs.map((r) => r.dispatchMs)),
    avgTotalMs: average(runs.map((r) => r.totalMs)),
    avgThroughputPerSecond: average(runs.map((r) => r.throughputPerSecond)),
    avgBatchLatencyP50: average(runs.map((r) => r.batchLatencyP50)),
    avgBatchLatencyP95: average(runs.map((r) => r.batchLatencyP95)),
    avgBatchLatencyP99: average(runs.map((r) => r.batchLatencyP99)),
    avgBaselineQueued: average(runs.map((r) => r.baselineQueued)),
    avgQueuedAfterDispatch: average(runs.map((r) => r.queuedAfterDispatch)),
    avgDeadLettered: average(runs.map((r) => r.deadLettered)),
  };

  const output = {
    config: {
      baseUrl: options.baseUrl,
      messages: options.messages,
      agents: options.agents,
      dispatchLimit: options.dispatchLimit,
      runs: options.runs,
    },
    summary,
    runs,
    generatedAt: new Date().toISOString(),
  };

  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("Swarm Benchmark (HTTP)");
  console.log(
    `Config: baseUrl=${options.baseUrl} messages=${options.messages} agents=${options.agents} dispatchLimit=${options.dispatchLimit} runs=${options.runs}`
  );

  for (const run of runs) {
    console.log(
      `Run ${run.run}: baselineQueued=${run.baselineQueued} enqueue=${run.enqueueMs.toFixed(2)}ms dispatch=${run.dispatchMs.toFixed(2)}ms throughput=${run.throughputPerSecond.toFixed(2)} msg/s queuedAfter=${run.queuedAfterDispatch}`
    );
  }

  console.log(
    `Average: enqueue=${summary.avgEnqueueMs.toFixed(2)}ms dispatch=${summary.avgDispatchMs.toFixed(2)}ms throughput=${summary.avgThroughputPerSecond.toFixed(2)} msg/s`
  );
  console.log(
    `Batch latency: p50=${summary.avgBatchLatencyP50.toFixed(2)}ms p95=${summary.avgBatchLatencyP95.toFixed(2)}ms p99=${summary.avgBatchLatencyP99.toFixed(2)}ms`
  );
}

void main().catch((error) => {
  console.error(`Benchmark failed: ${String(error)}`);
  process.exit(1);
});
