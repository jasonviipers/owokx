import { generateId, hashObject, nowISO } from "../../../lib/utils";
import type { D1Client, DecisionTraceRow } from "../client";

export interface CreateDecisionParams {
  source: string;
  kind: string;
  model: string;
  temperature: number;
  input: unknown;
  output: unknown;
}

export type DecisionTraceStatus = "success" | "blocked" | "error" | "fallback";

export interface CreateDecisionTraceParams {
  trace_id?: string;
  parent_trace_id?: string | null;
  request_id?: string | null;
  source: string;
  stage: string;
  decision_kind: string;
  model_provider?: string | null;
  model_name?: string | null;
  input: unknown;
  output?: unknown;
  policy?: unknown;
  final_action: string;
  status?: DecisionTraceStatus;
  error_code?: string | null;
  error_message?: string | null;
  symbol?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DecisionTrace {
  id: string;
  trace_id: string;
  parent_trace_id: string | null;
  request_id: string | null;
  source: string;
  stage: string;
  decision_kind: string;
  model_provider: string | null;
  model_name: string | null;
  input_hash: string;
  input: unknown;
  output: unknown | null;
  policy: unknown | null;
  final_action: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  symbol: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function parseJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function mapDecisionTraceRow(row: DecisionTraceRow): DecisionTrace {
  return {
    id: row.id,
    trace_id: row.trace_id,
    parent_trace_id: row.parent_trace_id,
    request_id: row.request_id,
    source: row.source,
    stage: row.stage,
    decision_kind: row.decision_kind,
    model_provider: row.model_provider,
    model_name: row.model_name,
    input_hash: row.input_hash,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    policy: parseJson(row.policy_json),
    final_action: row.final_action,
    status: row.status,
    error_code: row.error_code,
    error_message: row.error_message,
    symbol: row.symbol,
    metadata: parseMetadata(row.metadata_json),
    created_at: row.created_at,
  };
}

export async function createDecision(db: D1Client, params: CreateDecisionParams): Promise<string> {
  const id = generateId();
  const createdAt = nowISO();
  const inputJson = JSON.stringify(params.input);
  const outputJson = JSON.stringify(params.output);
  const inputHash = hashObject({ inputJson, model: params.model, temperature: params.temperature, kind: params.kind });

  await db.run(
    `INSERT INTO agent_decisions (id, source, kind, model, temperature, input_hash, input_json, output_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.source, params.kind, params.model, params.temperature, inputHash, inputJson, outputJson, createdAt]
  );

  return id;
}

export async function createDecisionTrace(db: D1Client, params: CreateDecisionTraceParams): Promise<string> {
  const id = generateId();
  const traceId = params.trace_id ?? id;
  const createdAt = nowISO();
  const inputJson = JSON.stringify(params.input ?? {});
  const outputJson = params.output === undefined ? null : JSON.stringify(params.output);
  const policyJson = params.policy === undefined ? null : JSON.stringify(params.policy);
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  const inputHash = hashObject(params.input ?? {});

  await db.run(
    `INSERT INTO decision_traces (
        id, trace_id, parent_trace_id, request_id, source, stage, decision_kind, model_provider, model_name,
        input_hash, input_json, output_json, policy_json, final_action, status, error_code, error_message,
        symbol, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      traceId,
      params.parent_trace_id ?? null,
      params.request_id ?? null,
      params.source,
      params.stage,
      params.decision_kind,
      params.model_provider ?? null,
      params.model_name ?? null,
      inputHash,
      inputJson,
      outputJson,
      policyJson,
      params.final_action,
      params.status ?? "success",
      params.error_code ?? null,
      params.error_message ?? null,
      params.symbol ?? null,
      metadataJson,
      createdAt,
    ]
  );

  return id;
}

export interface ListDecisionTraceParams {
  trace_id?: string;
  request_id?: string;
  source?: string;
  stage?: string;
  symbol?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listDecisionTraces(db: D1Client, params: ListDecisionTraceParams = {}): Promise<DecisionTrace[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.trace_id) {
    clauses.push("trace_id = ?");
    values.push(params.trace_id);
  }
  if (params.request_id) {
    clauses.push("request_id = ?");
    values.push(params.request_id);
  }
  if (params.source) {
    clauses.push("source = ?");
    values.push(params.source);
  }
  if (params.stage) {
    clauses.push("stage = ?");
    values.push(params.stage);
  }
  if (params.symbol) {
    clauses.push("symbol = ?");
    values.push(params.symbol);
  }
  if (params.status) {
    clauses.push("status = ?");
    values.push(params.status);
  }

  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const offset = Math.max(0, params.offset ?? 0);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = await db.execute<DecisionTraceRow>(
    `SELECT * FROM decision_traces ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return rows.map(mapDecisionTraceRow);
}

export async function getDecisionTraceById(db: D1Client, id: string): Promise<DecisionTrace | null> {
  const row = await db.executeOne<DecisionTraceRow>(`SELECT * FROM decision_traces WHERE id = ?`, [id]);
  return row ? mapDecisionTraceRow(row) : null;
}
