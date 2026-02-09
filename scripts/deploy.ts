#!/usr/bin/env npx tsx

type DeployEnvironment = "staging" | "production";
type DeployComponents = "all" | "worker" | "dashboard";

type WorkflowDispatchInputs = {
  environment: DeployEnvironment;
  components: DeployComponents;
};

function parseArgValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ghFetch<T>(path: string, options: RequestInit & { token: string }): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${body || res.statusText}`);
  }

  return (await res.json()) as T;
}

async function runLocal(cmd: string): Promise<string> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

async function resolveRepo(): Promise<{ owner: string; repo: string; ref: string; sha: string }> {
  const repoEnv = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA || (await runLocal("git rev-parse HEAD"));
  const ref = (await runLocal("git rev-parse --abbrev-ref HEAD")).trim();

  if (repoEnv) {
    const [owner, repo] = repoEnv.split("/");
    if (owner && repo) return { owner, repo, ref, sha };
  }

  const remote = await runLocal("git config --get remote.origin.url");
  const match = remote.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(\.git)?$/);
  const owner = match?.groups?.owner;
  const repo = match?.groups?.repo;
  if (!owner || !repo) throw new Error("Unable to resolve GitHub repository (set GITHUB_REPOSITORY=owner/repo)");
  return { owner, repo, ref, sha };
}

async function dispatchWorkflow(params: {
  token: string;
  owner: string;
  repo: string;
  workflowFile: string;
  ref: string;
  inputs: WorkflowDispatchInputs;
}): Promise<void> {
  await ghFetch(`/repos/${params.owner}/${params.repo}/actions/workflows/${params.workflowFile}/dispatches`, {
    token: params.token,
    method: "POST",
    body: JSON.stringify({ ref: params.ref, inputs: params.inputs }),
  });
}

type WorkflowRunsResponse = {
  workflow_runs: Array<{
    id: number;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "action_required" | "stale" | null;
    head_sha: string;
    created_at: string;
    html_url: string;
  }>;
};

type JobsResponse = {
  jobs: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    steps: Array<{ name: string; status: string; conclusion: string | null }>;
  }>;
};

async function waitForRun(params: {
  token: string;
  owner: string;
  repo: string;
  workflowFile: string;
  sha: string;
  maxWaitMs: number;
}): Promise<{ id: number; html_url: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.maxWaitMs) {
    const res = await ghFetch<WorkflowRunsResponse>(
      `/repos/${params.owner}/${params.repo}/actions/workflows/${params.workflowFile}/runs?event=workflow_dispatch&per_page=20`,
      { token: params.token, method: "GET" }
    );
    const match = res.workflow_runs.find((r) => r.head_sha === params.sha);
    if (match) return { id: match.id, html_url: match.html_url };
    await sleep(3000);
  }
  throw new Error("Timed out waiting for workflow run to start");
}

async function monitorRun(params: {
  token: string;
  owner: string;
  repo: string;
  runId: number;
  pollMs: number;
}): Promise<"success" | "failure" | "cancelled" | "timed_out" | "unknown"> {
  type RunResponse = {
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
    html_url: string;
  };

  let lastSummary = "";
  while (true) {
    const run = await ghFetch<{ workflow_run: RunResponse }>(
      `/repos/${params.owner}/${params.repo}/actions/runs/${params.runId}`,
      { token: params.token, method: "GET" }
    );

    const jobs = await ghFetch<JobsResponse>(
      `/repos/${params.owner}/${params.repo}/actions/runs/${params.runId}/jobs?per_page=50`,
      { token: params.token, method: "GET" }
    );

    const summary = jobs.jobs
      .map((j) => {
        const activeStep = j.steps.find((s) => s.status === "in_progress")?.name;
        const doneSteps = j.steps.filter((s) => s.status === "completed").length;
        const totalSteps = j.steps.length;
        const stepInfo = activeStep ? ` (${activeStep})` : "";
        return `${j.name}: ${j.status}${stepInfo} [${doneSteps}/${totalSteps}]`;
      })
      .join("\n");

    if (summary !== lastSummary) {
      process.stdout.write(`\n${summary}\n`);
      lastSummary = summary;
    }

    if (run.workflow_run.status === "completed") {
      const c = run.workflow_run.conclusion;
      if (c === "success" || c === "failure" || c === "cancelled" || c === "timed_out") return c;
      return "unknown";
    }

    await sleep(params.pollMs);
  }
}

async function main() {
  const args = process.argv.slice(2);

  const environment = (parseArgValue(args, "--env") || "staging") as DeployEnvironment;
  const components = (parseArgValue(args, "--components") || "all") as DeployComponents;
  const refOverride = parseArgValue(args, "--ref");
  const repoOverride = parseArgValue(args, "--repo");
  const quiet = hasFlag(args, "--quiet");

  if (environment !== "staging" && environment !== "production") {
    throw new Error(`Invalid --env: ${environment}`);
  }
  if (components !== "all" && components !== "worker" && components !== "dashboard") {
    throw new Error(`Invalid --components: ${components}`);
  }

  const token = requiredEnv("GITHUB_TOKEN");
  const { owner: detectedOwner, repo: detectedRepo, ref: detectedRef, sha } = await resolveRepo();
  const [owner, repo] = repoOverride ? repoOverride.split("/") : [detectedOwner, detectedRepo];
  if (!owner || !repo) throw new Error("Invalid --repo (expected owner/repo)");
  const ref = refOverride || detectedRef;

  const workflowFile = "deploy-oneclick.yml";
  const inputs: WorkflowDispatchInputs = { environment, components };

  if (!quiet) {
    process.stdout.write(`Repo: ${owner}/${repo}\n`);
    process.stdout.write(`Ref: ${ref}\n`);
    process.stdout.write(`SHA: ${sha}\n`);
    process.stdout.write(`Workflow: ${workflowFile}\n`);
    process.stdout.write(`Inputs: ${JSON.stringify(inputs)}\n`);
  }

  await dispatchWorkflow({ token, owner, repo, workflowFile, ref, inputs });
  if (!quiet) process.stdout.write("Dispatched workflow. Waiting for run...\n");

  const run = await waitForRun({ token, owner, repo, workflowFile, sha, maxWaitMs: 120_000 });
  process.stdout.write(`Run: ${run.html_url}\n`);

  const conclusion = await monitorRun({ token, owner, repo, runId: run.id, pollMs: 5000 });
  if (conclusion === "success") process.exit(0);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
