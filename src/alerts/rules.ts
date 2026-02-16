export type AlertSeverity = "info" | "warning" | "critical";
export type AlertRuleId = "portfolio_drawdown" | "kill_switch_active" | "swarm_dead_letter_queue" | "llm_auth_failure";

export interface AlertEvent {
  id: string;
  rule: AlertRuleId;
  severity: AlertSeverity;
  title: string;
  message: string;
  fingerprint: string;
  occurred_at: string;
  details: Record<string, unknown>;
}

export interface AlertRuleThresholds {
  drawdownWarnRatio: number;
  deadLetterWarn: number;
  deadLetterCritical: number;
  llmAuthFailureWindowMs: number;
}

interface AlertRuleInput {
  environment: string;
  nowMs?: number;
  account?: {
    equity: number;
  } | null;
  riskState?: {
    kill_switch_active: boolean;
    kill_switch_reason: string | null;
    kill_switch_at: string | null;
    daily_equity_start: number | null;
    max_portfolio_drawdown_pct: number;
  } | null;
  policyConfig?: {
    max_portfolio_drawdown_pct: number;
  } | null;
  swarm?: {
    deadLettered?: number;
    queued?: number;
    staleAgents?: number;
  } | null;
  llm?: {
    last_auth_error?: {
      at?: number;
      message?: string;
    } | null;
  } | null;
  thresholds?: Partial<AlertRuleThresholds>;
}

const DEFAULT_THRESHOLDS: AlertRuleThresholds = {
  drawdownWarnRatio: 0.8,
  deadLetterWarn: 1,
  deadLetterCritical: 10,
  llmAuthFailureWindowMs: 15 * 60_000,
};
const DEFAULT_DRAWDOWN_LIMIT = 0.15;

/**
 * Restricts a number to lie within the inclusive range defined by `min` and `max`.
 *
 * @param value - The number to clamp
 * @param min - The lower bound of the range
 * @param max - The upper bound of the range
 * @returns The input value limited to the interval `[min, max]`
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge provided threshold overrides with defaults and normalize each field to safe, validated values.
 *
 * @param overrides - Optional partial thresholds to override the defaults
 * @returns The normalized thresholds:
 * - `drawdownWarnRatio` clamped to the range 0.1–1
 * - `deadLetterWarn` and `deadLetterCritical` floored to integers and constrained to be >= 0
 * - `llmAuthFailureWindowMs` floored to an integer and constrained to be at least 60,000 (1 minute)
 */
function normalizeThresholds(overrides?: Partial<AlertRuleThresholds>): AlertRuleThresholds {
  const merged = {
    ...DEFAULT_THRESHOLDS,
    ...(overrides ?? {}),
  };

  return {
    drawdownWarnRatio: clamp(merged.drawdownWarnRatio, 0.1, 1),
    deadLetterWarn: Math.max(0, Math.floor(merged.deadLetterWarn)),
    deadLetterCritical: Math.max(0, Math.floor(merged.deadLetterCritical)),
    llmAuthFailureWindowMs: Math.max(60_000, Math.floor(merged.llmAuthFailureWindowMs)),
  };
}

/**
 * Format a millisecond timestamp as an ISO 8601 string.
 *
 * @param nowMs - Milliseconds since the Unix epoch
 * @returns The UTC ISO 8601 representation of `nowMs`
 */
function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * Produces a normalized fingerprint segment safe for use in alert IDs.
 *
 * Converts the input to lowercase, replaces runs of non-alphanumeric characters with single hyphens, trims leading/trailing hyphens, and truncates the result to at most 96 characters.
 *
 * @param value - The input string to normalize into a fingerprint part
 * @returns A lowercase string containing only letters, digits, and hyphens, trimmed of edge hyphens and limited to 96 characters (may be empty)
 */
function normalizeFingerprintPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

/**
 * Constructs an AlertEvent object from the provided fields and timestamp.
 *
 * @param nowMs - Timestamp (milliseconds since epoch) used to build the alert `id` and `occurred_at`
 * @param rule - Alert rule identifier
 * @param severity - Alert severity level
 * @param title - Short, human-facing title for the alert
 * @param message - Detailed human-facing message for the alert
 * @param fingerprint - Normalized fingerprint segment used to group/deduplicate alerts
 * @param details - Arbitrary structured metadata to include with the alert
 * @returns The assembled AlertEvent with `id` formatted as `"<rule>:<nowMs>:<severity>"` and `occurred_at` set to the ISO timestamp for `nowMs`
 */
function createAlert(
  nowMs: number,
  rule: AlertRuleId,
  severity: AlertSeverity,
  title: string,
  message: string,
  fingerprint: string,
  details: Record<string, unknown>
): AlertEvent {
  return {
    id: `${rule}:${nowMs}:${severity}`,
    rule,
    severity,
    title,
    message,
    fingerprint,
    occurred_at: nowIso(nowMs),
    details,
  };
}

/**
 * Evaluate alerting rules against the provided environment, account, and service state and produce any triggered alerts.
 *
 * @param input - Evaluation context containing environment, timing, account, risk state, policy config, swarm and LLM status, and optional threshold overrides
 * @returns An array of AlertEvent objects for each alert triggered by the input state (e.g., portfolio drawdown, kill switch activation, swarm dead-letter queue thresholds, recent LLM auth failures)
 */
