import type { AlertRuleId, AlertSeverity } from "../../../alerts/rules";
import { generateId, nowISO } from "../../../lib/utils";
import type { AlertEventRow, AlertRuleRow, D1Client } from "../client";

const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

type AlertSeverityValue = AlertSeverity;

export interface AlertRule {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  default_severity: AlertSeverityValue;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  severity: AlertSeverityValue;
  title: string;
  message: string;
  fingerprint: string;
  details: Record<string, unknown>;
  occurred_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

export interface UpsertAlertRuleParams {
  id?: string;
  title: string;
  description?: string;
  enabled?: boolean;
  default_severity?: AlertSeverityValue;
  config?: Record<string, unknown>;
}

export interface CreateAlertEventParams {
  id?: string;
  rule_id: string;
  severity: AlertSeverityValue;
  title: string;
  message: string;
  fingerprint: string;
  details?: Record<string, unknown>;
  occurred_at?: string;
}

export const BUILT_IN_ALERT_RULE_IDS: AlertRuleId[] = [
  "portfolio_drawdown",
  "kill_switch_active",
  "swarm_dead_letter_queue",
  "llm_auth_failure",
];

const DEFAULT_ALERT_RULES: Array<
  Pick<AlertRule, "id" | "title" | "description" | "enabled" | "default_severity" | "config">
> = [
  {
    id: "portfolio_drawdown",
    title: "Portfolio Drawdown",
    description: "Triggers when portfolio drawdown approaches or breaches configured limits.",
    enabled: true,
    default_severity: "warning",
    config: {
      drawdown_warn_ratio: 0.8,
    },
  },
  {
    id: "kill_switch_active",
    title: "Kill Switch Active",
    description: "Triggers when kill switch is enabled and trading is halted.",
    enabled: true,
    default_severity: "critical",
    config: {},
  },
  {
    id: "swarm_dead_letter_queue",
    title: "Swarm Dead Letter Queue",
    description: "Triggers when dead-letter queue depth exceeds warning or critical thresholds.",
    enabled: true,
    default_severity: "warning",
    config: {
      dead_letter_warn: 1,
      dead_letter_critical: 10,
    },
  },
  {
    id: "llm_auth_failure",
    title: "LLM Auth Failure",
    description: "Triggers when recent LLM authentication failures are detected.",
    enabled: true,
    default_severity: "warning",
    config: {
      auth_window_seconds: 900,
    },
  },
];

function parseJsonRecord(raw: string | null, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no-op
  }
  return fallback;
}

function normalizeRuleId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : generateId().slice(0, 12);
}

function normalizeSeverity(value: unknown, fallback: AlertSeverityValue = "warning"): AlertSeverityValue {
  const raw = typeof value === "string" ? value.toLowerCase().trim() : "";
  return SEVERITIES.includes(raw as AlertSeverityValue) ? (raw as AlertSeverityValue) : fallback;
}

