import { generateId, nowISO } from "../../../lib/utils";
import type { D1Client, ExperimentMetricRow, ExperimentRunRow, ExperimentVariantRow } from "../client";

export interface ExperimentVariant {
  id: string;
  strategy_name: string;
  variant_name: string;
  params: Record<string, unknown>;
  status: string;
  is_champion: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExperimentRun {
  id: string;
  strategy_name: string;
  variant_id: string | null;
  seed: number | null;
  status: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  summary_artifact_key: string | null;
  equity_artifact_key: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentMetric {
  id: string;
  run_id: string;
  metric_name: string;
  metric_value: number;
  step: number | null;
  tags: Record<string, unknown> | null;
  recorded_at: string;
}

export interface CreateExperimentVariantParams {
  id?: string;
  strategy_name: string;
  variant_name: string;
  params: Record<string, unknown>;
  status?: string;
  is_champion?: boolean;
}

export interface CreateExperimentRunParams {
  id?: string;
  strategy_name: string;
  variant_id?: string | null;
  seed?: number | null;
  status?: string;
  config?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  summary_artifact_key?: string | null;
  equity_artifact_key?: string | null;
  started_at?: string;
  finished_at?: string | null;
}

export interface UpdateExperimentRunParams {
  status?: string;
  summary?: Record<string, unknown> | null;
  summary_artifact_key?: string | null;
  equity_artifact_key?: string | null;
  finished_at?: string | null;
}

export interface CreateExperimentMetricParams {
  id?: string;
  run_id: string;
  metric_name: string;
  metric_value: number;
  step?: number | null;
  tags?: Record<string, unknown> | null;
  recorded_at?: string;
}

function parseJsonObject(raw: string | null, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function mapVariantRow(row: ExperimentVariantRow): ExperimentVariant {
  return {
    id: row.id,
    strategy_name: row.strategy_name,
    variant_name: row.variant_name,
    params: parseJsonObject(row.params_json),
    status: row.status,
    is_champion: row.is_champion === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRunRow(row: ExperimentRunRow): ExperimentRun {
  return {
    id: row.id,
    strategy_name: row.strategy_name,
    variant_id: row.variant_id,
    seed: row.seed,
    status: row.status,
    config: parseJsonObject(row.config_json),
    summary: row.summary_json ? parseJsonObject(row.summary_json) : null,
    summary_artifact_key: row.summary_artifact_key,
    equity_artifact_key: row.equity_artifact_key,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapMetricRow(row: ExperimentMetricRow): ExperimentMetric {
  return {
    id: row.id,
    run_id: row.run_id,
    metric_name: row.metric_name,
    metric_value: row.metric_value,
    step: row.step,
    tags: row.tags_json ? parseJsonObject(row.tags_json) : null,
    recorded_at: row.recorded_at,
  };
}

export async function upsertExperimentVariant(
  db: D1Client,
  params: CreateExperimentVariantParams
): Promise<ExperimentVariant> {
  const id = params.id ?? generateId();
  const now = nowISO();
  await db.run(
    `INSERT INTO experiment_variants (
        id, strategy_name, variant_name, params_json, status, is_champion, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_name, variant_name) DO UPDATE SET
        params_json = excluded.params_json,
        status = excluded.status,
        is_champion = excluded.is_champion,
        updated_at = excluded.updated_at`,
    [
      id,
      params.strategy_name,
      params.variant_name,
      JSON.stringify(params.params),
      params.status ?? "active",
      params.is_champion ? 1 : 0,
      now,
      now,
    ]
  );

  const row = await db.executeOne<ExperimentVariantRow>(
    `SELECT * FROM experiment_variants WHERE strategy_name = ? AND variant_name = ?`,
    [params.strategy_name, params.variant_name]
  );
  if (!row) {
    throw new Error("Failed to load experiment variant after upsert");
  }
  return mapVariantRow(row);
}

export async function setExperimentChampionVariant(
  db: D1Client,
  strategy_name: string,
  variant_id: string
): Promise<void> {
  const now = nowISO();
  await db.run(`UPDATE experiment_variants SET is_champion = 0, updated_at = ? WHERE strategy_name = ?`, [
    now,
    strategy_name,
  ]);
  await db.run(`UPDATE experiment_variants SET is_champion = 1, updated_at = ? WHERE id = ? AND strategy_name = ?`, [
    now,
    variant_id,
    strategy_name,
  ]);
}

export async function listExperimentVariants(
  db: D1Client,
  params: { strategy_name?: string; limit?: number; offset?: number } = {}
): Promise<ExperimentVariant[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
  const offset = Math.max(0, params.offset ?? 0);

  if (params.strategy_name) {
    const rows = await db.execute<ExperimentVariantRow>(
      `SELECT * FROM experiment_variants
       WHERE strategy_name = ?
       ORDER BY is_champion DESC, updated_at DESC
       LIMIT ? OFFSET ?`,
      [params.strategy_name, limit, offset]
    );
    return rows.map(mapVariantRow);
  }

  const rows = await db.execute<ExperimentVariantRow>(
    `SELECT * FROM experiment_variants
     ORDER BY strategy_name ASC, is_champion DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows.map(mapVariantRow);
}

export async function createExperimentRun(db: D1Client, params: CreateExperimentRunParams): Promise<string> {
  const id = params.id ?? generateId();
  const now = nowISO();
  const startedAt = params.started_at ?? now;

  await db.run(
    `INSERT INTO experiment_runs (
        id, strategy_name, variant_id, seed, status, config_json, summary_json, summary_artifact_key, equity_artifact_key,
        started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.strategy_name,
      params.variant_id ?? null,
      params.seed ?? null,
      params.status ?? "running",
      JSON.stringify(params.config ?? {}),
      params.summary ? JSON.stringify(params.summary) : null,
      params.summary_artifact_key ?? null,
      params.equity_artifact_key ?? null,
      startedAt,
      params.finished_at ?? null,
      now,
      now,
    ]
  );

  return id;
}

export async function updateExperimentRun(
  db: D1Client,
  runId: string,
  patch: UpdateExperimentRunParams
): Promise<void> {
  const updates: string[] = [];
  const params: unknown[] = [];

  if (patch.status !== undefined) {
    updates.push("status = ?");
    params.push(patch.status);
  }
  if (patch.summary !== undefined) {
    updates.push("summary_json = ?");
    params.push(patch.summary ? JSON.stringify(patch.summary) : null);
  }
  if (patch.summary_artifact_key !== undefined) {
    updates.push("summary_artifact_key = ?");
    params.push(patch.summary_artifact_key);
  }
  if (patch.equity_artifact_key !== undefined) {
    updates.push("equity_artifact_key = ?");
    params.push(patch.equity_artifact_key);
  }
  if (patch.finished_at !== undefined) {
    updates.push("finished_at = ?");
    params.push(patch.finished_at);
  }

  if (updates.length === 0) return;

  updates.push("updated_at = ?");
  params.push(nowISO(), runId);
  await db.run(`UPDATE experiment_runs SET ${updates.join(", ")} WHERE id = ?`, params);
}

export async function getExperimentRunById(db: D1Client, runId: string): Promise<ExperimentRun | null> {
  const row = await db.executeOne<ExperimentRunRow>(`SELECT * FROM experiment_runs WHERE id = ?`, [runId]);
  return row ? mapRunRow(row) : null;
}

export async function listExperimentRuns(
  db: D1Client,
  params: {
    strategy_name?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<ExperimentRun[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.strategy_name) {
    clauses.push("strategy_name = ?");
    values.push(params.strategy_name);
  }
  if (params.date_from) {
    clauses.push("started_at >= ?");
    values.push(params.date_from);
  }
  if (params.date_to) {
    clauses.push("started_at <= ?");
    values.push(params.date_to);
  }

  const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
  const offset = Math.max(0, params.offset ?? 0);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = await db.execute<ExperimentRunRow>(
    `SELECT * FROM experiment_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );
  return rows.map(mapRunRow);
}

export async function createExperimentMetric(db: D1Client, params: CreateExperimentMetricParams): Promise<string> {
  const id = params.id ?? generateId();
  await db.run(
    `INSERT INTO experiment_metrics (
        id, run_id, metric_name, metric_value, step, tags_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.run_id,
      params.metric_name,
      params.metric_value,
      params.step ?? null,
      params.tags ? JSON.stringify(params.tags) : null,
      params.recorded_at ?? nowISO(),
    ]
  );
  return id;
}

export async function createExperimentMetricsBatch(
  db: D1Client,
  metrics: CreateExperimentMetricParams[]
): Promise<void> {
  for (const metric of metrics) {
    await createExperimentMetric(db, metric);
  }
}

export async function listExperimentMetrics(
  db: D1Client,
  params: { run_id: string; metric_name?: string; limit?: number }
): Promise<ExperimentMetric[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 1000, 5000));
  if (params.metric_name) {
    const rows = await db.execute<ExperimentMetricRow>(
      `SELECT * FROM experiment_metrics
       WHERE run_id = ? AND metric_name = ?
       ORDER BY COALESCE(step, 0) ASC, recorded_at ASC
       LIMIT ?`,
      [params.run_id, params.metric_name, limit]
    );
    return rows.map(mapMetricRow);
  }

  const rows = await db.execute<ExperimentMetricRow>(
    `SELECT * FROM experiment_metrics
     WHERE run_id = ?
     ORDER BY COALESCE(step, 0) ASC, recorded_at ASC
     LIMIT ?`,
    [params.run_id, limit]
  );
  return rows.map(mapMetricRow);
}
