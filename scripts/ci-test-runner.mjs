import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const REPORTS_DIR = process.env.CI_REPORTS_DIR || "reports";
const JUNIT_PATH = `${REPORTS_DIR}/junit.xml`;
const FLAKE_REPORT_PATH = `${REPORTS_DIR}/flake-report.json`;
const pnpmCmd = "pnpm";

mkdirSync(REPORTS_DIR, { recursive: true });

function runOnce(args, label) {
  const startedAt = Date.now();
  const result = spawnSync(pnpmCmd, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return {
    label,
    args,
    status: result.status ?? 1,
    duration_ms: Date.now() - startedAt,
    combined_output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function buildTestArgs({ withCoverage }) {
  const args = ["run", "test:run", "--", "--reporter=default", "--reporter=junit", `--outputFile.junit=${JUNIT_PATH}`];
  if (withCoverage) {
    args.push(
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reporter=text",
      "--coverage.reporter=lcov",
      "--coverage.reporter=json-summary"
    );
  }
  return args;
}

function isCoverageProviderFailure(output) {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("failed to load coverage provider") ||
    normalized.includes("@vitest/coverage-v8") ||
    (normalized.includes("coverage") && normalized.includes("provider"))
  );
}

const attempts = [];
let coverageEnabled = true;
let coverageDisabledReason = null;

const firstAttempt = runOnce(buildTestArgs({ withCoverage: true }), "attempt_1");
attempts.push(firstAttempt);

if (firstAttempt.status !== 0 && isCoverageProviderFailure(firstAttempt.combined_output)) {
  coverageEnabled = false;
  coverageDisabledReason = "Coverage provider unavailable in CI runtime; retried without coverage";
  const fallbackAttempt = runOnce(buildTestArgs({ withCoverage: false }), "attempt_1_no_coverage");
  attempts.push(fallbackAttempt);
}

const lastAttempt = attempts[attempts.length - 1];
if (lastAttempt.status !== 0) {
  const retryArgs = buildTestArgs({ withCoverage: coverageEnabled });
  const retryAttempt = runOnce(retryArgs, "attempt_2_retry");
  attempts.push(retryAttempt);
}

const finalAttempt = attempts[attempts.length - 1];
const passed = finalAttempt.status === 0;
const flaky = passed && attempts.length > 1;

writeFileSync(
  FLAKE_REPORT_PATH,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      passed,
      flaky,
      coverage_enabled: coverageEnabled,
      coverage_disabled_reason: coverageDisabledReason,
      attempts: attempts.map((attempt) => ({
        label: attempt.label,
        status: attempt.status,
        duration_ms: attempt.duration_ms,
      })),
    },
    null,
    2
  ),
  "utf8"
);

if (!passed) {
  process.exit(finalAttempt.status || 1);
}