function mapAlertRuleRow(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    enabled: row.enabled === 1,
    default_severity: normalizeSeverity(row.default_severity),
    config: parseJsonRecord(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapAlertEventRow(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    rule_id: row.rule_id,
    severity: normalizeSeverity(row.severity),
    title: row.title,
    message: row.message,
    fingerprint: row.fingerprint,
    details: parseJsonRecord(row.details_json),
    occurred_at: row.occurred_at,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    created_at: row.created_at,
  };
}

export async function seedDefaultAlertRules(db: D1Client): Promise<void> {
  const now = nowISO();
  for (const rule of DEFAULT_ALERT_RULES) {
    await db.run(
      `INSERT OR IGNORE INTO alert_rules (
          id, title, description, enabled, default_severity, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.id,
        rule.title,
        rule.description,
        rule.enabled ? 1 : 0,
        rule.default_severity,
        JSON.stringify(rule.config ?? {}),
        now,
        now,
      ]
    );
  }
}

export async function listAlertRules(
  db: D1Client,
  params: { include_disabled?: boolean; limit?: number; offset?: number } = {}
): Promise<AlertRule[]> {
  const includeDisabled = params.include_disabled ?? true;
  const limit = Math.max(1, Math.min(params.limit ?? 200, 500));
  const offset = Math.max(0, params.offset ?? 0);

  const where = includeDisabled ? "" : "WHERE enabled = 1";
  const rows = await db.execute<AlertRuleRow>(
    `SELECT * FROM alert_rules ${where} ORDER BY enabled DESC, id ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows.map(mapAlertRuleRow);
}

export async function getAlertRuleById(db: D1Client, id: string): Promise<AlertRule | null> {
  const row = await db.executeOne<AlertRuleRow>(`SELECT * FROM alert_rules WHERE id = ?`, [id]);
  return row ? mapAlertRuleRow(row) : null;
}

export async function upsertAlertRule(db: D1Client, params: UpsertAlertRuleParams): Promise<AlertRule> {
  const ruleId = normalizeRuleId(params.id ?? params.title);
  const now = nowISO();

  const existing = await getAlertRuleById(db, ruleId);
  const trimmedTitle = params.title.trim();
  if (!trimmedTitle) {
    throw new Error("title is required");
  }
  const title = trimmedTitle.slice(0, 120);
  const description = (params.description ?? existing?.description ?? "").trim().slice(0, 500);
  const enabled = params.enabled ?? existing?.enabled ?? true;
  const defaultSeverity = normalizeSeverity(params.default_severity ?? existing?.default_severity ?? "warning");
  const config = params.config ?? existing?.config ?? {};

  await db.run(
    `INSERT INTO alert_rules (
        id, title, description, enabled, default_severity, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        enabled = excluded.enabled,
        default_severity = excluded.default_severity,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at`,
    [
      ruleId,
      title,
      description,
      enabled ? 1 : 0,
      defaultSeverity,
      JSON.stringify(config),
      existing?.created_at ?? now,
      now,
    ]
  );

  const row = await db.executeOne<AlertRuleRow>(`SELECT * FROM alert_rules WHERE id = ?`, [ruleId]);
  if (!row) {
    throw new Error("Failed to load alert rule after upsert");
  }
  return mapAlertRuleRow(row);
}

export async function deleteAlertRule(db: D1Client, id: string): Promise<void> {
  await db.run(`DELETE FROM alert_rules WHERE id = ?`, [id]);
}

export async function recordAlertEvent(db: D1Client, params: CreateAlertEventParams): Promise<string> {
  const id = params.id ?? generateId();
  const now = nowISO();
  await db.run(
    `INSERT INTO alert_events (
        id, rule_id, severity, title, message, fingerprint, details_json, occurred_at, acknowledged_at, acknowledged_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      normalizeRuleId(params.rule_id),
      normalizeSeverity(params.severity),
      params.title,
      params.message,
      params.fingerprint,
      JSON.stringify(params.details ?? {}),
      params.occurred_at ?? now,
      now,
    ]
  );
  return id;
}

export async function recordAlertEventsBatch(db: D1Client, events: CreateAlertEventParams[]): Promise<void> {
  for (const event of events) {
    await recordAlertEvent(db, event);
  }
}

export interface ListAlertEventsParams {
  rule_id?: string;
  severity?: AlertSeverityValue;
  acknowledged?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export async function listAlertEvents(db: D1Client, params: ListAlertEventsParams = {}): Promise<AlertEvent[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.rule_id) {
    clauses.push("rule_id = ?");
    values.push(normalizeRuleId(params.rule_id));
  }
  if (params.severity) {
    clauses.push("severity = ?");
    values.push(normalizeSeverity(params.severity));
  }
  if (params.acknowledged === true) {
    clauses.push("acknowledged_at IS NOT NULL");
  } else if (params.acknowledged === false) {
    clauses.push("acknowledged_at IS NULL");
  }
  if (params.since) {
    clauses.push("occurred_at >= ?");
    values.push(params.since);
  }
  if (params.until) {
    clauses.push("occurred_at <= ?");
    values.push(params.until);
  }

  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const offset = Math.max(0, params.offset ?? 0);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = await db.execute<AlertEventRow>(
    `SELECT * FROM alert_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return rows.map(mapAlertEventRow);
}

export async function getAlertEventById(db: D1Client, id: string): Promise<AlertEvent | null> {
  const row = await db.executeOne<AlertEventRow>(`SELECT * FROM alert_events WHERE id = ?`, [id]);
  return row ? mapAlertEventRow(row) : null;
}

export async function acknowledgeAlertEvent(
  db: D1Client,
  id: string,
  acknowledgedBy: string | null = null
): Promise<AlertEvent | null> {
  const now = nowISO();
  await db.run(
    `UPDATE alert_events
     SET acknowledged_at = COALESCE(acknowledged_at, ?),
         acknowledged_by = COALESCE(acknowledged_by, ?)
     WHERE id = ?`,
    [now, acknowledgedBy, id]
  );
  return getAlertEventById(db, id);
}

export async function acknowledgeAlertEventsByRule(
  db: D1Client,
  ruleId: string,
  acknowledgedBy: string | null = null
): Promise<number> {
  const now = nowISO();
  const normalizedRuleId = normalizeRuleId(ruleId);
  const result = await db.run(
    `UPDATE alert_events
     SET acknowledged_at = COALESCE(acknowledged_at, ?),
         acknowledged_by = COALESCE(acknowledged_by, ?)
     WHERE rule_id = ? AND acknowledged_at IS NULL`,
    [now, acknowledgedBy, normalizedRuleId]
  );

  const changes = (result.meta as { changes?: number } | undefined)?.changes;
  return Number.isFinite(changes) ? Number(changes) : 0;
}