export function evaluateAlertRules(input: AlertRuleInput): AlertEvent[] {
  const nowMs = input.nowMs ?? Date.now();
  const thresholds = normalizeThresholds(input.thresholds);
  const alerts: AlertEvent[] = [];

  const riskState = input.riskState ?? null;
  const account = input.account ?? null;
  const drawdownLimit =
    riskState?.max_portfolio_drawdown_pct ?? input.policyConfig?.max_portfolio_drawdown_pct ?? DEFAULT_DRAWDOWN_LIMIT;

  if (
    account &&
    Number.isFinite(account.equity) &&
    riskState &&
    Number.isFinite(riskState.daily_equity_start) &&
    (riskState.daily_equity_start ?? 0) > 0 &&
    Number.isFinite(drawdownLimit) &&
    drawdownLimit > 0
  ) {
    const baseline = riskState.daily_equity_start ?? 0;
    const drawdownPct = Math.max(0, (baseline - account.equity) / baseline);
    const warnThreshold = drawdownLimit * thresholds.drawdownWarnRatio;

    if (drawdownPct >= drawdownLimit) {
      alerts.push(
        createAlert(
          nowMs,
          "portfolio_drawdown",
          "critical",
          "Portfolio drawdown limit breached",
          `Drawdown ${(drawdownPct * 100).toFixed(2)}% exceeded limit ${(drawdownLimit * 100).toFixed(2)}%`,
          "portfolio_drawdown:critical",
          {
            environment: input.environment,
            drawdown_pct: drawdownPct,
            drawdown_limit_pct: drawdownLimit,
            equity: account.equity,
            baseline_equity: baseline,
          }
        )
      );
    } else if (drawdownPct >= warnThreshold) {
      alerts.push(
        createAlert(
          nowMs,
          "portfolio_drawdown",
          "warning",
          "Portfolio drawdown approaching limit",
          `Drawdown ${(drawdownPct * 100).toFixed(2)}% is approaching limit ${(drawdownLimit * 100).toFixed(2)}%`,
          "portfolio_drawdown:warning",
          {
            environment: input.environment,
            drawdown_pct: drawdownPct,
            warn_threshold_pct: warnThreshold,
            drawdown_limit_pct: drawdownLimit,
            equity: account.equity,
            baseline_equity: baseline,
          }
        )
      );
    }
  }

  if (riskState?.kill_switch_active) {
    const reason =
      typeof riskState.kill_switch_reason === "string" && riskState.kill_switch_reason.trim().length > 0
        ? riskState.kill_switch_reason.trim()
        : "No reason provided";

    alerts.push(
      createAlert(
        nowMs,
        "kill_switch_active",
        "critical",
        "Kill switch is active",
        `Trading is halted. Reason: ${reason}`,
        `kill_switch_active:${normalizeFingerprintPart(reason) || "active"}`,
        {
          environment: input.environment,
          kill_switch_reason: reason,
          kill_switch_at: riskState.kill_switch_at,
        }
      )
    );
  }

  const deadLettered = Number.isFinite(input.swarm?.deadLettered) ? Number(input.swarm?.deadLettered) : 0;
  if (deadLettered >= thresholds.deadLetterCritical) {
    alerts.push(
      createAlert(
        nowMs,
        "swarm_dead_letter_queue",
        "critical",
        "Swarm dead-letter queue is critical",
        `Dead-letter queue depth ${deadLettered} exceeded critical threshold ${thresholds.deadLetterCritical}`,
        "swarm_dead_letter_queue:critical",
        {
          environment: input.environment,
          dead_lettered: deadLettered,
          queued: input.swarm?.queued ?? 0,
          stale_agents: input.swarm?.staleAgents ?? 0,
          warn_threshold: thresholds.deadLetterWarn,
          critical_threshold: thresholds.deadLetterCritical,
        }
      )
    );
  } else if (deadLettered >= thresholds.deadLetterWarn) {
    alerts.push(
      createAlert(
        nowMs,
        "swarm_dead_letter_queue",
        "warning",
        "Swarm dead-letter queue has pending failures",
        `Dead-letter queue depth ${deadLettered} exceeded warning threshold ${thresholds.deadLetterWarn}`,
        "swarm_dead_letter_queue:warning",
        {
          environment: input.environment,
          dead_lettered: deadLettered,
          queued: input.swarm?.queued ?? 0,
          stale_agents: input.swarm?.staleAgents ?? 0,
          warn_threshold: thresholds.deadLetterWarn,
          critical_threshold: thresholds.deadLetterCritical,
        }
      )
    );
  }

  const llmAuthError = input.llm?.last_auth_error ?? null;
  if (llmAuthError && typeof llmAuthError === "object") {
    const at = Number.isFinite(llmAuthError.at) ? Number(llmAuthError.at) : null;
    const message =
      typeof llmAuthError.message === "string" && llmAuthError.message.trim().length > 0
        ? llmAuthError.message.trim()
        : "Unknown LLM auth error";
    const ageMs = at === null ? 0 : Math.max(0, nowMs - at);
    const withinWindow = at === null || ageMs <= thresholds.llmAuthFailureWindowMs;

    if (withinWindow) {
      alerts.push(
        createAlert(
          nowMs,
          "llm_auth_failure",
          "warning",
          "LLM authentication failure detected",
          `Recent LLM auth failure: ${message}`,
          "llm_auth_failure:warning",
          {
            environment: input.environment,
            last_auth_error_at_ms: at,
            age_ms: ageMs,
            window_ms: thresholds.llmAuthFailureWindowMs,
            message,
          }
        )
      );
    }
  }

  return alerts;
}
